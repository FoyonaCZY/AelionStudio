import type { AelionProject } from '@aelionsdk/project-schema';
import { describe, expect, it } from 'vitest';

import { planMagneticMove, storylineHoles } from './timeline-layout.js';

const SECOND = 1_000_000;

interface Spec {
  readonly id: string;
  readonly startUs: number;
  readonly durationUs: number;
  readonly linkGroupId?: string;
}

/**
 * Builds the smallest Project the layout solver reads: tracks, their item order
 * and each item's range. Everything else the schema requires is irrelevant here
 * and deliberately omitted.
 */
function project(tracks: Record<string, { kind: string; items: readonly Spec[] }>): AelionProject {
  const items: Record<string, unknown> = {};
  const trackEntities: Record<string, unknown> = {};
  for (const [trackId, track] of Object.entries(tracks)) {
    for (const spec of track.items) {
      items[spec.id] = {
        id: spec.id,
        trackId,
        type: 'video',
        enabled: true,
        range: { startUs: spec.startUs, durationUs: spec.durationUs },
        materialInstanceIds: [],
        ...(spec.linkGroupId === undefined ? {} : { linkGroupId: spec.linkGroupId }),
      };
    }
    trackEntities[trackId] = {
      id: trackId,
      sequenceId: 'sequence',
      kind: track.kind,
      enabled: true,
      locked: false,
      itemIds: track.items.map(spec => spec.id),
      materialInstanceIds: [],
    };
  }
  return {
    settings: { defaultSequenceId: 'sequence' },
    sequences: { sequence: { id: 'sequence', trackIds: Object.keys(tracks) } },
    tracks: trackEntities,
    items,
  } as unknown as AelionProject;
}

function starts(
  plan: ReturnType<typeof planMagneticMove>,
): Record<string, { trackId: string; startUs: number }> {
  const out: Record<string, { trackId: string; startUs: number }> = {};
  for (const [id, at] of plan?.placements ?? []) out[id] = { ...at };
  return out;
}

describe('planMagneticMove on the storyline', () => {
  const storyline = () =>
    project({
      V1: {
        kind: 'visual',
        items: [
          { id: 'a', startUs: 0, durationUs: 2 * SECOND },
          { id: 'b', startUs: 2 * SECOND, durationUs: 3 * SECOND },
          { id: 'c', startUs: 5 * SECOND, durationUs: 4 * SECOND },
        ],
      },
    });

  it('packs with no gap and no overlap after moving a clip earlier', () => {
    const plan = planMagneticMove(storyline(), {
      primaryTrackId: 'V1',
      movedItemId: 'c',
      targetTrackId: 'V1',
      targetStartUs: 0,
    });
    expect(plan?.mode).toBe('reorder');
    expect(starts(plan)).toEqual({
      c: { trackId: 'V1', startUs: 0 },
      a: { trackId: 'V1', startUs: 4 * SECOND },
      b: { trackId: 'V1', startUs: 6 * SECOND },
    });
  });

  it('moves a clip to the end and closes the hole it left', () => {
    const plan = planMagneticMove(storyline(), {
      primaryTrackId: 'V1',
      movedItemId: 'a',
      targetTrackId: 'V1',
      targetStartUs: 9 * SECOND,
    });
    expect(starts(plan)).toEqual({
      b: { trackId: 'V1', startUs: 0 },
      c: { trackId: 'V1', startUs: 3 * SECOND },
      a: { trackId: 'V1', startUs: 7 * SECOND },
    });
  });

  it('takes the slot once the drag passes the midpoint of the clip holding it', () => {
    // `b` spans 2s..5s, so its midpoint is 3.5s. Landing before that keeps the
    // original order; landing after it takes b's slot.
    const before = planMagneticMove(storyline(), {
      primaryTrackId: 'V1',
      movedItemId: 'c',
      targetTrackId: 'V1',
      targetStartUs: 3 * SECOND,
    });
    const after = planMagneticMove(storyline(), {
      primaryTrackId: 'V1',
      movedItemId: 'c',
      targetTrackId: 'V1',
      targetStartUs: 4 * SECOND,
    });
    expect(starts(before).c?.startUs).toBe(2 * SECOND);
    expect(starts(after).c?.startUs).toBe(5 * SECOND);
  });

  it('keeps the storyline origin when it does not begin at zero', () => {
    const shifted = project({
      V1: {
        kind: 'visual',
        items: [
          { id: 'a', startUs: 4 * SECOND, durationUs: 2 * SECOND },
          { id: 'b', startUs: 6 * SECOND, durationUs: 2 * SECOND },
        ],
      },
    });
    const plan = planMagneticMove(shifted, {
      primaryTrackId: 'V1',
      movedItemId: 'b',
      targetTrackId: 'V1',
      targetStartUs: 0,
    });
    expect(starts(plan)).toEqual({
      b: { trackId: 'V1', startUs: 4 * SECOND },
      a: { trackId: 'V1', startUs: 6 * SECOND },
    });
  });
});

describe('planMagneticMove off the storyline', () => {
  const withOverlay = () =>
    project({
      V1: {
        kind: 'visual',
        items: [
          { id: 'a', startUs: 0, durationUs: 2 * SECOND },
          { id: 'b', startUs: 2 * SECOND, durationUs: 2 * SECOND },
        ],
      },
      V2: { kind: 'visual', items: [{ id: 'title', startUs: 5 * SECOND, durationUs: SECOND }] },
    });

  it('drops freely on an upper track without disturbing anyone', () => {
    const plan = planMagneticMove(withOverlay(), {
      primaryTrackId: 'V1',
      movedItemId: 'title',
      targetTrackId: 'V2',
      targetStartUs: 7 * SECOND + 123,
    });
    expect(plan?.mode).toBe('free');
    expect(plan?.insertAtUs).toBeUndefined();
    expect(starts(plan)).toEqual({ title: { trackId: 'V2', startUs: 7 * SECOND + 123 } });
  });

  it('closes the storyline when a clip is lifted off it', () => {
    const plan = planMagneticMove(withOverlay(), {
      primaryTrackId: 'V1',
      movedItemId: 'a',
      targetTrackId: 'V2',
      targetStartUs: 8 * SECOND,
    });
    expect(starts(plan)).toEqual({
      a: { trackId: 'V2', startUs: 8 * SECOND },
      b: { trackId: 'V1', startUs: 0 },
    });
  });

  it('inserts into the storyline when a floating clip is dropped onto it', () => {
    const plan = planMagneticMove(withOverlay(), {
      primaryTrackId: 'V1',
      movedItemId: 'title',
      targetTrackId: 'V1',
      targetStartUs: 0,
    });
    expect(plan?.mode).toBe('reorder');
    expect(starts(plan)).toEqual({
      title: { trackId: 'V1', startUs: 0 },
      a: { trackId: 'V1', startUs: SECOND },
      b: { trackId: 'V1', startUs: 3 * SECOND },
    });
  });
});

describe('planMagneticMove with linked audio', () => {
  it('keeps a linked pair aligned while the storyline repacks', () => {
    const linked = project({
      V1: {
        kind: 'visual',
        items: [
          { id: 'v1', startUs: 0, durationUs: 2 * SECOND, linkGroupId: 'g' },
          { id: 'v2', startUs: 2 * SECOND, durationUs: 3 * SECOND },
        ],
      },
      A1: {
        kind: 'audio',
        items: [{ id: 'a1', startUs: 0, durationUs: 2 * SECOND, linkGroupId: 'g' }],
      },
    });
    const plan = planMagneticMove(linked, {
      primaryTrackId: 'V1',
      movedItemId: 'v1',
      targetTrackId: 'V1',
      targetStartUs: 5 * SECOND,
      linkedItemIds: ['v1', 'a1'],
    });
    const placed = starts(plan);
    expect(placed.v1).toEqual({ trackId: 'V1', startUs: 3 * SECOND });
    // The partner follows by the same delta and stays on its own lane.
    expect(placed.a1).toEqual({ trackId: 'A1', startUs: 3 * SECOND });
    expect(placed.v2).toEqual({ trackId: 'V1', startUs: 0 });
  });
});

describe('storylineHoles', () => {
  it('reports only interior holes, measured from the first clip', () => {
    const holed = project({
      V1: {
        kind: 'visual',
        items: [
          { id: 'a', startUs: SECOND, durationUs: SECOND },
          { id: 'b', startUs: 4 * SECOND, durationUs: SECOND },
          { id: 'c', startUs: 5 * SECOND, durationUs: SECOND },
        ],
      },
    });
    expect(storylineHoles(holed, 'V1')).toEqual([{ startUs: 2 * SECOND, durationUs: 2 * SECOND }]);
  });

  it('reports nothing for an already packed storyline', () => {
    const packed = project({
      V1: {
        kind: 'visual',
        items: [
          { id: 'a', startUs: 0, durationUs: SECOND },
          { id: 'b', startUs: SECOND, durationUs: SECOND },
        ],
      },
    });
    expect(storylineHoles(packed, 'V1')).toEqual([]);
  });
});

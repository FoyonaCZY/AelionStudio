import type { AelionProject, ItemEntity } from '@aelionsdk/project-schema';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { snapItemStart, snapTime } from '../src/timeline.js';
import { createViewState, SNAP_PIXELS, type ViewState } from '../src/view-state.js';

/**
 * Pins the snapping rewrite against the shape it replaced.
 *
 * Both functions used to collect every candidate into an array and scan it;
 * they now test each candidate as it is found. That is only worth doing if the
 * candidate set is unchanged, so the previous implementations are kept here as
 * the oracle and compared on generated timelines rather than on a few examples.
 */

const SECOND = 1_000_000;

/** The frame rate the module derives when a Sequence declares none. */
const FALLBACK_RATE = { numerator: 30, denominator: 1 } as const;

function frameDurationUs(rate: { numerator: number; denominator: number }): number {
  return Math.round((1_000_000 * rate.denominator) / rate.numerator);
}

function minorStepUs(pixelsPerSecond: number): number {
  const frameUs = frameDurationUs(FALLBACK_RATE);
  const framePx = (frameUs / 1_000_000) * pixelsPerSecond;
  if (framePx >= 8) return frameUs;
  if (pixelsPerSecond >= 140) return 500_000;
  if (pixelsPerSecond >= 60) return 1_000_000;
  if (pixelsPerSecond >= 24) return 1_000_000;
  return 5_000_000;
}

/** The collected form of `snapTime`, exactly as it was written. */
function referenceSnapTime(
  timeUs: number,
  project: AelionProject,
  view: ViewState,
  extra: readonly number[] = [],
  options?: { readonly includeItems?: boolean },
): number {
  if (!view.snap) return Math.max(0, timeUs);
  const thresholdUs = Math.round((SNAP_PIXELS / view.pixelsPerSecond) * 1_000_000);
  const step = Math.max(1, minorStepUs(view.pixelsPerSecond));
  const nearest = Math.round(timeUs / step) * step;
  const candidates = [0, view.currentTimeUs, ...extra, nearest, nearest - step, nearest + step];
  if (options?.includeItems !== false) {
    for (const item of Object.values(project.items)) {
      candidates.push(item.range.startUs, item.range.startUs + item.range.durationUs);
    }
  }
  for (const transition of Object.values(project.transitions)) {
    candidates.push(
      transition.range.startUs,
      transition.range.startUs + transition.range.durationUs,
    );
  }
  for (const marker of Object.values(project.markers)) {
    if (marker.owner.type === 'sequence') {
      candidates.push(marker.timeUs);
      continue;
    }
    const item = project.items[marker.owner.id];
    if (item !== undefined) candidates.push(item.range.startUs + marker.timeUs);
  }
  let best = timeUs;
  let bestDelta = thresholdUs + 1;
  for (const candidate of candidates) {
    const delta = Math.abs(candidate - timeUs);
    if (delta < bestDelta) {
      best = candidate;
      bestDelta = delta;
    }
  }
  return Math.max(0, best);
}

/** The collected form of `snapItemStart`, exactly as it was written. */
function referenceSnapItemStart(
  startUs: number,
  item: ItemEntity,
  project: AelionProject,
  view: ViewState,
): number {
  if (!view.snap) return Math.max(0, startUs);
  const durationUs = item.range.durationUs;
  const others: number[] = [];
  const ownMarks: number[] = [];
  for (const other of Object.values(project.items)) {
    if (other.id === item.id) continue;
    others.push(other.range.startUs, other.range.startUs + other.range.durationUs);
  }
  for (const marker of Object.values(project.markers)) {
    if (marker.owner.type === 'sequence') {
      others.push(marker.timeUs);
      continue;
    }
    const owner = project.items[marker.owner.id];
    if (owner === undefined) continue;
    const time = owner.range.startUs + marker.timeUs;
    if (marker.owner.id === item.id) ownMarks.push(marker.timeUs);
    else others.push(time);
  }
  const startExtras = [...others];
  for (const mark of ownMarks) {
    for (const other of others) startExtras.push(other - mark);
  }
  const startSnap = referenceSnapTime(startUs, project, view, startExtras, {
    includeItems: false,
  });
  const endSnap =
    referenceSnapTime(startUs + durationUs, project, view, others, { includeItems: false }) -
    durationUs;
  return Math.abs(endSnap - startUs) < Math.abs(startSnap - startUs)
    ? Math.max(0, endSnap)
    : startSnap;
}

interface Spec {
  readonly startUs: number;
  readonly durationUs: number;
  readonly marks: readonly number[];
}

function project(specs: readonly Spec[]): AelionProject {
  const items: Record<string, unknown> = {};
  const markers: Record<string, unknown> = {};
  specs.forEach((spec, index) => {
    const id = `item_${index.toString()}`;
    const markerIds: string[] = [];
    spec.marks.forEach((timeUs, markIndex) => {
      const markerId = `mk_${index.toString()}_${markIndex.toString()}`;
      markers[markerId] = {
        id: markerId,
        owner: { type: 'item', id },
        timeUs: Math.min(timeUs, spec.durationUs),
        durationUs: 0,
      };
      markerIds.push(markerId);
    });
    items[id] = {
      id,
      trackId: 'V1',
      type: 'video',
      enabled: true,
      range: { startUs: spec.startUs, durationUs: spec.durationUs },
      materialInstanceIds: [],
      ...(markerIds.length === 0 ? {} : { markerIds }),
    };
  });
  markers.seqmark = {
    id: 'seqmark',
    owner: { type: 'sequence', id: 'sequence' },
    timeUs: 3 * SECOND,
    durationUs: 0,
  };
  return {
    settings: { defaultSequenceId: 'sequence' },
    sequences: {
      sequence: {
        id: 'sequence',
        trackIds: ['V1'],
        format: { frameRate: FALLBACK_RATE },
      },
    },
    tracks: {
      V1: {
        id: 'V1',
        sequenceId: 'sequence',
        kind: 'visual',
        enabled: true,
        locked: false,
        itemIds: Object.keys(items),
        materialInstanceIds: [],
      },
    },
    items,
    markers,
    transitions: {},
    linkGroups: {},
  } as unknown as AelionProject;
}

const specArb = fc.record({
  startUs: fc.integer({ min: 0, max: 40 }).map(value => value * 250_000),
  durationUs: fc.integer({ min: 1, max: 12 }).map(value => value * 250_000),
  marks: fc.array(fc.integer({ min: 0, max: 4 }).map(value => value * 250_000), {
    maxLength: 3,
  }),
});

describe('snapTime matches the collected implementation', () => {
  it('agrees on generated timelines', () => {
    fc.assert(
      fc.property(
        fc.array(specArb, { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 0, max: 60 }).map(value => value * 250_000),
        fc.constantFrom(18, 60, 90, 140, 300),
        fc.integer({ min: 0, max: 20 }).map(value => value * 250_000),
        (specs, timeUs, pixelsPerSecond, currentTimeUs) => {
          const document = project(specs);
          const view: ViewState = { ...createViewState(), pixelsPerSecond, currentTimeUs };
          expect(snapTime(timeUs, document, view)).toBe(
            referenceSnapTime(timeUs, document, view),
          );
        },
      ),
      { numRuns: 400 },
    );
  });

  it('returns the raw time when snapping is off', () => {
    const document = project([{ startUs: 0, durationUs: SECOND, marks: [] }]);
    const view: ViewState = { ...createViewState(), snap: false };
    expect(snapTime(-5, document, view)).toBe(0);
    expect(snapTime(7_777, document, view)).toBe(7_777);
  });
});

describe('snapItemStart matches the collected implementation', () => {
  it('agrees on generated timelines, including Items carrying Markers', () => {
    fc.assert(
      fc.property(
        fc.array(specArb, { minLength: 2, maxLength: 8 }),
        fc.nat({ max: 7 }),
        fc.integer({ min: 0, max: 60 }).map(value => value * 250_000),
        fc.constantFrom(18, 60, 90, 140, 300),
        fc.integer({ min: 0, max: 20 }).map(value => value * 250_000),
        (specs, pick, startUs, pixelsPerSecond, currentTimeUs) => {
          const document = project(specs);
          const ids = Object.keys(document.items);
          const item = document.items[ids[pick % ids.length] as string];
          if (item === undefined) return;
          const view: ViewState = { ...createViewState(), pixelsPerSecond, currentTimeUs };
          expect(snapItemStart(startUs, item, document, view)).toBe(
            referenceSnapItemStart(startUs, item, document, view),
          );
        },
      ),
      { numRuns: 500 },
    );
  });

  it('never returns a negative start', () => {
    const document = project([
      { startUs: 0, durationUs: 2 * SECOND, marks: [] },
      { startUs: 4 * SECOND, durationUs: SECOND, marks: [] },
    ]);
    const item = document.items.item_1;
    const view: ViewState = { ...createViewState(), pixelsPerSecond: 90 };
    expect(item).toBeDefined();
    if (item === undefined) return;
    expect(snapItemStart(-10 * SECOND, item, document, view)).toBeGreaterThanOrEqual(0);
  });
});

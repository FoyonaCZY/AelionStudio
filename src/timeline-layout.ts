import type { AelionProject, TrackEntity } from '@aelionsdk/project-schema';
import {
  firstFreeStartOnTrack,
  isRangeFreeOnTrack,
  overlappingItemOnTrack,
  type ItemExcept,
} from '@aelionsdk/sdk';

/**
 * Where Studio drops something new.
 *
 * Rearranging what is already on the timeline is the SDK's `planTimelineMove`;
 * this is the other half -- choosing the lane and the instant for a clip that
 * has no place yet, which is a product decision rather than a layout one.
 */

export type InsertPolicy = 'sequence' | 'overlay';

export type InsertPlacement =
  | { readonly createTrack: false; readonly trackId: string; readonly startUs: number }
  | { readonly createTrack: true; readonly startUs: number };

export interface ResolveInsertOptions {
  readonly kind: TrackEntity['kind'];
  readonly preferredTrackId?: string;
  readonly startUs: number;
  readonly durationUs: number;
  readonly policy: InsertPolicy;
  /** Drop onto a specific lane: do not jump to another existing track. */
  readonly lockTrack?: boolean;
  readonly exceptItemId?: string;
}

export function unlockedTracksOfKind(
  project: AelionProject,
  kind: TrackEntity['kind'],
): TrackEntity[] {
  const sequence = project.sequences[project.settings.defaultSequenceId];
  const ids = sequence?.trackIds ?? Object.keys(project.tracks);
  return ids.flatMap(id => {
    const track = project.tracks[id];
    if (track === undefined || track.kind !== kind || track.locked) return [];
    return [track];
  });
}

export function newTrackAnchorId(
  project: AelionProject,
  kind: TrackEntity['kind'],
): string | undefined {
  const sequence = project.sequences[project.settings.defaultSequenceId];
  if (sequence === undefined) return undefined;
  if (kind === 'visual') {
    return sequence.trackIds.find(id => project.tracks[id]?.kind !== 'visual');
  }
  if (kind === 'caption') {
    return sequence.trackIds.find(id => project.tracks[id]?.kind === 'audio');
  }
  return undefined;
}

export function insertPolicyForMedia(kind: 'video' | 'audio' | 'image' | string): InsertPolicy {
  return kind === 'video' || kind === 'audio' || kind === 'image' ? 'sequence' : 'overlay';
}

export function resolveInsertPlacement(
  project: AelionProject,
  options: ResolveInsertOptions,
): InsertPlacement {
  const startUs = Math.max(0, options.startUs);
  const durationUs = Math.max(1, options.durationUs);
  const tracks = unlockedTracksOfKind(project, options.kind);
  const preferred =
    options.preferredTrackId === undefined
      ? undefined
      : tracks.find(track => track.id === options.preferredTrackId);
  const primary = preferred ?? tracks[0];

  if (options.lockTrack === true && preferred !== undefined) {
    if (isRangeFreeOnTrack(project, preferred.id, startUs, durationUs, options.exceptItemId)) {
      return { createTrack: false, trackId: preferred.id, startUs };
    }
    if (options.policy === 'sequence') {
      return {
        createTrack: false,
        trackId: preferred.id,
        startUs: firstFreeStartOnTrack(
          project,
          preferred.id,
          startUs,
          durationUs,
          options.exceptItemId,
        ),
      };
    }
    const magnet = magnetStartOnTrack(
      project,
      preferred.id,
      startUs,
      durationUs,
      options.exceptItemId,
    );
    return {
      createTrack: false,
      trackId: preferred.id,
      startUs:
        magnet ??
        firstFreeStartOnTrack(project, preferred.id, startUs, durationUs, options.exceptItemId),
    };
  }

  if (options.policy === 'sequence') {
    if (primary === undefined) return { createTrack: true, startUs };
    return {
      createTrack: false,
      trackId: primary.id,
      startUs: firstFreeStartOnTrack(
        project,
        primary.id,
        startUs,
        durationUs,
        options.exceptItemId,
      ),
    };
  }

  const search = [
    ...(preferred === undefined ? [] : [preferred]),
    ...tracks.filter(track => track !== preferred),
  ];
  for (const track of search) {
    if (isRangeFreeOnTrack(project, track.id, startUs, durationUs, options.exceptItemId)) {
      return { createTrack: false, trackId: track.id, startUs };
    }
  }
  return { createTrack: true, startUs };
}

export function resolveMediaImportPlacement(
  project: AelionProject,
  kind: TrackEntity['kind'],
  startUs: number,
  durationUs: number,
  options?: { readonly preferredTrackId?: string; readonly lockTrack?: boolean },
): InsertPlacement {
  const preferredKind =
    options?.preferredTrackId === undefined
      ? undefined
      : project.tracks[options.preferredTrackId]?.kind;
  const locked = options?.lockTrack === true && preferredKind === kind;
  return resolveInsertPlacement(project, {
    kind,
    startUs,
    durationUs,
    policy: locked || kind !== 'visual' ? 'overlay' : 'sequence',
    ...(locked && options?.preferredTrackId !== undefined
      ? { preferredTrackId: options.preferredTrackId, lockTrack: true }
      : {}),
  });
}

/** Nearest gap beside an overlapping clip; `undefined` if there is no adjacent hole. */
export function magnetStartOnTrack(
  project: AelionProject,
  trackId: string,
  startUs: number,
  durationUs: number,
  except?: ItemExcept,
): number | undefined {
  const intended = Math.max(0, startUs);
  const occupant = overlappingItemOnTrack(project, trackId, intended, durationUs, except);
  if (occupant === undefined) return intended;
  const before = occupant.range.startUs - durationUs;
  const after = occupant.range.startUs + occupant.range.durationUs;
  const intendedMid = intended + durationUs / 2;
  const occupantMid = occupant.range.startUs + occupant.range.durationUs / 2;
  const preferAfter = intendedMid >= occupantMid;
  const candidates = preferAfter
    ? [Math.max(0, after), Math.max(0, before)]
    : [Math.max(0, before), Math.max(0, after)];
  for (const candidate of candidates) {
    if (isRangeFreeOnTrack(project, trackId, candidate, durationUs, except)) return candidate;
  }
  return undefined;
}

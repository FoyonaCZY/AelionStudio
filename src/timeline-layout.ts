import type { AelionProject, ItemEntity, TrackEntity } from '@aelionsdk/project-schema';

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

export function rangeOverlapUs(
  startUs: number,
  durationUs: number,
  otherStartUs: number,
  otherDurationUs: number,
): number {
  return Math.max(
    0,
    Math.min(startUs + durationUs, otherStartUs + otherDurationUs) -
      Math.max(startUs, otherStartUs),
  );
}

export function itemsOnTrack(
  project: AelionProject,
  trackId: string,
  exceptId?: string,
): ItemEntity[] {
  const track = project.tracks[trackId];
  if (track === undefined) return [];
  return track.itemIds
    .flatMap(id => {
      if (id === exceptId) return [];
      const item = project.items[id];
      return item === undefined ? [] : [item];
    })
    .sort(
      (left, right) => left.range.startUs - right.range.startUs || left.id.localeCompare(right.id),
    );
}

export function overlappingItemOnTrack(
  project: AelionProject,
  trackId: string,
  startUs: number,
  durationUs: number,
  exceptId?: string,
): ItemEntity | undefined {
  let best: ItemEntity | undefined;
  let bestOverlap = 0;
  for (const item of itemsOnTrack(project, trackId, exceptId)) {
    const overlap = rangeOverlapUs(startUs, durationUs, item.range.startUs, item.range.durationUs);
    if (overlap > bestOverlap) {
      best = item;
      bestOverlap = overlap;
    }
  }
  return best;
}

export function isRangeFreeOnTrack(
  project: AelionProject,
  trackId: string,
  startUs: number,
  durationUs: number,
  exceptId?: string,
): boolean {
  return overlappingItemOnTrack(project, trackId, startUs, durationUs, exceptId) === undefined;
}

/** First time at or after `startUs` where `[t, t + durationUs)` is empty on the track. */
export function firstFreeStartOnTrack(
  project: AelionProject,
  trackId: string,
  startUs: number,
  durationUs: number,
  exceptId?: string,
): number {
  const items = itemsOnTrack(project, trackId, exceptId);
  let cursor = Math.max(0, startUs);
  for (const item of items) {
    const endUs = item.range.startUs + item.range.durationUs;
    if (endUs <= cursor) continue;
    if (item.range.startUs >= cursor + durationUs) return cursor;
    cursor = endUs;
  }
  return cursor;
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

  const search =
    options.lockTrack === true && preferred !== undefined
      ? [preferred]
      : [
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

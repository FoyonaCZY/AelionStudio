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

export type ItemExcept = string | readonly string[] | undefined;

function exceptSet(except: ItemExcept): ReadonlySet<string> {
  if (except === undefined) return new Set();
  return new Set(typeof except === 'string' ? [except] : except);
}

export function itemsOnTrack(
  project: AelionProject,
  trackId: string,
  except?: ItemExcept,
): ItemEntity[] {
  const track = project.tracks[trackId];
  if (track === undefined) return [];
  const skip = exceptSet(except);
  return track.itemIds
    .flatMap(id => {
      if (skip.has(id)) return [];
      const item = project.items[id];
      return item === undefined ? [] : [item];
    })
    .sort(
      (left, right) => left.range.startUs - right.range.startUs || left.id.localeCompare(right.id),
    );
}

/** Swap after covering `fraction` of the shorter clip. Default is half; reverse uses less. */
export function shouldSwapOccupant(
  intendedStartUs: number,
  movedDurationUs: number,
  occupantStartUs: number,
  occupantDurationUs: number,
  fraction = 0.5,
): boolean {
  const overlap = rangeOverlapUs(
    intendedStartUs,
    movedDurationUs,
    occupantStartUs,
    occupantDurationUs,
  );
  const threshold = Math.min(movedDurationUs, occupantDurationUs) * fraction;
  return overlap > threshold;
}

export function overlappingItemOnTrack(
  project: AelionProject,
  trackId: string,
  startUs: number,
  durationUs: number,
  except?: ItemExcept,
): ItemEntity | undefined {
  let best: ItemEntity | undefined;
  let bestOverlap = 0;
  for (const item of itemsOnTrack(project, trackId, except)) {
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
  except?: ItemExcept,
): boolean {
  return (
    startUs >= 0 &&
    overlappingItemOnTrack(project, trackId, startUs, durationUs, except) === undefined
  );
}

/** First time at or after `startUs` where `[t, t + durationUs)` is empty on the track. */
export function firstFreeStartOnTrack(
  project: AelionProject,
  trackId: string,
  startUs: number,
  durationUs: number,
  except?: ItemExcept,
): number {
  const items = itemsOnTrack(project, trackId, except);
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

/** Right clip snaps to the left clip's in-point; left clip sits immediately after it. */
export function packLeftRightSwap(
  leftStartUs: number,
  rightDurationUs: number,
): { readonly rightStartUs: number; readonly leftStartUs: number } {
  const rightStartUs = Math.max(0, leftStartUs);
  return { rightStartUs, leftStartUs: rightStartUs + rightDurationUs };
}

/** Push later clips just enough so consecutive items on a track do not overlap. */
export function settleTrackOverlaps(
  items: readonly { readonly id: string; readonly startUs: number; readonly durationUs: number }[],
): { readonly id: string; readonly startUs: number }[] {
  const entries = items
    .map(item => ({ id: item.id, startUs: item.startUs, durationUs: item.durationUs }))
    .sort((left, right) => left.startUs - right.startUs || left.id.localeCompare(right.id));
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    if (previous === undefined || current === undefined) continue;
    const previousEnd = previous.startUs + previous.durationUs;
    if (current.startUs < previousEnd) current.startUs = previousEnd;
  }
  return entries.map(entry => ({ id: entry.id, startUs: entry.startUs }));
}

/** Keep a packed pair in place; shift only items that collide with it or sit after it. */
export function settleAfterPackedPair(
  items: readonly { readonly id: string; readonly startUs: number; readonly durationUs: number }[],
  packedIds: ReadonlySet<string>,
  pairStartUs: number,
  pairEndUs: number,
): { readonly id: string; readonly startUs: number }[] {
  const result: { readonly id: string; readonly startUs: number }[] = [];
  const others: { id: string; startUs: number; durationUs: number }[] = [];
  for (const item of items) {
    if (packedIds.has(item.id)) {
      result.push({ id: item.id, startUs: item.startUs });
      continue;
    }
    others.push({ id: item.id, startUs: item.startUs, durationUs: item.durationUs });
  }
  others.sort((left, right) => left.startUs - right.startUs || left.id.localeCompare(right.id));
  let cursor = pairEndUs;
  for (const item of others) {
    if (item.startUs + item.durationUs <= pairStartUs) {
      result.push({ id: item.id, startUs: item.startUs });
      continue;
    }
    const startUs = item.startUs < cursor ? cursor : item.startUs;
    result.push({ id: item.id, startUs });
    cursor = Math.max(cursor, startUs + item.durationUs);
  }
  return result;
}

/** Where each affected Item lands, plus what the drop indicator should show. */
export interface MagneticPlan {
  readonly placements: ReadonlyMap<string, { readonly trackId: string; readonly startUs: number }>;
  /** Insertion line position on the storyline, absent when the drop is free. */
  readonly insertAtUs: number | undefined;
  /** Where the dragged Item is drawn while the pointer is down. */
  readonly ghost: { readonly trackId: string; readonly startUs: number };
  readonly mode: 'reorder' | 'free';
}

interface PlannedItem {
  readonly id: string;
  readonly durationUs: number;
}

function plannedItems(project: AelionProject, trackId: string, except: ItemExcept): PlannedItem[] {
  return itemsOnTrack(project, trackId, except).map(item => ({
    id: item.id,
    durationUs: item.range.durationUs,
  }));
}

/**
 * Packs a storyline left from its first clip, leaving no gap and no overlap.
 *
 * Gap Items are ordinary members of the sequence, so deliberate blank space
 * survives packing while accidental holes do not.
 */
function packStoryline(items: readonly PlannedItem[], startUs: number): Map<string, number> {
  const placed = new Map<string, number>();
  let cursor = Math.max(0, startUs);
  for (const item of items) {
    placed.set(item.id, cursor);
    cursor += item.durationUs;
  }
  return placed;
}

/**
 * Insertion index for a clip dropped at `targetStartUs`.
 *
 * The comparison is against each resident clip's midpoint, which is what makes
 * the drop feel decided rather than fought over: the dragged clip takes a slot
 * once its own start passes the middle of the clip holding that slot, and there
 * is exactly one boundary rather than a band where nothing happens.
 */
function insertionIndex(items: readonly PlannedItem[], targetStartUs: number): number {
  let cursor = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item === undefined) break;
    if (targetStartUs < cursor + item.durationUs / 2) return index;
    cursor += item.durationUs;
  }
  return items.length;
}

/**
 * Resolves a drag into final positions without touching the Project.
 *
 * Pure by design: the pointer move recomputes this on every frame to draw the
 * preview, and only the pointer release turns the result into a transaction.
 * That is the whole difference from the previous behaviour, where each move
 * committed and the timeline rearranged underneath the cursor.
 */
/**
 * Shifts linked partners by the same delta as the clip they belong to.
 *
 * Every placed clip is considered, not just the dragged one: repacking the
 * storyline moves its other clips too, and their audio has to travel with them
 * or the drag quietly pulls the cut out of sync. Partners keep their own lane
 * and never take part in packing, so an audio track stays freely positioned.
 */
function carryLinkedPartners(
  project: AelionProject,
  placements: Map<string, { readonly trackId: string; readonly startUs: number }>,
): boolean {
  for (const [id, at] of [...placements]) {
    const item = project.items[id];
    const groupId = item?.linkGroupId;
    if (item === undefined || groupId === undefined) continue;
    const deltaUs = at.startUs - item.range.startUs;
    if (deltaUs === 0) continue;
    for (const memberId of project.linkGroups[groupId]?.itemIds ?? []) {
      if (memberId === id || placements.has(memberId)) continue;
      const member = project.items[memberId];
      if (member === undefined) continue;
      const startUs = member.range.startUs + deltaUs;
      // Clamping a partner at zero would hold it still while its video kept
      // moving, which is exactly the desync this is here to prevent. A move that
      // cannot keep the pair together is refused instead.
      if (startUs < 0) return false;
      placements.set(memberId, { trackId: member.trackId, startUs });
    }
  }
  return true;
}

/**
 * Whether the resolved layout stacks two Items on one track.
 *
 * Only the storyline is packed, so nothing otherwise stops a linked partner from
 * landing on top of its neighbour -- and it will, whenever audio is longer than
 * the video it belongs to, because packing the video says nothing about the
 * lengths below it. The schema permits overlap, so this is Studio's rule, and
 * refusing the move is the honest outcome: the alternative is either silently
 * desyncing the pair or overwriting audio the drag never mentioned.
 *
 * Only tracks the plan touches are examined, so a project that already contains
 * an overlap elsewhere stays draggable.
 */
function stacksOnAnyTrack(
  project: AelionProject,
  placements: ReadonlyMap<string, { readonly trackId: string; readonly startUs: number }>,
): boolean {
  const touched = new Set<string>();
  for (const [id, at] of placements) {
    touched.add(at.trackId);
    const item = project.items[id];
    if (item !== undefined) touched.add(item.trackId);
  }
  const lanes = new Map<string, { startUs: number; endUs: number }[]>();
  for (const item of Object.values(project.items)) {
    const at = placements.get(item.id);
    const trackId = at?.trackId ?? item.trackId;
    if (!touched.has(trackId)) continue;
    const startUs = at?.startUs ?? item.range.startUs;
    const span = { startUs, endUs: startUs + item.range.durationUs };
    const lane = lanes.get(trackId);
    if (lane === undefined) lanes.set(trackId, [span]);
    else lane.push(span);
  }
  for (const lane of lanes.values()) {
    lane.sort((left, right) => left.startUs - right.startUs);
    for (let index = 1; index < lane.length; index += 1) {
      const previous = lane[index - 1];
      const current = lane[index];
      if (previous === undefined || current === undefined) continue;
      if (current.startUs < previous.endUs) return true;
    }
  }
  return false;
}

/**
 * Reorders a clip among its neighbours on a track that is not the storyline.
 *
 * Resolved from the committed layout and the pointer alone, never from the last
 * preview, which is what makes it continue as long as the drag does: pushing
 * further simply passes more centres, so a clip can be shoved several places
 * along without letting go. A single exchange is just the two-clip case.
 *
 * Only the span between the old and new positions is reseated, and it is packed
 * from the in-point of whichever clip started that span, so clips outside it
 * never move and unequal lengths cannot leave the pair overlapping. Packing can
 * only close gaps inside the span, so it can never collide with what follows.
 *
 * Returns `undefined` when the order is unchanged, leaving the drop free.
 */
function reorderFreeTrack(
  project: AelionProject,
  trackId: string,
  moved: ItemEntity,
  targetStartUs: number,
): Map<string, number> | undefined {
  const items = itemsOnTrack(project, trackId);
  const oldIndex = items.findIndex(item => item.id === moved.id);
  if (oldIndex < 0) return undefined;
  const others = items.filter(item => item.id !== moved.id);
  // Compared centre to centre: a clip changes place once it is half way past its
  // neighbour, the same threshold the storyline uses.
  //
  // Two clips of the same length line up exactly when one is dropped onto the
  // other, and that tie has to break towards where the clip is heading. Resolved
  // one way it swallows every rightward exchange between equal clips; resolved
  // the other it makes the first position on the track unreachable, there being
  // no further left to go. Which of those is wrong depends on the direction, so
  // the comparison does too.
  const movedCentreUs = targetStartUs + moved.range.durationUs / 2;
  const headingRight = targetStartUs > moved.range.startUs;
  let newIndex = 0;
  for (const other of others) {
    const otherCentreUs = other.range.startUs + other.range.durationUs / 2;
    const passed = headingRight ? movedCentreUs >= otherCentreUs : movedCentreUs > otherCentreUs;
    if (!passed) break;
    newIndex += 1;
  }
  if (newIndex === oldIndex) return undefined;
  const ordered = [...others.slice(0, newIndex), moved, ...others.slice(newIndex)];
  const low = Math.min(oldIndex, newIndex);
  const high = Math.max(oldIndex, newIndex);
  const anchorUs = items[low]?.range.startUs ?? targetStartUs;
  const placed = new Map<string, number>();
  let cursor = anchorUs;
  for (let index = low; index <= high; index += 1) {
    const item = ordered[index];
    if (item === undefined) continue;
    placed.set(item.id, cursor);
    cursor += item.range.durationUs;
  }
  return placed;
}

export function planMagneticMove(
  project: AelionProject,
  options: {
    readonly primaryTrackId: string | undefined;
    readonly movedItemId: string;
    readonly targetTrackId: string;
    readonly targetStartUs: number;
    /** Carry linked partners along with whatever moves. */
    readonly followLinks?: boolean;
  },
): MagneticPlan | undefined {
  const moved = project.items[options.movedItemId];
  const targetTrack = project.tracks[options.targetTrackId];
  if (moved === undefined || targetTrack === undefined || targetTrack.locked) return undefined;

  const placements = new Map<string, { readonly trackId: string; readonly startUs: number }>();
  const targetStartUs = Math.max(0, Math.round(options.targetStartUs));
  const primaryTrackId = options.primaryTrackId;
  const sourceWasPrimary = moved.trackId === primaryTrackId;
  const targetIsPrimary = options.targetTrackId === primaryTrackId;

  let movedStartUs: number;

  if (targetIsPrimary && primaryTrackId !== undefined) {
    const residents = plannedItems(project, primaryTrackId, moved.id);
    const storylineStartUs = itemsOnTrack(project, primaryTrackId)[0]?.range.startUs ?? 0;
    const index = insertionIndex(residents, targetStartUs);
    const ordered = [
      ...residents.slice(0, index),
      { id: moved.id, durationUs: moved.range.durationUs },
      ...residents.slice(index),
    ];
    const packed = packStoryline(ordered, storylineStartUs);
    for (const [id, startUs] of packed) {
      placements.set(id, { trackId: primaryTrackId, startUs });
    }
    movedStartUs = packed.get(moved.id) ?? targetStartUs;
  } else {
    // Reordering is only for pushing into somebody. A drop that lands clear of
    // every other clip stays exactly where it was put, which is the whole point
    // of a track that is not the storyline.
    const pushingInto =
      moved.trackId === options.targetTrackId &&
      overlappingItemOnTrack(
        project,
        options.targetTrackId,
        targetStartUs,
        moved.range.durationUs,
        moved.id,
      ) !== undefined;
    const reordered = pushingInto
      ? reorderFreeTrack(project, options.targetTrackId, moved, targetStartUs)
      : undefined;
    if (reordered !== undefined) {
      for (const [id, startUs] of reordered) {
        placements.set(id, { trackId: options.targetTrackId, startUs });
      }
      movedStartUs = reordered.get(moved.id) ?? targetStartUs;
    } else {
      movedStartUs = targetStartUs;
      placements.set(moved.id, { trackId: options.targetTrackId, startUs: movedStartUs });
    }
    // Leaving the storyline closes the hole the clip was occupying.
    if (sourceWasPrimary && primaryTrackId !== undefined) {
      const residents = plannedItems(project, primaryTrackId, moved.id);
      const storylineStartUs = itemsOnTrack(project, primaryTrackId)[0]?.range.startUs ?? 0;
      for (const [id, startUs] of packStoryline(residents, storylineStartUs)) {
        placements.set(id, { trackId: primaryTrackId, startUs });
      }
    }
  }

  if (options.followLinks === true && !carryLinkedPartners(project, placements)) {
    return undefined;
  }
  if (stacksOnAnyTrack(project, placements)) return undefined;

  return {
    placements,
    insertAtUs: targetIsPrimary ? movedStartUs : undefined,
    ghost: { trackId: options.targetTrackId, startUs: movedStartUs },
    mode: targetIsPrimary ? 'reorder' : 'free',
  };
}

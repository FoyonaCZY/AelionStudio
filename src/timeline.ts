import type {
  AelionProject,
  ItemEntity,
  TrackEntity,
  TransitionEntity,
} from '@aelionsdk/project-schema';
import type { JsonObject } from '@aelionsdk/core';

import { encodeHex, readLinearColor } from './color.js';
import {
  clipLabel,
  contentDurationUs,
  itemMediaRef,
  orderedTracks,
  transitionLabel,
} from './project.js';
import type { MagneticPlan } from './timeline-layout.js';
import { formatTimecode, frameDurationUs, safeText } from './format.js';
import { icon, type IconName } from './icons.js';
import { MIN_TIMELINE_US, SNAP_PIXELS, TRACK_HEADER_WIDTH, type ViewState } from './view-state.js';

export { TRACK_HEADER_WIDTH } from './view-state.js';

const EMPTY_URLS: ReadonlyMap<string, string> = new Map();

/** What an in-flight drag wants drawn, before any of it has been committed. */
export interface TimelineDragPreview {
  readonly itemId: string;
  readonly plan: MagneticPlan;
  /**
   * How far the dragged clip has been carried from where it sits committed.
   *
   * Deliberately raw: unsnapped, unclamped, and independent of the lane the plan
   * would put it on. The clip has been picked up, so it goes where the pointer
   * goes, including past the ends of a track and between lanes. Where it will
   * land is what the insert line and the displaced neighbours are for.
   */
  readonly offsetPx: { readonly x: number; readonly y: number };
  /** False when the pointer is somewhere the drop has been refused. */
  readonly valid: boolean;
}

/**
 * Groups Items by the track they should be drawn on, honouring a drag preview.
 *
 * During a drag the planned layout differs from the committed one, and clips can
 * belong to a different lane than the Project says. Resolving that here keeps
 * every caller downstream working from a single, already-reconciled view.
 */
function itemsByTrack(
  project: AelionProject | null,
  drag: TimelineDragPreview | undefined,
): Map<string, { readonly item: ItemEntity; readonly startUs: number }[]> {
  const byTrack = new Map<string, { item: ItemEntity; startUs: number }[]>();
  if (project === null) return byTrack;
  for (const track of Object.values(project.tracks)) byTrack.set(track.id, []);
  for (const track of Object.values(project.tracks)) {
    for (const id of track.itemIds) {
      const item = project.items[id];
      if (item === undefined) continue;
      const planned = drag?.plan.placements.get(id);
      const trackId = planned?.trackId ?? item.trackId;
      const startUs = planned?.startUs ?? item.range.startUs;
      const lane = byTrack.get(trackId);
      if (lane === undefined) byTrack.set(trackId, [{ item, startUs }]);
      else lane.push({ item, startUs });
    }
  }
  for (const lane of byTrack.values()) {
    lane.sort(
      (left, right) => left.startUs - right.startUs || left.item.id.localeCompare(right.item.id),
    );
  }
  return byTrack;
}

export interface WaveformPeaks {
  readonly sampleRate?: number;
  readonly peaks: readonly {
    readonly startFrame?: number;
    readonly frameCount?: number;
    readonly min: readonly number[];
    readonly max: readonly number[];
  }[];
}

export const TRACK_HEIGHT: Record<TrackEntity['kind'], number> = {
  visual: 68,
  audio: 52,
  caption: 32,
};

export function timelineDurationUs(project: AelionProject | null): number {
  const content = project === null ? 0 : contentDurationUs(project);
  return Math.max(MIN_TIMELINE_US, content + 4_000_000);
}

export function usToX(timeUs: number, view: ViewState): number {
  return (timeUs / 1_000_000) * view.pixelsPerSecond - view.scrollLeftPx;
}

export function xToUs(x: number, view: ViewState): number {
  return Math.round(((x + view.scrollLeftPx) / view.pixelsPerSecond) * 1_000_000);
}

function contentXToUs(x: number, view: ViewState): number {
  return Math.max(0, Math.round((x / view.pixelsPerSecond) * 1_000_000));
}

function sequenceFrameRate(project: AelionProject | null): {
  readonly numerator: number;
  readonly denominator: number;
} {
  if (project === null) return { numerator: 30, denominator: 1 };
  const format = project.sequences[project.settings.defaultSequenceId]?.format.frameRate;
  if (format === undefined) return { numerator: 30, denominator: 1 };
  return format;
}

export function rulerMinorStepUs(
  pixelsPerSecond: number,
  frameRate: { readonly numerator: number; readonly denominator: number },
): number {
  const frameUs = frameDurationUs(frameRate);
  const framePx = (frameUs / 1_000_000) * pixelsPerSecond;
  if (framePx >= 8) return frameUs;
  if (pixelsPerSecond >= 140) return 500_000;
  if (pixelsPerSecond >= 60) return 1_000_000;
  if (pixelsPerSecond >= 24) return 1_000_000;
  return 5_000_000;
}

export function rulerMajorStepUs(
  pixelsPerSecond: number,
  frameRate: { readonly numerator: number; readonly denominator: number },
): number {
  const frameUs = frameDurationUs(frameRate);
  const framePx = (frameUs / 1_000_000) * pixelsPerSecond;
  if (framePx >= 8) return 1_000_000;
  if (pixelsPerSecond >= 140) return 1_000_000;
  if (pixelsPerSecond >= 60) return 2_000_000;
  if (pixelsPerSecond >= 24) return 5_000_000;
  return 10_000_000;
}

export function quantizeToRuler(
  timeUs: number,
  view: ViewState,
  frameRate: { readonly numerator: number; readonly denominator: number },
): number {
  const step = Math.max(1, rulerMinorStepUs(view.pixelsPerSecond, frameRate));
  return Math.max(0, Math.round(timeUs / step) * step);
}

export function timelineViewportWidthPx(root: HTMLElement): number {
  const hscroll = root.querySelector('[data-role="hscroll"]');
  if (hscroll instanceof HTMLElement && hscroll.clientWidth > 0) return hscroll.clientWidth;
  const body = root.querySelector('[data-role="body"]');
  if (body instanceof HTMLElement) return Math.max(0, body.clientWidth);
  return Math.max(0, root.clientWidth);
}

export function timelineContentWidthPx(
  view: ViewState,
  project: AelionProject | null,
  viewportPx: number,
): number {
  const durationUs = timelineDurationUs(project);
  const natural = TRACK_HEADER_WIDTH + (durationUs / 1_000_000) * view.pixelsPerSecond;
  return Math.max(viewportPx, natural, view.scrollLeftPx + viewportPx);
}

export function clampTimelineScroll(
  view: ViewState,
  project: AelionProject | null,
  root: HTMLElement,
): number {
  const viewport = timelineViewportWidthPx(root);
  const content = timelineContentWidthPx(view, project, viewport);
  const max = Math.max(0, content - viewport);
  const next = Math.min(max, Math.max(0, view.scrollLeftPx));
  view.scrollLeftPx = next;
  return next;
}

function nearestTickTimes(
  timeUs: number,
  view: ViewState,
  frameRate: { readonly numerator: number; readonly denominator: number },
): number[] {
  const step = Math.max(1, rulerMinorStepUs(view.pixelsPerSecond, frameRate));
  const nearest = Math.round(timeUs / step) * step;
  return [nearest, nearest - step, nearest + step];
}

export function snapTime(
  timeUs: number,
  project: AelionProject | null,
  view: ViewState,
  extra: readonly number[] = [],
  options?: { readonly includeItems?: boolean },
): number {
  if (!view.snap || project === null) return Math.max(0, timeUs);
  const thresholdUs = Math.round((SNAP_PIXELS / view.pixelsPerSecond) * 1_000_000);
  const frameRate = sequenceFrameRate(project);
  const candidates = [
    0,
    view.currentTimeUs,
    ...extra,
    ...nearestTickTimes(timeUs, view, frameRate),
  ];
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

export function snapPlayheadTime(
  timeUs: number,
  project: AelionProject | null,
  view: ViewState,
  frameRate: { readonly numerator: number; readonly denominator: number },
): number {
  if (view.snap && project !== null) return snapTime(timeUs, project, view);
  return quantizeToRuler(timeUs, view, frameRate);
}

export function snapItemStart(
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
  const startSnap = snapTime(startUs, project, view, startExtras, { includeItems: false });
  const endSnap =
    snapTime(startUs + durationUs, project, view, others, { includeItems: false }) - durationUs;
  return Math.abs(endSnap - startUs) < Math.abs(startSnap - startUs)
    ? Math.max(0, endSnap)
    : startSnap;
}

function trackKindIcon(kind: TrackEntity['kind']): IconName {
  if (kind === 'audio') return 'music';
  if (kind === 'caption') return 'text';
  return 'camera';
}

function clipMarkerButton(
  marker: {
    readonly id: string;
    readonly timeUs: number;
    readonly color?: string;
    readonly label?: string;
  },
  item: ItemEntity,
  trackId: string,
  view: ViewState,
): string {
  const left = ((item.range.startUs + marker.timeUs) / 1_000_000) * view.pixelsPerSecond;
  const selected = marker.id === view.selectedMarkerId;
  return `<button type="button" class="clip-marker${selected ? ' selected' : ''}" data-marker="${safeText(marker.id)}" data-item="${safeText(item.id)}" data-track="${safeText(trackId)}" style="left:${left.toFixed(2)}px;--mc:${safeText(marker.color ?? '#e85d4c')}" title="${safeText(marker.label ?? '标记')}"></button>`;
}

function transitionBlock(
  transition: TransitionEntity,
  track: TrackEntity,
  view: ViewState,
  project: AelionProject | null | undefined,
  trackHeight: number,
): string {
  const left = (transition.range.startUs / 1_000_000) * view.pixelsPerSecond;
  const width = Math.max(18, (transition.range.durationUs / 1_000_000) * view.pixelsPerSecond);
  const selected = transition.id === view.selectedTransitionId;
  const name =
    project === null || project === undefined ? '转场' : transitionLabel(project, transition);
  return `<button type="button" class="tl-transition${selected ? ' selected' : ''}" data-transition="${safeText(transition.id)}" data-track="${safeText(track.id)}" style="left:${left.toFixed(2)}px;width:${width.toFixed(2)}px;height:${trackHeight - 8}px" title="${safeText(name)}">
    <i class="clip-handle start" data-edge="start"></i>
    <span class="clip-label">${safeText(name)}</span>
    <i class="clip-handle end" data-edge="end"></i>
  </button>`;
}

/**
 * The line showing where a storyline drop will land.
 *
 * Only drawn for a reorder: a free drop onto an upper track lands exactly
 * where the ghost already sits, so a second indicator would say nothing.
 */
function insertLineHtml(drag: TimelineDragPreview | undefined, view: ViewState): string {
  const atUs = drag?.plan.insertAtUs;
  if (atUs === undefined) return '';
  const x = usToX(atUs, view) + TRACK_HEADER_WIDTH;
  return `<div class="tl-insert" style="left:${x.toFixed(2)}px"></div>`;
}

function clipClass(item: ItemEntity, selected: boolean, hasFilm: boolean): string {
  const parts = ['clip', `clip-${item.type}`];
  if (selected) parts.push('selected');
  if (!item.enabled) parts.push('disabled');
  if (item.linkGroupId !== undefined) parts.push('linked');
  if (hasFilm) parts.push('has-film');
  return parts.join(' ');
}

function clipFilmUrl(
  item: ItemEntity,
  thumbs: ReadonlyMap<string, string>,
  filmstrips: ReadonlyMap<string, string>,
): string | undefined {
  return filmstrips.get(item.id) ?? thumbs.get(itemMediaRef(item)?.assetId ?? '');
}

function clipTint(item: ItemEntity): string | undefined {
  if (item.type === 'shape') {
    const shape = (item as JsonObject).shape;
    if (shape !== null && typeof shape === 'object' && !Array.isArray(shape)) {
      return encodeHex(readLinearColor((shape as JsonObject).fill), '#5c4480');
    }
  }
  if (item.type === 'generator') {
    const generator = (item as JsonObject).generator;
    if (generator !== null && typeof generator === 'object' && !Array.isArray(generator)) {
      const colors = (generator as JsonObject).colors;
      if (Array.isArray(colors) && colors.length > 0) {
        const first = encodeHex(readLinearColor(colors[0]), '#2f6d73');
        const second = encodeHex(readLinearColor(colors[1] ?? colors[0]), first);
        return colors.length > 1 ? `linear-gradient(90deg, ${first}, ${second})` : first;
      }
    }
  }
  return undefined;
}

function peaksForClip(result: WaveformPeaks, item: ItemEntity): WaveformPeaks['peaks'] {
  const sampleRate = result.sampleRate;
  if (sampleRate === undefined || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return result.peaks;
  }
  const startFrame = Math.floor((item.range.startUs * sampleRate) / 1_000_000);
  const endFrame = Math.ceil(
    ((item.range.startUs + item.range.durationUs) * sampleRate) / 1_000_000,
  );
  const scoped = result.peaks.filter(peak => {
    const peakStart = peak.startFrame;
    const peakCount = peak.frameCount;
    if (peakStart === undefined || peakCount === undefined) return true;
    return peakStart + peakCount > startFrame && peakStart < endFrame;
  });
  return scoped.length > 0 ? scoped : result.peaks;
}

function waveformSvg(
  result: WaveformPeaks | undefined,
  item: ItemEntity,
  width: number,
  height: number,
): string {
  if (result === undefined || result.peaks.length === 0 || width < 8) return '';
  const peaks = peaksForClip(result, item);
  if (peaks.length === 0) return '';
  const mid = height / 2;
  const amplitude = height * 0.46;
  const step = width / peaks.length;
  const stroke = Math.max(0.6, step * 0.85);
  const commands: string[] = [];
  peaks.forEach((peak, index) => {
    const max = Math.max(0, ...(peak.max.length > 0 ? peak.max : [0]));
    const min = Math.min(0, ...(peak.min.length > 0 ? peak.min : [0]));
    const x = (index + 0.5) * step;
    const y1 = mid - max * amplitude;
    const y2 = mid - min * amplitude;
    commands.push(`M ${x.toFixed(2)} ${y1.toFixed(1)} L ${x.toFixed(2)} ${y2.toFixed(1)}`);
  });
  return `<svg class="wave" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><path d="${commands.join(' ')}" stroke-width="${stroke.toFixed(2)}" /></svg>`;
}

function rulerHtml(
  durationUs: number,
  view: ViewState,
  frameRate: { numerator: number; denominator: number },
  widthPx?: number,
): string {
  const width = Math.max(800, widthPx ?? 0, (durationUs / 1_000_000) * view.pixelsPerSecond);
  const ticks: string[] = [];
  const majorUs = rulerMajorStepUs(view.pixelsPerSecond, frameRate);
  let minorUs = rulerMinorStepUs(view.pixelsPerSecond, frameRate);
  const maxTicks = 12_000;
  if (durationUs / minorUs > maxTicks) {
    minorUs = Math.max(minorUs, Math.ceil(durationUs / maxTicks / minorUs) * minorUs);
  }
  const endUs = durationUs + majorUs;
  for (let timeUs = 0; timeUs <= endUs; timeUs += minorUs) {
    const x = (timeUs / 1_000_000) * view.pixelsPerSecond;
    const rem = ((timeUs % majorUs) + majorUs) % majorUs;
    const isMajor = rem < minorUs / 2 || rem > majorUs - minorUs / 2;
    ticks.push(
      `<span class="tick${isMajor ? ' major' : ''}" style="left:${x.toFixed(1)}px">${
        isMajor ? formatTimecode(timeUs, frameRate) : ''
      }</span>`,
    );
  }
  return `<div class="ruler-scale" style="width:${width.toFixed(1)}px">${ticks.join('')}</div>`;
}

export function renderTimeline(options: {
  readonly root: HTMLElement;
  readonly project: AelionProject | null;
  readonly view: ViewState;
  readonly waveforms: ReadonlyMap<string, WaveformPeaks>;
  readonly thumbs?: ReadonlyMap<string, string>;
  readonly filmstrips?: ReadonlyMap<string, string>;
  readonly drag?: TimelineDragPreview;
}): void {
  const { root, project, view } = options;
  const drag = options.drag;
  const laneItems = itemsByTrack(project, drag);
  const previousBody = root.querySelector('[data-role="body"]');
  const scrollTop = previousBody instanceof HTMLElement ? previousBody.scrollTop : 0;
  const thumbs = options.thumbs ?? EMPTY_URLS;
  const filmstrips = options.filmstrips ?? EMPTY_URLS;
  const durationUs = timelineDurationUs(project);
  const contentWidth = timelineContentWidthPx(view, project, root.clientWidth);
  const frameRate =
    project === null
      ? { numerator: 30, denominator: 1 }
      : ((project.sequences[project.settings.defaultSequenceId]?.format.frameRate ?? {
          numerator: 30,
          denominator: 1,
        }) as { numerator: number; denominator: number });
  const tracks = project === null ? [] : orderedTracks(project);
  const markers =
    project === null
      ? []
      : Object.values(project.markers).filter(marker => marker.owner.type === 'sequence');
  const playheadX = usToX(view.currentTimeUs, view) + TRACK_HEADER_WIDTH;

  root.innerHTML = `
    <div class="tl-main">
    <div class="tl-ruler">
      <div class="tl-corner"></div>
      <div class="tl-ruler-scroll" data-role="ruler">
        ${rulerHtml(durationUs, view, frameRate, contentWidth - TRACK_HEADER_WIDTH)}
      </div>
    </div>
    <div class="tl-body" data-role="body">
      <div class="tl-content" style="width:${contentWidth.toFixed(1)}px">
      ${tracks
        .map(track => {
          const height = TRACK_HEIGHT[track.kind];
          const items = laneItems.get(track.id) ?? [];
          const clips = items
            .map(({ item, startUs }) => {
              const left = (startUs / 1_000_000) * view.pixelsPerSecond;
              const width = Math.max(6, (item.range.durationUs / 1_000_000) * view.pixelsPerSecond);
              const film = clipFilmUrl(item, thumbs, filmstrips);
              const tint = clipTint(item);
              const wave =
                item.type === 'audio'
                  ? waveformSvg(options.waveforms.get(item.id), item, width, height - 8)
                  : '';
              const filmHtml =
                film === undefined
                  ? ''
                  : `<span class="clip-film" style="background-image:url('${safeText(film)}')"></span>`;
              const tintStyle = tint === undefined ? '' : `background:${safeText(tint)};`;
              const clipMarks = Object.values(project?.markers ?? {})
                .filter(marker => marker.owner.type === 'item' && marker.owner.id === item.id)
                .map(marker => clipMarkerButton(marker, item, track.id, view))
                .join('');
              const sizeClass = width < 16 ? ' tiny' : width < 28 ? ' narrow' : '';
              const dragClass = drag?.itemId === item.id ? ' dragging' : '';
              return `${clipMarks}<button type="button" class="${clipClass(item, item.id === view.selectedItemId, film !== undefined)}${sizeClass}${dragClass}" data-item="${safeText(item.id)}" data-track="${safeText(track.id)}" data-left="${left.toFixed(2)}" style="left:${left.toFixed(2)}px;width:${width.toFixed(2)}px;height:${height - 8}px;${tintStyle}">
                ${filmHtml}
                <i class="clip-handle start" data-edge="start"></i>
                <span class="clip-label">${safeText(clipLabel(item))}</span>
                ${wave}
                <i class="clip-handle end" data-edge="end"></i>
              </button>`;
            })
            .join('');
          const transitions = Object.values(project?.transitions ?? {})
            .filter(transition => transition.trackId === track.id)
            .map(transition => transitionBlock(transition, track, view, project, height))
            .join('');
          const muted = track.kind === 'audio' && track.audio?.muted === true;
          const solo = track.kind === 'audio' && track.audio?.solo === true;
          const selected = track.id === view.selectedTrackId;
          return `<div class="track-row${track.locked ? ' locked' : ''}${track.enabled ? '' : ' disabled'}${selected ? ' selected' : ''}" data-track="${safeText(track.id)}" data-kind="${track.kind}" style="height:${height}px">
            <div class="track-head">
              <span class="track-flags">
                ${
                  track.kind === 'audio'
                    ? `<button type="button" class="flag${muted ? ' off' : ''}" data-act="mute" title="静音">${icon('speaker')}</button>
                       <button type="button" class="flag${solo ? ' on' : ''}" data-act="solo" title="独奏">S</button>`
                    : `<button type="button" class="flag${track.enabled ? '' : ' off'}" data-act="enable" title="显示">${icon('eye')}</button>`
                }
                <button type="button" class="flag${track.locked ? ' on' : ''}" data-act="lock" title="锁定">${icon('lock')}</button>
              </span>
              <span class="track-kind" title="${safeText(typeof track.name === 'string' ? track.name : track.kind)}">${icon(trackKindIcon(track.kind))}</span>
            </div>
            <div class="track-lane" data-role="lane" data-track="${safeText(track.id)}" data-kind="${track.kind}">${clips}${transitions}</div>
          </div>`;
        })
        .join('')}
      </div>
    </div>
    ${insertLineHtml(drag, view)}
    <div class="playhead" style="left:${playheadX.toFixed(2)}px"></div>
    ${markers
      .map(marker => {
        const x = usToX(marker.timeUs, view) + TRACK_HEADER_WIDTH;
        return `<button type="button" class="marker${marker.id === view.selectedMarkerId ? ' selected' : ''}" data-marker="${safeText(marker.id)}" style="left:${x.toFixed(2)}px;--mc:${safeText(marker.color ?? '#e85d4c')}" title="${safeText(marker.label ?? '标记')}"></button>`;
      })
      .join('')}
    </div>
    <div class="tl-hscroll" data-role="hscroll">
      <div class="tl-hscroll-inner" style="width:${contentWidth.toFixed(1)}px"></div>
    </div>
  `;
  syncTimelineViewport(root, view, project);
  const nextBody = root.querySelector('[data-role="body"]');
  if (nextBody instanceof HTMLElement) nextBody.scrollTop = scrollTop;
}

/**
 * Moves clips to their previewed positions without rebuilding the timeline.
 *
 * This is what makes the drag animate. Rebuilding the markup would replace
 * every node, and a transition needs the *same* element to interpolate from,
 * so a drag updates the existing nodes in place: neighbours get a transform
 * offset from their committed position and ease towards it, while the clip
 * under the pointer is positioned outright so it never lags behind the cursor.
 *
 * On release the committed layout equals the previewed one, so the rebuild that
 * follows paints the same geometry and the handover is invisible.
 */
export function applyTimelineDrag(options: {
  readonly root: HTMLElement;
  readonly project: AelionProject | null;
  readonly view: ViewState;
  readonly drag: TimelineDragPreview;
}): void {
  const { root, project, view, drag } = options;
  const planned = new Map<string, { trackId: string; startUs: number }>();
  for (const [trackId, lane] of itemsByTrack(project, drag)) {
    for (const entry of lane) planned.set(entry.item.id, { trackId, startUs: entry.startUs });
  }
  for (const node of root.querySelectorAll<HTMLElement>('.clip[data-item]')) {
    const id = node.dataset.item;
    const at = id === undefined ? undefined : planned.get(id);
    if (at === undefined) continue;
    const left = (at.startUs / 1_000_000) * view.pixelsPerSecond;
    // The class carries `transition: none`; a drag updates nodes in place, so
    // the last rebuild predates the gesture and cannot have set it.
    node.classList.toggle('dragging', id === drag.itemId);
    if (id === drag.itemId) {
      node.classList.toggle('invalid', !drag.valid);
      node.style.transform = `translate(${drag.offsetPx.x.toFixed(2)}px, ${drag.offsetPx.y.toFixed(2)}px)`;
      continue;
    }
    // A refused drop must not leave neighbours standing aside for it: they go
    // back to where they really are, so the only thing moving is the clip in
    // hand, and it is visibly marked as having nowhere to land.
    const base = Number(node.dataset.left ?? '0');
    const dx = drag.valid ? left - base : 0;
    node.style.transform = Math.abs(dx) < 0.01 ? '' : `translateX(${dx.toFixed(2)}px)`;
  }
  const line = root.querySelector<HTMLElement>('.tl-insert');
  const atUs = drag.plan.insertAtUs;
  if (line !== null) {
    line.style.display = drag.valid && atUs !== undefined ? '' : 'none';
    if (drag.valid && atUs !== undefined) {
      line.style.left = `${(usToX(atUs, view) + TRACK_HEADER_WIDTH).toFixed(2)}px`;
    }
  }
}

/** Drops every drag offset, for a gesture that ended without changing anything. */
export function clearTimelineDrag(root: HTMLElement): void {
  for (const node of root.querySelectorAll<HTMLElement>('.clip[data-item]')) {
    node.classList.remove('dragging', 'invalid');
    node.style.transform = '';
    const base = node.dataset.left;
    if (base !== undefined) node.style.left = `${base}px`;
  }
}

export function syncTimelineViewport(
  root: HTMLElement,
  view: ViewState,
  project: AelionProject | null = null,
): void {
  clampTimelineScroll(view, project, root);
  const body = root.querySelector('[data-role="body"]');
  const ruler = root.querySelector('[data-role="ruler"]');
  const hscroll = root.querySelector('[data-role="hscroll"]');
  if (body instanceof HTMLElement && body.scrollLeft !== view.scrollLeftPx) {
    body.scrollLeft = view.scrollLeftPx;
  }
  if (ruler instanceof HTMLElement) ruler.scrollLeft = view.scrollLeftPx;
  if (hscroll instanceof HTMLElement && hscroll.scrollLeft !== view.scrollLeftPx) {
    hscroll.scrollLeft = view.scrollLeftPx;
  }
  const playhead = root.querySelector('.playhead');
  if (playhead instanceof HTMLElement) {
    playhead.style.left = `${(usToX(view.currentTimeUs, view) + TRACK_HEADER_WIDTH).toFixed(2)}px`;
  }
  if (project === null) return;
  for (const marker of Object.values(project.markers)) {
    const node = root.querySelector(`[data-marker="${CSS.escape(marker.id)}"]`);
    if (!(node instanceof HTMLElement)) continue;
    if (marker.owner.type === 'item') {
      const item = project.items[marker.owner.id];
      if (item === undefined) continue;
      node.style.left = `${(((item.range.startUs + marker.timeUs) / 1_000_000) * view.pixelsPerSecond).toFixed(2)}px`;
      continue;
    }
    node.style.left = `${(usToX(marker.timeUs, view) + TRACK_HEADER_WIDTH).toFixed(2)}px`;
  }
}

export function isTimelineScrollbarHit(event: PointerEvent, root: HTMLElement): boolean {
  const target = event.target;
  if (target instanceof Element) {
    if (
      target.closest('[data-item], [data-transition], [data-marker], .track-lane, .track-head') !==
      null
    ) {
      return false;
    }
    if (target.closest('[data-role="hscroll"]') !== null) return true;
  }
  const body = root.querySelector('[data-role="body"]');
  if (!(body instanceof HTMLElement)) return false;
  const bounds = body.getBoundingClientRect();
  const barX = body.offsetWidth - body.clientWidth;
  if (barX > 0 && event.clientX >= bounds.left + body.clientWidth) return true;
  return false;
}

export function hitTimeFromEvent(
  event: { readonly clientX: number; readonly target: EventTarget | null },
  root: HTMLElement,
  view: ViewState,
): number {
  const lane = (event.target as HTMLElement | null)?.closest('.track-lane');
  if (lane instanceof HTMLElement) {
    return contentXToUs(event.clientX - lane.getBoundingClientRect().left, view);
  }
  const ruler = (event.target as HTMLElement | null)?.closest('[data-role="ruler"]');
  if (ruler instanceof HTMLElement) {
    return contentXToUs(
      event.clientX - ruler.getBoundingClientRect().left + ruler.scrollLeft,
      view,
    );
  }
  return Math.max(
    0,
    xToUs(event.clientX - root.getBoundingClientRect().left - TRACK_HEADER_WIDTH, view),
  );
}

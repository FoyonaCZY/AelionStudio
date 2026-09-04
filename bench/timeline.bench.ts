import type { AelionProject } from '@aelionsdk/project-schema';

import { renderTimeline, timelineDurationUs } from '../src/timeline.js';
import { createViewState, type ViewState } from '../src/view-state.js';

/**
 * Measures what the timeline costs to draw, in the browser that has to draw it.
 *
 * String building and DOM parsing are the whole cost here, and neither shows up
 * honestly outside a real engine, so this runs in Chromium and reports wall
 * time per rebuild at several project sizes.
 */

const CLIP_DURATION_US = 4_000_000;
const FRAME = { width: 1920, height: 1080 };

function visual(fit: string): Record<string, unknown> {
  return {
    fit,
    transform: {
      positionPx: { x: FRAME.width / 2, y: FRAME.height / 2 },
      anchor: { x: 0.5, y: 0.5 },
      scale: { x: 1, y: 1 },
      rotationDeg: 0,
      skewDeg: { x: 0, y: 0 },
    },
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
    opacity: 1,
    blendMode: 'normal',
  };
}

function linear(): Record<string, unknown> {
  return { type: 'linear', rate: { numerator: 1, denominator: 1 }, reverse: false, boundary: 'hold' };
}

export function benchProject(clips: number): AelionProject {
  const items: Record<string, unknown> = {};
  const markers: Record<string, unknown> = {};
  const assets: Record<string, unknown> = {};
  const storyline: string[] = [];
  const audioIds: string[] = [];
  const titleIds: string[] = [];
  const markerIds: string[] = [];
  const assetCount = Math.max(1, Math.ceil(clips / 8));
  for (let index = 0; index < assetCount; index += 1) {
    assets[`asset_${index.toString()}`] = {
      id: `asset_${index.toString()}`,
      kind: 'video',
      name: `Clip ${index.toString()}.mp4`,
      locator: { type: 'runtime-binding', bindingId: `asset_${index.toString()}` },
    };
  }
  for (let index = 0; index < clips; index += 1) {
    const atUs = index * CLIP_DURATION_US;
    const assetId = `asset_${(index % assetCount).toString()}`;
    const videoId = `item_v_${index.toString()}`;
    const audioId = `item_a_${index.toString()}`;
    items[videoId] = {
      id: videoId,
      trackId: 'track_v1',
      type: 'video',
      name: `Shot ${index.toString()}`,
      enabled: true,
      range: { startUs: atUs, durationUs: CLIP_DURATION_US },
      materialInstanceIds: [],
      source: {
        assetId,
        stream: { type: 'video', index: 0 },
        sourceRange: { startUs: 0, durationUs: CLIP_DURATION_US },
        timeMapping: linear(),
      },
      visual: visual('cover'),
    };
    storyline.push(videoId);
    items[audioId] = {
      id: audioId,
      trackId: 'track_a1',
      type: 'audio',
      name: `Shot ${index.toString()} audio`,
      enabled: true,
      range: { startUs: atUs, durationUs: CLIP_DURATION_US },
      materialInstanceIds: [],
      source: {
        assetId,
        stream: { type: 'audio', index: 0 },
        sourceRange: { startUs: 0, durationUs: CLIP_DURATION_US },
        timeMapping: linear(),
      },
      audio: { gainDb: 0, pan: 0 },
    };
    audioIds.push(audioId);
    if (index % 4 === 0) {
      const titleId = `item_t_${index.toString()}`;
      items[titleId] = {
        id: titleId,
        trackId: 'track_v2',
        type: 'text',
        enabled: true,
        range: { startUs: atUs + 250_000, durationUs: CLIP_DURATION_US - 500_000 },
        materialInstanceIds: [],
        box: { x: 160, y: 780, width: 1600, height: 200 },
        overflow: 'auto-fit',
        writingMode: 'horizontal-tb',
        paragraphs: [
          {
            style: { align: 'center' },
            runs: [{ text: `Shot ${index.toString()}`, style: { fontSizePx: 56 } }],
          },
        ],
        visual: visual('none'),
      };
      titleIds.push(titleId);
    }
    // Sequence markers plus one Item marker every eighth clip: enough that a
    // per-clip scan over the marker collection is visible in the numbers.
    if (index % 8 === 0) {
      markers[`marker_${index.toString()}`] = {
        id: `marker_${index.toString()}`,
        owner: { type: 'sequence', id: 'seq_main' },
        timeUs: atUs,
        durationUs: 0,
        label: `Beat ${index.toString()}`,
        color: '#ff9f0a',
      };
      markerIds.push(`marker_${index.toString()}`);
      markers[`itemmark_${index.toString()}`] = {
        id: `itemmark_${index.toString()}`,
        owner: { type: 'item', id: videoId },
        timeUs: 500_000,
        durationUs: 0,
        label: 'Cue',
        color: '#4c8ee8',
      };
      (items[videoId] as Record<string, unknown>).markerIds = [`itemmark_${index.toString()}`];
    }
  }
  const track = (
    id: string,
    kind: string,
    name: string,
    itemIds: string[],
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    id,
    sequenceId: 'seq_main',
    kind,
    name,
    enabled: true,
    locked: false,
    itemIds,
    materialInstanceIds: [],
    ...(kind === 'audio' ? { audio: { gainDb: 0, pan: 0, muted: false, solo: false } } : {}),
    ...extra,
  });
  return {
    $schema: 'https://schemas.aelion.dev/project/v2.0.json',
    schemaVersion: '2.0.0',
    projectId: 'proj_bench',
    metadata: {},
    settings: {
      defaultSequenceId: 'seq_main',
      defaultStillDurationUs: 5_000_000,
      missingAssetPolicy: 'error',
      missingMaterialPolicy: 'error',
      missingPluginPolicy: 'error',
    },
    assets,
    sequences: {
      seq_main: {
        id: 'seq_main',
        format: {
          width: FRAME.width,
          height: FRAME.height,
          pixelAspectRatio: { numerator: 1, denominator: 1 },
          frameRate: { numerator: 30, denominator: 1 },
          sampleRate: 48_000,
          channelLayout: 'stereo',
          workingColorSpace: 'srgb-linear',
          backgroundColor: { space: 'srgb-linear', rgba: [0, 0, 0, 1] },
        },
        duration: { mode: 'content' },
        trackIds: ['track_v1', 'track_v2', 'track_a1'],
        transitionIds: [],
        materialInstanceIds: [],
        markerIds,
      },
    },
    tracks: {
      track_v1: track('track_v1', 'visual', 'V1', storyline, {
        role: 'storyline',
        occupancy: 'exclusive',
      }),
      track_v2: track('track_v2', 'visual', 'V2', titleIds, { role: 'overlay' }),
      track_a1: track('track_a1', 'audio', 'A1', audioIds, { role: 'overlay' }),
    },
    items,
    materialInstances: {},
    transitions: {},
    markers,
    linkGroups: {},
    extensions: {},
  } as unknown as AelionProject;
}

export interface TimelineBenchResult {
  readonly clips: number;
  readonly rebuildMs: number;
  readonly markupBytes: number;
  readonly clipNodes: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Studio always holds a frozen snapshot; an unfrozen one is a state it is never in. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
}

export function measureTimeline(
  root: HTMLElement,
  clips: number,
  iterations = 9,
): TimelineBenchResult {
  const project = deepFreeze(benchProject(clips));
  const view: ViewState = { ...createViewState(), pixelsPerSecond: 90, scrollLeftPx: 0 };
  const waveforms = new Map();
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    // Nudge the playhead so nothing can memoize between runs.
    view.currentTimeUs = index * 1_000;
    const started = performance.now();
    renderTimeline({ root, project, view, waveforms });
    // Force layout so the parse and style work is inside the measurement.
    void root.getBoundingClientRect().width;
    samples.push(performance.now() - started);
  }
  return {
    clips,
    rebuildMs: median(samples),
    markupBytes: root.innerHTML.length,
    clipNodes: root.querySelectorAll('.clip[data-item]').length,
  };
}

declare global {
  interface Window {
    __timelineBench?: (clips: number) => TimelineBenchResult;
    __timelineDuration?: (clips: number) => number;
  }
}

const host = document.querySelector<HTMLElement>('#timeline');
if (host !== null) {
  window.__timelineBench = clips => measureTimeline(host, clips);
  window.__timelineDuration = clips => timelineDurationUs(benchProject(clips));
  document.title = 'ready';
}

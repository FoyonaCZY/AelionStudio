import type { AelionProject } from '@aelionsdk/project-schema';

import { renderInspector } from '../src/inspector.js';
import { renderLibrary } from '../src/library.js';
import { contentDurationUs, orderedTracks } from '../src/project.js';
import {
  itemInBand,
  renderTimeline,
  snapItemStart,
  snapPlayheadTime,
  snapTime,
  syncTimelineViewport,
  timelineBand,
  timelineDurationUs,
  timelineViewportWidthPx,
} from '../src/timeline.js';
import { createViewState, type ViewState } from '../src/view-state.js';
import { benchProject } from './timeline.bench.js';

/**
 * Times the work Studio does per frame and per pointer move.
 *
 * A rebuild of the timeline is only one of them. Everything here runs on an
 * ordinary interaction -- scrubbing, dragging, playing back -- so anything that
 * scales with the size of the Project is felt as stutter no matter how fast the
 * markup is to build.
 */

const FRAME_RATE = { numerator: 30, denominator: 1 } as const;

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
}

export interface Sample {
  readonly name: string;
  readonly clips: number;
  readonly ms: number;
}

function measure(name: string, clips: number, iterations: number, work: () => void): Sample {
  for (let index = 0; index < Math.min(iterations, 20); index += 1) work();
  const samples: number[] = [];
  for (let round = 0; round < 7; round += 1) {
    const started = performance.now();
    for (let index = 0; index < iterations; index += 1) work();
    samples.push((performance.now() - started) / iterations);
  }
  samples.sort((left, right) => left - right);
  return { name, clips, ms: samples[3] ?? 0 };
}

/**
 * Everything a Studio render recomputes before it decides whether to rebuild.
 *
 * Mirrors `Studio.render`: the keys now come from the revision and the engine's
 * preview version, and the library's preview URLs are only built when the
 * library is actually being rebuilt.
 */
function renderKeys(
  project: AelionProject,
  view: ViewState,
  revision: string,
  previewVersion: number,
): string {
  const durationUs = timelineDurationUs(project);
  const libraryKey = `${view.libraryTab}:${view.libraryView}:${view.librarySort}:${revision}:${previewVersion.toString()}`;
  const timelineKey = `${view.pixelsPerSecond.toString()}:${durationUs.toString()}:${previewVersion.toString()}`;
  return `${libraryKey}|${timelineKey}`;
}

export function measureInteractions(root: HTMLElement, clips: number): Sample[] {
  // Studio always holds a frozen snapshot: `TransactionEngine` freezes every
  // revision it publishes. Measuring an unfrozen document reports a state the
  // editor is never in, and hides the identity caches that depend on it.
  const project = deepFreeze(benchProject(clips));
  const view: ViewState = { ...createViewState(), pixelsPerSecond: 90, scrollLeftPx: 0 };
  const empty = new Map<string, string>();
  const waveforms = new Map();
  const midUs = Math.floor((contentDurationUs(project) / 2) as number);
  const item = project.items.item_v_0;

  // A first rebuild so the DOM the other cases read from exists.
  renderTimeline({ root, project, view, waveforms });

  const out: Sample[] = [];
  out.push(
    measure('rebuild the timeline', clips, 20, () => {
      renderTimeline({ root, project, view, waveforms });
    }),
  );
  out.push(
    measure('recompute the render keys', clips, 60, () => {
      renderKeys(project, view, '7', 3);
    }),
  );
  out.push(
    measure('snap a scrub position', clips, 60, () => {
      snapPlayheadTime(midUs, project, view, FRAME_RATE);
    }),
  );
  out.push(
    measure('snap a dragged clip start', clips, 60, () => {
      snapItemStart(midUs, item, project, view);
    }),
  );
  out.push(
    measure('snap a time with no exclusions', clips, 60, () => {
      snapTime(midUs, project, view);
    }),
  );
  out.push(
    measure('move the playhead (viewport sync)', clips, 60, () => {
      view.currentTimeUs = (view.currentTimeUs + 33_367) % 100_000_000;
      syncTimelineViewport(root, view, project);
    }),
  );
  out.push(
    measure('order the tracks', clips, 200, () => {
      orderedTracks(project);
    }),
  );
  out.push(
    measure('measure the content duration', clips, 200, () => {
      contentDurationUs(project);
    }),
  );
  out.push(
    measure('resolve the visible band', clips, 500, () => {
      timelineBand(view, timelineViewportWidthPx(root));
    }),
  );

  out.push(
    measure('scan for preview work to queue', clips, 60, () => {
      // What one pass of `#queueWaveforms` and `#queueFilmstrips` costs. Studio
      // now runs it only when its inputs change rather than on every frame, so
      // this is the price of a band move or an edit, not of a frame.
      const band = timelineBand(view, timelineViewportWidthPx(root));
      let found = 0;
      for (const entry of Object.values(project.items)) {
        if (!itemInBand(entry, band)) continue;
        if (entry.type === 'audio') found += 1;
      }
      for (const entry of Object.values(project.items)) {
        if (entry.type !== 'video' && entry.type !== 'image') continue;
        if (!itemInBand(entry, band)) continue;
        found += 1;
      }
      return found;
    }),
  );

  const libraryRoot = document.createElement('div');
  root.append(libraryRoot);
  out.push(
    measure('rebuild the library', clips, 20, () => {
      renderLibrary({
        root: libraryRoot,
        project,
        tab: 'media',
        view: 'grid',
        sort: 'az',
        thumbs: empty,
      });
    }),
  );

  const inspectorRoot = document.createElement('div');
  root.append(inspectorRoot);
  out.push(
    measure('rebuild the inspector', clips, 20, () => {
      renderInspector({ root: inspectorRoot, project, item, view });
    }),
  );
  libraryRoot.remove();
  inspectorRoot.remove();
  return out;
}

declare global {
  interface Window {
    __interactionBench?: (clips: number) => Sample[];
  }
}

const host = document.querySelector<HTMLElement>('#timeline');
if (host !== null) {
  window.__interactionBench = clips => measureInteractions(host, clips);
}

import { SeekableMemorySink } from '@aelionsdk/export';
import type { AelionProject, ItemEntity } from '@aelionsdk/project-schema';
import {
  exportSubtitleTrack,
  type AelionInteractiveEdit,
  type AelionProfileExportOptions,
  type PreviewCanvasPointerEvent,
  type PreviewCanvasQuality,
} from '@aelionsdk/sdk';

import {
  addMarker,
  addTrack,
  applyEffect,
  applyTransition,
  canRemoveTrack,
  deleteSelection,
  itemAtTime,
  removeEffect,
  setEffectValue,
  freezeFrame,
  insertCaptionCue,
  insertExistingAsset,
  insertGenerated,
  itemCoveringTime,
  itemsUsingAsset,
  renameAsset,
  deleteAsset,
  realignLinkGroup,
  removeMarker,
  removeTrack,
  neighborPair,
  removeTransition,
  resizeTransition,
  setTransitionDuration,
  patchAudio,
  patchVisual,
  moveItemAvoidingOverlap,
  moveLinkedGroupAvoidingOverlap,
  moveLinkedMemberToTrack,
  resizeTimelineItem,
  setItemEnabled,
  setShapeFill,
  setSpeed,
  setTextContent,
  patchTextStyle,
  splitAt,
  type LibraryDropKind,
} from './commands.js';
import { downloadBlob, downloadText, on, requiredElement } from './dom.js';
import { EditorEngine, type ImportPlacementOptions } from './engine.js';
import { errorMessage, isIdleEditError } from './errors.js';
import { clampTime, formatTimecode, frameDurationUs, quantizeToFrame } from './format.js';
import { renderInspector } from './inspector.js';
import { renderLibrary } from './library.js';
import {
  firstTrackId,
  itemMediaRef,
  itemSource,
  itemVisual,
  linkedMixerItem,
  mediaSourceSize,
  readFittedTransform,
  readTransform,
  visualFitScale,
  type VisualTransform,
} from './project.js';
import {
  collectProgramSnapTargets,
  containLayout,
  EMPTY_PROGRAM_SNAP_GUIDES,
  hitTestProgram,
  isProgramItem,
  itemSourceBox,
  pointerMovePosition,
  pointerOriginAngle,
  programCursor,
  programYAxisFromBackend,
  renderProgramOverlay,
  rotationFromPointer,
  scaleFromPointer,
  snapProgramMove,
  snapProgramRotation,
  snapProgramScale,
  type ProgramBox,
  type ProgramHandle,
  type ProgramSnapGuides,
  type ProgramSnapTargets,
  type ProgramYAxis,
} from './program-overlay.js';
import { parseSubtitleDocument } from './subtitle.js';
import { fontPresetFamilies, readItemTextStyle } from './text-metrics.js';
import {
  clampTimelineScroll,
  hitTimeFromEvent,
  isTimelineScrollbarHit,
  renderTimeline,
  snapItemStart,
  snapPlayheadTime,
  snapTime,
  syncTimelineViewport,
  timelineDurationUs,
  TRACK_HEADER_WIDTH,
} from './timeline.js';
import {
  allowsNativeContextMenu,
  hideContextMenu,
  isContextMenuElement,
  item as menuItem,
  sep as menuSep,
  showContextMenu,
  type ContextMenuEntry,
  type ContextTarget,
} from './context-menu.js';
import { createHomeState, editorHash, HOME_HASH, parseStudioRoute, renderHome } from './home.js';
import { listProjectSummaries, type ProjectSummary } from './project-store.js';
import {
  createViewState,
  MAX_PPS,
  MIN_PPS,
  resetViewState,
  type EditTool,
  type InspectorTab,
  type LibraryTab,
} from './view-state.js';

interface ProgramPointerSample {
  readonly point: { readonly x: number; readonly y: number };
  readonly lockAspect: boolean;
  readonly snapEnabled: boolean;
}

interface ProgramGesture {
  readonly kind: 'move' | 'scale' | 'rotate';
  readonly handle: ProgramHandle;
  readonly itemId: string;
  readonly pointerId: number;
  readonly originPoint: { readonly x: number; readonly y: number };
  readonly origin: VisualTransform;
  readonly originAngle: number;
  readonly yAxis: ProgramYAxis;
  /**
   * Resolved once at pointer-down. Nothing resizes the canvas or moves the
   * other layers mid-drag, so recomputing these per pointer move only bought
   * forced reflows and repeated text layout.
   */
  readonly viewScale: number;
  readonly sourceBox: ProgramBox;
  readonly snapTargets: ProgramSnapTargets;
  readonly fitScale: { readonly x: number; readonly y: number };
  /** Latest pointer sample, applied on the next animation frame. */
  pending: ProgramPointerSample | undefined;
  live: VisualTransform;
  snapGuides: ProgramSnapGuides;
  moved: boolean;
}

interface Gesture {
  readonly kind: 'move' | 'trim' | 'slip' | 'slide' | 'roll' | 'playhead' | 'transition-trim';
  readonly itemId: string;
  trackId: string;
  readonly edge?: 'start' | 'end';
  originUs: number;
  startUs: number;
  readonly durationUs: number;
  readonly pointerId: number;
  readonly historyGroup: string;
  swappedOccupantId?: string;
}

export class Studio {
  readonly view = createViewState();
  readonly engine = new EditorEngine();
  readonly #els = {
    home: requiredElement('#home'),
    homeGrid: requiredElement('#home-grid'),
    homeCount: requiredElement('#home-count'),
    homeSearch: requiredElement('#home-search') as HTMLInputElement,
    homeSort: requiredElement('#home-sort') as HTMLSelectElement,
    homeStatus: requiredElement('#home-status'),
    studio: requiredElement('#studio'),
    library: requiredElement('#library'),
    inspector: requiredElement('#inspector'),
    analysis: requiredElement('#analysis'),
    timeline: requiredElement('#timeline'),
    canvas: requiredElement('#preview') as HTMLCanvasElement,
    overlay: requiredElement('#program-overlay'),
    play: requiredElement('#play') as HTMLButtonElement,
    timecode: requiredElement('#timecode'),
    duration: requiredElement('#duration'),
    status: requiredElement('#status'),
    statusDot: requiredElement('#status-dot'),
    backend: requiredElement('#backend'),
    revision: requiredElement('#revision'),
    dropped: requiredElement('#dropped'),
    title: requiredElement('#project-title'),
    meta: requiredElement('#monitor-meta'),
    safe: requiredElement('#safe-frame'),
    fileMedia: requiredElement('#file-media') as HTMLInputElement,
    fileSub: requiredElement('#file-sub') as HTMLInputElement,
    dialogNew: requiredElement('#dialog-new') as HTMLDialogElement,
    dialogUrl: requiredElement('#dialog-url') as HTMLDialogElement,
    dialogRename: requiredElement('#dialog-rename') as HTMLDialogElement,
    dialogExport: requiredElement('#dialog-export') as HTMLDialogElement,
    dialogInfo: requiredElement('#dialog-info') as HTMLDialogElement,
    exportProgress: requiredElement('#export-progress'),
    preflight: requiredElement('#export-preflight'),
  };
  #gesture: Gesture | undefined;
  #programGesture: ProgramGesture | undefined;
  #programEdit: AelionInteractiveEdit | undefined;
  #programApplyScheduled = false;
  #inspectorEdit: AelionInteractiveEdit | undefined;
  #waveformQueued = new Set<string>();
  #filmstripQueued = new Set<string>();
  #renderScheduled = false;
  #previewDirty = false;
  #previewRendering = false;
  #scrubScheduled = false;
  #scrubTimeUs = 0;
  #libraryKey = '';
  #renameAssetId: string | undefined;
  #inspectorKey = '';
  #timelineKey = '';
  #screen: 'home' | 'editor' = 'home';
  #home = createHomeState();
  #homeProjects: readonly ProjectSummary[] = [];
  #routeTail: Promise<void> = Promise.resolve();
  #ignoreTransportKeysUntil = 0;
  #playheadPolling = false;
  #revealedItemId: string | undefined;
  #importTarget: ImportPlacementOptions & { readonly atUs?: number } | undefined;

  public async start(): Promise<void> {
    this.#layout();
    this.#bind();
    this.setStatus('正在启动…');
    await this.engine.bootRuntime(
      this.#els.canvas,
      () => {
        if (this.#programGesture?.moved === true) {
          this.#refreshPreview();
          return;
        }
        this.scheduleRender();
        this.#refreshPreview();
      },
      message => this.setStatus(message, true),
    );
    this.engine.setPreviewPointerHandler(event => this.#onProgramPointer(event));
    this.engine.setPreviewReadyHandler(() => {
      if (this.view.error) this.setStatus('就绪');
      if ((this.engine.preview?.snapshot().renderedFrames ?? 0) === 1) this.scheduleRender();
    });
    this.engine.setPlayerStateHandler(() => this.#syncTransportChrome());
    this.engine.preview?.setQuality(this.view.previewQuality);
    if (location.hash === '' || location.hash === '#') {
      history.replaceState(null, '', HOME_HASH);
    }
    await this.#applyRoute();
  }

  public setStatus(message: string, error = false): void {
    this.view.status = message;
    this.view.error = error;
    this.#els.status.textContent = message;
    this.#els.statusDot.classList.toggle('error', error);
    this.#els.homeStatus.textContent = message;
    this.#els.homeStatus.classList.toggle('error', error);
  }

  public scheduleRender(): void {
    if (this.#renderScheduled) return;
    this.#renderScheduled = true;
    requestAnimationFrame(() => {
      this.#renderScheduled = false;
      this.render();
    });
  }

  #programYAxis(): ProgramYAxis {
    return programYAxisFromBackend(this.engine.session?.getSnapshot().stats.preview.lastBackend);
  }

  #restorePreviewSharpness(): void {
    const quality = this.view.previewQuality;
    this.engine.setQuality(quality, quality === 'draft' ? 0.5 : 1);
  }

  #refreshPreview(): void {
    if (this.engine.session?.player.state === 'playing') return;
    this.#previewDirty = true;
    if (this.#previewRendering) return;
    this.#previewRendering = true;
    void this.#flushPreview();
  }

  async #flushPreview(): Promise<void> {
    try {
      while (this.#previewDirty) {
        this.#previewDirty = false;
        try {
          await this.engine.renderFrame(this.view.currentTimeUs);
        } catch {
          break;
        }
      }
    } finally {
      this.#previewRendering = false;
      if (this.#previewDirty && this.engine.session?.player.state !== 'playing') {
        this.#previewRendering = true;
        void this.#flushPreview();
      }
    }
  }

  public render(): void {
    if (this.#screen !== 'editor') return;
    const project = this.engine.project;
    const format = this.engine.format;
    const durationUs = this.engine.durationUs;
    if (this.#programGesture === undefined && this.#gesture === undefined) {
      this.view.currentTimeUs = clampTime(this.view.currentTimeUs, Math.max(1, durationUs));
    }
    this.#els.studio.style.setProperty('--left', `${this.view.leftWidth}px`);
    this.#els.studio.style.setProperty('--right', `${this.view.rightWidth}px`);
    this.#els.studio.style.setProperty('--timeline', `${this.view.timelineHeight}px`);
    this.#els.timecode.textContent = formatTimecode(this.view.currentTimeUs, format.frameRate);
    this.#els.duration.textContent = formatTimecode(durationUs, format.frameRate);
    this.#els.meta.textContent = `${format.width}×${format.height} · ${Math.round(
      format.frameRate.numerator / format.frameRate.denominator,
    )} fps`;
    this.#els.title.textContent =
      project !== null && typeof project.metadata.title === 'string'
        ? project.metadata.title
        : '未命名工程';
    this.#els.safe.hidden = !this.view.showSafeArea;
    this.#els.play.classList.toggle('is-playing', this.engine.session?.player.state === 'playing');
    const snap = this.engine.session?.getSnapshot();
    this.#els.backend.textContent = snap?.stats.preview.lastBackend ?? '—';
    this.#els.revision.textContent = `rev ${snap?.revision?.toString() ?? '—'}`;
    this.#els.dropped.textContent = `drop ${snap?.stats.player.droppedFrames ?? 0}`;
    this.#els.analysis.hidden = this.view.analysisText === undefined;
    this.#els.analysis.textContent = this.view.analysisText ?? '';
    document.querySelectorAll<HTMLButtonElement>('.tool').forEach(button => {
      const on = button.dataset.tool === this.view.tool;
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    clampTimelineScroll(this.view, project, this.#els.timeline);
    this.#setPressed('tl-snap', this.view.snap);
    this.#setPressed('program-snap', this.view.programSnap);
    this.#setPressed('tl-linked', this.view.linkedEdit);
    this.#setPressed('tl-ripple', this.view.ripple);
    this.#setPressed('safe-area', this.view.showSafeArea);
    const quality = document.querySelector('#quality');
    if (quality instanceof HTMLSelectElement) quality.value = this.view.previewQuality;
    const libraryThumbs = libraryPreviewUrls(project, this.engine.thumbs, this.engine.filmstrips);
    const assetStamp =
      project === null
        ? ''
        : Object.values(project.assets)
            .map(asset => `${asset.id}:${typeof asset.name === 'string' ? asset.name : ''}`)
            .join(',');
    const libraryKey = `${this.view.libraryTab}:${this.view.libraryView}:${this.view.librarySort}:${assetStamp}:${libraryThumbs.size.toString()}`;
    if (libraryKey !== this.#libraryKey) {
      this.#libraryKey = libraryKey;
      renderLibrary({
        root: this.#els.library,
        project,
        tab: this.view.libraryTab,
        view: this.view.libraryView,
        sort: this.view.librarySort,
        thumbs: libraryThumbs,
      });
    }
    const focused = document.activeElement;
    const inspectorBusy =
      this.#inspectorEdit?.active === true ||
      this.#programGesture !== undefined ||
      (focused instanceof HTMLElement &&
        this.#els.inspector.contains(focused) &&
        (focused instanceof HTMLInputElement ||
          focused instanceof HTMLTextAreaElement ||
          focused instanceof HTMLSelectElement));
    const inspectorKey = `${this.view.selectedItemId ?? ''}:${this.view.selectedTransitionId ?? ''}:${this.view.inspectorTab}:${snap?.revision?.toString() ?? ''}`;
    if (!inspectorBusy && inspectorKey !== this.#inspectorKey) {
      this.#inspectorKey = inspectorKey;
      const transition =
        this.view.selectedTransitionId === undefined || project === null
          ? undefined
          : project.transitions[this.view.selectedTransitionId];
      renderInspector({
        root: this.#els.inspector,
        project,
        item: selected(project, this.view.selectedItemId),
        view: this.view,
        ...(transition === undefined ? {} : { transition }),
      });
    }
    if (this.#programGesture === undefined) {
      const timelineKey = `${snap?.revision?.toString() ?? ''}:${this.view.selectedItemId ?? ''}:${this.view.selectedTransitionId ?? ''}:${this.view.selectedMarkerId ?? ''}:${this.view.selectedTrackId ?? ''}:${this.view.pixelsPerSecond.toString()}:${durationUs.toString()}:${this.engine.waveforms.size.toString()}:${this.engine.thumbs.size.toString()}:${[...this.engine.filmstrips.keys()].join(',')}:${project === null ? '' : Object.keys(project.transitions).join(',')}`;
      if (timelineKey !== this.#timelineKey) {
        this.#timelineKey = timelineKey;
        renderTimeline({
          root: this.#els.timeline,
          project,
          view: this.view,
          waveforms: this.engine.waveforms,
          thumbs: this.engine.thumbs,
          filmstrips: this.engine.filmstrips,
        });
      } else {
        syncTimelineViewport(this.#els.timeline, this.view, project);
      }
      this.#queueWaveforms(project);
      if (this.#gesture === undefined) this.#queueFilmstrips(project);
      this.#revealSelectedClip();
    }
    this.#syncProgramOverlay();
  }

  public run(label: string, action: () => void | Promise<void>): void {
    void Promise.resolve()
      .then(action)
      .then(() => {
        this.setStatus(label);
        this.scheduleRender();
        this.#refreshPreview();
      })
      .catch((error: unknown) => this.setStatus(errorMessage(error, label), true));
  }

  async #seek(timeUs: number): Promise<void> {
    const durationUs = Math.max(1, timelineDurationUs(this.engine.project));
    this.view.currentTimeUs = clampTime(
      snapPlayheadTime(
        timeUs,
        this.engine.project,
        this.view,
        this.engine.format.frameRate,
      ),
      durationUs,
    );
    this.#els.timecode.textContent = formatTimecode(
      this.view.currentTimeUs,
      this.engine.format.frameRate,
    );
    const playhead = this.#els.timeline.querySelector('.playhead');
    if (playhead instanceof HTMLElement) {
      playhead.style.left = `${TRACK_HEADER_WIDTH + (this.view.currentTimeUs / 1_000_000) * this.view.pixelsPerSecond - this.view.scrollLeftPx}px`;
    }
    if (this.engine.session?.player.state === 'playing') {
      await this.engine.seek(this.view.currentTimeUs);
      return;
    }
    // Paused seeks go through the preview coalescer instead of awaiting a
    // decode per call. It re-reads `currentTimeUs` on each pass, so a burst of
    // scrub positions collapses into one in-flight frame at the newest time.
    this.#refreshPreview();
  }

  /**
   * Scrubbing fires on every pointer move, which can outrun the display several
   * times over. Snapping alone scans every Item, transition and marker, so the
   * whole scrub is folded into one animation frame.
   */
  #scheduleScrub(timeUs: number): void {
    this.#scrubTimeUs = timeUs;
    if (this.#scrubScheduled) return;
    this.#scrubScheduled = true;
    requestAnimationFrame(() => {
      this.#scrubScheduled = false;
      void this.#seek(this.#scrubTimeUs);
    });
  }

  #bind(): void {
    on(this.#els.play, 'click', () => void this.#togglePlay());
    new ResizeObserver(() => this.#syncProgramOverlay()).observe(this.#els.canvas);
    on(requiredElement('.viewer'), 'pointerdown', event => this.#onPreviewChromePointerDown(event));
    on(requiredElement('#to-start'), 'click', () => void this.#seek(0));
    on(
      requiredElement('#to-end'),
      'click',
      () => void this.#seek(Math.max(0, this.engine.renderDurationUs - 1)),
    );
    on(requiredElement('#step-back'), 'click', () => this.#step(-1));
    on(requiredElement('#step-forward'), 'click', () => this.#step(1));
    on(requiredElement('#quality'), 'change', event => {
      const value = (event.target as HTMLSelectElement).value as PreviewCanvasQuality;
      this.view.previewQuality = value;
      this.engine.setQuality(value);
      void this.engine.preview?.render(this.view.currentTimeUs);
    });
    on(this.#els.fileMedia, 'change', () => {
      const files = [...(this.#els.fileMedia.files ?? [])];
      this.#els.fileMedia.value = '';
      this.#ignoreTransportKeysUntil = performance.now() + 800;
      const target = this.#importTarget;
      this.#importTarget = undefined;
      if (files.length > 0) {
        this.#importFiles(files, target?.atUs ?? this.view.currentTimeUs, target);
      }
    });
    on(this.#els.fileSub, 'change', () => {
      const file = this.#els.fileSub.files?.[0];
      this.#els.fileSub.value = '';
      if (file !== undefined) void this.#importSubtitle(file);
    });
    on(document, 'contextmenu', event => this.#onContextMenu(event as MouseEvent), {
      capture: true,
    });
    on(window, 'resize', () => {
      hideContextMenu();
      clampTimelineScroll(this.view, this.engine.project, this.#els.timeline);
      syncTimelineViewport(this.#els.timeline, this.view, this.engine.project);
    });
    on(this.#els.home, 'click', event => this.#onHomeClick(event));
    on(this.#els.homeSearch, 'input', () => {
      this.#home.query = this.#els.homeSearch.value;
      this.#renderHome();
    });
    on(this.#els.homeSort, 'change', () => {
      this.#home.sort = this.#els.homeSort.value === 'title' ? 'title' : 'modified';
      this.#renderHome();
    });
    on(window, 'hashchange', () => {
      hideContextMenu();
      void this.#applyRoute();
    });
    on(this.#els.studio, 'click', event => this.#onClick(event));
    on(this.#els.library, 'dblclick', event => this.#onLibraryDblClick(event));
    on(this.#els.studio, 'change', event => this.#onChange(event));
    on(this.#els.studio, 'input', event => this.#onInput(event));
    on(this.#els.library, 'dragstart', event => this.#onLibraryDrag(event as DragEvent));
    on(this.#els.library, 'dragover', event => this.#onLibraryDragOver(event as DragEvent));
    on(this.#els.library, 'drop', event => this.#onLibraryDrop(event as DragEvent));
    on(this.#els.timeline, 'dragover', event => {
      event.preventDefault();
      event.stopPropagation();
      const drag = event as DragEvent;
      if (drag.dataTransfer !== null) drag.dataTransfer.dropEffect = 'copy';
    });
    on(this.#els.timeline, 'drop', event => this.#onTimelineDrop(event as DragEvent));
    on(this.#els.timeline, 'scroll', event => this.#onTimelineScroll(event), { capture: true });
    on(this.#els.timeline, 'pointerdown', event =>
      this.#onTimelinePointerDown(event as PointerEvent),
    );
    on(this.#els.timeline, 'pointermove', event =>
      this.#onTimelinePointerMove(event as PointerEvent),
    );
    on(this.#els.timeline, 'pointerup', event => this.#onTimelinePointerUp(event as PointerEvent));
    on(this.#els.timeline, 'pointercancel', event =>
      this.#onTimelinePointerUp(event as PointerEvent),
    );
    on(this.#els.timeline, 'wheel', event => this.#onTimelineWheel(event as WheelEvent), {
      passive: false,
    });
    on(this.#els.studio, 'pointerdown', event => this.#onSplitterDown(event as PointerEvent));
    on(window, 'keydown', event => this.#onKey(event as KeyboardEvent));
    on(window, 'beforeunload', () => {
      void this.engine.persistence?.flush();
    });
    on(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.engine.persistence?.flush();
    });
    on(this.#els.studio, 'dragover', event => this.#onStudioDragOver(event as DragEvent));
    on(this.#els.studio, 'drop', event => this.#onStudioDrop(event as DragEvent));
    requiredElement('#export-preflight-btn').addEventListener(
      'click',
      () => void this.#preflight(),
    );
    requiredElement('#export-start').addEventListener('click', () => void this.#export());
    requiredElement('#export-cancel').addEventListener('click', () => {
      void this.engine.session?.export.cancel();
    });
    requiredElement('#export-profile').addEventListener('change', () => {
      this.#syncExportForm();
      this.#setExportStatus('尚未预检', 'idle');
    });
    on(this.#els.dialogNew, 'close', () => this.#onNewProject());
    on(this.#els.dialogUrl, 'close', () => this.#onImportUrl());
    on(this.#els.dialogRename, 'close', () => this.#onRenameAsset());
    on(requiredElement('#rename-cancel'), 'click', () => this.#els.dialogRename.close('cancel'));
    on(this.#els.inspector, 'focusout', () => {
      queueMicrotask(() => {
        if (!this.#els.inspector.contains(document.activeElement)) this.scheduleRender();
      });
    });
    on(document, 'pointerdown', event => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      document.querySelectorAll('.menus details[open]').forEach(node => {
        if (!node.contains(target)) node.removeAttribute('open');
      });
      if (!isContextMenuElement(target)) hideContextMenu();
    });
  }

  #onContextMenu(event: MouseEvent): void {
    if (event.shiftKey) return;
    if (allowsNativeContextMenu(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    if (isContextMenuElement(event.target)) return;
    document.querySelectorAll('.menus details[open]').forEach(node => node.removeAttribute('open'));
    const hit = this.#contextTarget(event);
    showContextMenu({
      items: this.#contextItems(hit),
      x: event.clientX,
      y: event.clientY,
      onSelect: id => this.#runContext(id, hit),
    });
  }

  #contextTarget(event: MouseEvent): ContextTarget {
    const target = event.target;
    if (!(target instanceof Element)) return { kind: 'app' };
    if (document.querySelector('dialog[open]') !== null) return { kind: 'dialog' };
    if (this.#screen === 'home') {
      const projectId =
        target.closest<HTMLElement>('[data-open-project]')?.dataset.openProject ??
        target.closest<HTMLElement>('[data-delete-project]')?.dataset.deleteProject ??
        target
          .closest<HTMLElement>('.project-card')
          ?.querySelector<HTMLElement>('[data-open-project]')?.dataset.openProject;
      return projectId === undefined ? { kind: 'home' } : { kind: 'home-project', projectId };
    }
    const effectId = target.closest<HTMLElement>('[data-effect]')?.dataset.effect;
    if (effectId !== undefined && this.#els.inspector.contains(target)) {
      return {
        kind: 'inspector-effect',
        effectId,
        ...(this.view.selectedItemId === undefined ? {} : { itemId: this.view.selectedItemId }),
      };
    }
    if (this.#els.inspector.contains(target)) {
      return {
        kind: 'inspector',
        ...(this.view.selectedItemId === undefined ? {} : { itemId: this.view.selectedItemId }),
        ...(this.view.selectedTransitionId === undefined
          ? {}
          : { transitionId: this.view.selectedTransitionId }),
      };
    }
    const drop = target.closest<HTMLElement>('[data-drop]')?.dataset.drop;
    if (drop !== undefined) return { kind: 'library-tile', drop };
    if (this.#els.library.contains(target)) return { kind: 'library' };
    if (requiredElement('.viewer').contains(target) && !this.#els.timeline.contains(target)) {
      return { kind: 'monitor' };
    }
    if (this.#els.timeline.contains(target)) {
      const timeUs = hitTimeFromEvent(event, this.#els.timeline, this.view);
      const markerId = target.closest<HTMLElement>('[data-marker]')?.dataset.marker;
      if (markerId !== undefined) {
        this.view.selectedMarkerId = markerId;
        this.view.selectedItemId = undefined;
        this.view.selectedTransitionId = undefined;
        this.scheduleRender();
        return { kind: 'marker', markerId, timeUs };
      }
      const transitionId = target.closest<HTMLElement>('[data-transition]')?.dataset.transition;
      if (transitionId !== undefined) {
        this.view.selectedTransitionId = transitionId;
        this.view.selectedItemId = undefined;
        this.view.selectedMarkerId = undefined;
        this.view.selectedTrackId = target.closest<HTMLElement>('[data-track]')?.dataset.track;
        this.scheduleRender();
        return {
          kind: 'transition',
          transitionId,
          timeUs,
          ...(this.view.selectedTrackId === undefined ? {} : { trackId: this.view.selectedTrackId }),
        };
      }
      const itemId = target.closest<HTMLElement>('[data-item]')?.dataset.item;
      if (itemId !== undefined) {
        this.view.selectedItemId = itemId;
        this.view.selectedTransitionId = undefined;
        this.view.selectedMarkerId = undefined;
        this.view.selectedTrackId = target.closest<HTMLElement>('[data-track]')?.dataset.track;
        this.scheduleRender();
        return {
          kind: 'clip',
          itemId,
          timeUs,
          ...(this.view.selectedTrackId === undefined ? {} : { trackId: this.view.selectedTrackId }),
        };
      }
      const trackId = target.closest<HTMLElement>('[data-track]')?.dataset.track;
      if (trackId !== undefined) {
        this.view.selectedTrackId = trackId;
        this.scheduleRender();
        return { kind: 'track', trackId, timeUs };
      }
      return { kind: 'timeline', timeUs };
    }
    return { kind: 'app' };
  }

  #contextItems(hit: ContextTarget): ContextMenuEntry[] {
    const canUndo = this.engine.session?.transaction.canUndo === true;
    const canRedo = this.engine.session?.transaction.canRedo === true;
    const playing = this.engine.session?.player.state === 'playing';
    const edit = [
      menuItem('undo', '撤销', { shortcut: 'Ctrl+Z', disabled: !canUndo }),
      menuItem('redo', '重做', { shortcut: 'Ctrl+Y', disabled: !canRedo }),
    ];
    if (hit.kind === 'dialog') return [menuItem('dialog-close', '关闭')];
    if (hit.kind === 'home-project') {
      return [
        menuItem('open-project', '打开'),
        menuSep,
        menuItem('delete-project', '删除工程', { danger: true }),
      ];
    }
    if (hit.kind === 'home') {
      return [menuItem('new', '新建项目'), menuItem('import', '导入媒体…')];
    }
    if (hit.kind === 'library-tile' && hit.drop !== undefined) {
      if (hit.drop.startsWith('effect:')) {
        return [
          menuItem('apply-drop', '应用到所选片段', {
            disabled: this.view.selectedItemId === undefined,
          }),
        ];
      }
      if (hit.drop.startsWith('transition:')) {
        return [
          menuItem('apply-drop', '应用到所选接头', {
            disabled: this.view.selectedItemId === undefined,
          }),
        ];
      }
      return [
        menuItem('apply-drop', '添加到时间线'),
        ...(hit.drop.startsWith('asset:') || hit.drop.startsWith('audio:')
          ? [
              menuItem('rename-asset', '重命名'),
              menuSep,
              menuItem('delete-asset', '删除', { danger: true }),
            ]
          : []),
        menuSep,
        menuItem('import', '导入媒体…'),
        menuItem('import-url', '从 URL 导入…'),
      ];
    }
    if (hit.kind === 'library') {
      return [
        menuItem('import', '导入媒体…'),
        menuItem('import-url', '从 URL 导入…'),
        menuSep,
        menuItem('lib-view', this.view.libraryView === 'grid' ? '列表视图' : '网格视图'),
      ];
    }
    if (hit.kind === 'clip' && hit.itemId !== undefined) {
      const item = this.engine.project?.items[hit.itemId];
      const inside =
        item !== undefined &&
        this.view.currentTimeUs > item.range.startUs &&
        this.view.currentTimeUs < item.range.startUs + item.range.durationUs;
      return [
        ...edit,
        menuSep,
        menuItem('split', '分割', { shortcut: 'S', disabled: !inside }),
        menuItem('freeze', '定格'),
        menuItem('transition-dissolve', '交叉叠化'),
        menuSep,
        menuItem('toggle-item', item?.enabled === false ? '启用' : '禁用'),
        menuItem('marker-here', '在此处打点', { shortcut: 'M' }),
        menuItem('delete', '删除', { shortcut: 'Del' }),
        menuItem('ripple-delete', '波纹删除'),
      ];
    }
    if (hit.kind === 'marker') {
      return [menuItem('delete-marker', '删除打点', { shortcut: 'Del', danger: true })];
    }
    if (hit.kind === 'transition') {
      return [
        menuItem('delete-transition', '删除转场', { shortcut: 'Del', danger: true }),
        menuSep,
        ...edit,
      ];
    }
    if (hit.kind === 'track' && hit.trackId !== undefined) {
      const track = this.engine.project?.tracks[hit.trackId];
      const audio = track?.kind === 'audio';
      return [
        menuItem('seek-here', '播放头移到此处'),
        menuItem('marker-here', '在此处打点'),
        menuItem('import', '导入到此轨道…'),
        menuSep,
        ...(audio
          ? [
              menuItem('track-mute', track?.audio?.muted === true ? '取消静音' : '静音'),
              menuItem('track-solo', track?.audio?.solo === true ? '取消独奏' : '独奏'),
            ]
          : [menuItem('track-enable', track?.enabled === false ? '显示轨道' : '隐藏轨道')]),
        menuItem('track-lock', track?.locked === true ? '解锁轨道' : '锁定轨道'),
        menuSep,
        menuItem('add-v', '添加视频轨'),
        menuItem('add-a', '添加音频轨'),
        menuItem('add-c', '添加字幕轨'),
        menuItem('remove-track', '删除轨道', {
          danger: true,
          disabled: !canRemoveTrack(this.engine, hit.trackId),
        }),
      ];
    }
    if (hit.kind === 'timeline') {
      return [
        menuItem('seek-here', '播放头移到此处'),
        menuItem('marker-here', '在此处打点', { shortcut: 'M' }),
        menuSep,
        menuItem('snap', '吸附', { checked: this.view.snap }),
        menuItem('ripple', '波纹编辑', { checked: this.view.ripple }),
        menuItem('zoom-in', '放大时间线'),
        menuItem('zoom-out', '缩小时间线'),
        menuSep,
        menuItem('add-v', '添加视频轨'),
        menuItem('add-a', '添加音频轨'),
        menuItem('add-c', '添加字幕轨'),
      ];
    }
    if (hit.kind === 'monitor') {
      return [
        menuItem('play', playing ? '暂停' : '播放', { shortcut: 'Space' }),
        menuItem('to-start', '到开头', { shortcut: 'Home' }),
        menuItem('to-end', '到结尾', { shortcut: 'End' }),
        menuSep,
        menuItem('safe-area', '安全框', { checked: this.view.showSafeArea }),
        menuItem('program-snap', '画面吸附', { checked: this.view.programSnap }),
        menuItem('export', '导出…'),
      ];
    }
    if (hit.kind === 'inspector-effect') {
      return [
        menuItem('remove-effect', '删除效果', { danger: true }),
        menuSep,
        ...(hit.itemId === undefined
          ? []
          : [menuItem('delete', '删除片段', { shortcut: 'Del' })]),
      ];
    }
    if (hit.kind === 'inspector' && hit.transitionId !== undefined) {
      return [menuItem('delete-transition', '删除转场', { danger: true })];
    }
    if (hit.kind === 'inspector' && hit.itemId !== undefined) {
      return [
        menuItem('split', '分割', { shortcut: 'S' }),
        menuItem('freeze', '定格'),
        menuItem('delete', '删除', { shortcut: 'Del' }),
      ];
    }
    return [
      ...edit,
      menuSep,
      menuItem('import', '导入媒体…'),
      menuItem('save', '保存草稿'),
      menuItem('export', '导出…'),
      menuSep,
      menuItem('projects', '全部项目'),
      menuItem('shortcuts', '快捷键'),
    ];
  }

  #runContext(id: string, hit: ContextTarget): void {
    if (id === 'dialog-close') {
      document.querySelectorAll('dialog[open]').forEach(node => {
        if (node instanceof HTMLDialogElement) node.close();
      });
      return;
    }
    if (id === 'open-project' && hit.projectId !== undefined) {
      location.hash = editorHash(hit.projectId);
      return;
    }
    if (id === 'delete-project' && hit.projectId !== undefined) {
      void this.#deleteProject(hit.projectId);
      return;
    }
    if (id === 'import') {
      this.#importTarget =
        hit.trackId === undefined
          ? undefined
          : {
              preferredTrackId: hit.trackId,
              lockTrack: true,
              ...(hit.timeUs === undefined ? {} : { atUs: hit.timeUs }),
            };
      this.#els.fileMedia.click();
      return;
    }
    if (id === 'remove-track' && hit.trackId !== undefined) {
      const track = this.engine.project?.tracks[hit.trackId];
      const count = track?.itemIds.length ?? 0;
      if (count > 0 && !window.confirm(`删除轨道及其中的 ${count} 个片段？`)) return;
      this.run('删除轨道', () => {
        removeTrack(this.engine, hit.trackId as string);
        if (this.view.selectedTrackId === hit.trackId) this.view.selectedTrackId = undefined;
      });
      return;
    }
    if (id === 'apply-drop' && hit.drop !== undefined) {
      this.#applyDrop(hit.drop, this.view.currentTimeUs, this.view.selectedTrackId, false);
      return;
    }
    if (
      id === 'rename-asset' &&
      (hit.drop?.startsWith('asset:') === true || hit.drop?.startsWith('audio:') === true)
    ) {
      this.#openRenameAsset(hit.drop.slice(hit.drop.indexOf(':') + 1));
      return;
    }
    if (
      id === 'delete-asset' &&
      (hit.drop?.startsWith('asset:') === true || hit.drop?.startsWith('audio:') === true)
    ) {
      this.#deleteLibraryAsset(hit.drop.slice(hit.drop.indexOf(':') + 1));
      return;
    }
    if (id === 'lib-view') {
      this.#action('lib-view', this.#els.library);
      return;
    }
    if (id === 'seek-here' && hit.timeUs !== undefined) {
      void this.#seek(hit.timeUs);
      return;
    }
    if (id === 'marker-here') {
      this.#placeMarker(hit.timeUs ?? this.view.currentTimeUs, {
        ...(hit.itemId === undefined ? {} : { itemId: hit.itemId }),
        ...(hit.trackId === undefined ? {} : { trackId: hit.trackId }),
        looseItem: hit.kind === 'clip',
      });
      return;
    }
    if (id === 'delete-marker' && hit.markerId !== undefined) {
      this.#deleteMarker(hit.markerId);
      return;
    }
    if (id === 'play') {
      void this.#togglePlay();
      return;
    }
    if (id === 'to-start') {
      void this.#seek(0);
      return;
    }
    if (id === 'to-end') {
      void this.#seek(Math.max(0, this.engine.renderDurationUs - 1));
      return;
    }
    if (id === 'toggle-item' && hit.itemId !== undefined) {
      const item = this.engine.project?.items[hit.itemId];
      if (item === undefined) return;
      this.run(item.enabled === false ? '启用' : '禁用', () =>
        setItemEnabled(this.engine, hit.itemId as string, item.enabled === false),
      );
      return;
    }
    if (id === 'remove-effect' && hit.itemId !== undefined && hit.effectId !== undefined) {
      this.run('删除效果', () => removeEffect(this.engine, hit.itemId as string, hit.effectId as string));
      return;
    }
    if (id.startsWith('track-') && hit.trackId !== undefined && this.engine.session !== undefined) {
      const track = this.engine.project?.tracks[hit.trackId];
      if (id === 'track-mute') {
        this.engine.session.transaction.commands.setTrackMuted({
          trackId: hit.trackId,
          value: track?.audio?.muted !== true,
        });
      } else if (id === 'track-solo') {
        this.engine.session.transaction.commands.setTrackSolo({
          trackId: hit.trackId,
          value: track?.audio?.solo !== true,
        });
      } else if (id === 'track-lock') {
        this.engine.session.transaction.commands.setTrackLocked({
          trackId: hit.trackId,
          value: track?.locked !== true,
        });
      } else if (id === 'track-enable') {
        this.engine.session.transaction.commands.setTrackEnabled({
          trackId: hit.trackId,
          value: track?.enabled !== true,
        });
      }
      this.scheduleRender();
      return;
    }
    if (
      id === 'snap' ||
      id === 'program-snap' ||
      id === 'ripple' ||
      id === 'safe-area' ||
      id === 'zoom-in' ||
      id === 'zoom-out' ||
      id === 'freeze' ||
      id === 'transition-dissolve' ||
      id === 'delete-transition'
    ) {
      this.#action(id, this.#els.studio);
      return;
    }
    this.#command(id);
  }

  #setPressed(id: string, on: boolean): void {
    const button = document.getElementById(id);
    if (!(button instanceof HTMLButtonElement)) return;
    button.classList.toggle('on', on);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  #onClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const summary = target.closest('details');
    const cmd = target.closest<HTMLElement>('[data-cmd]');
    if (cmd?.dataset.cmd !== undefined) {
      event.preventDefault();
      this.#command(cmd.dataset.cmd);
      summary?.removeAttribute('open');
      return;
    }
    const tool = target.closest<HTMLElement>('[data-tool]');
    if (tool?.dataset.tool !== undefined) {
      this.view.tool = tool.dataset.tool as EditTool;
      this.scheduleRender();
      return;
    }
    const libTab = target.closest<HTMLElement>('#library [data-tab]');
    if (libTab?.dataset.tab !== undefined) {
      this.view.libraryTab = libTab.dataset.tab as LibraryTab;
      this.scheduleRender();
      return;
    }
    const inspTab = target.closest<HTMLElement>('#inspector [data-tab]');
    if (inspTab?.dataset.tab !== undefined) {
      this.view.inspectorTab = inspTab.dataset.tab as InspectorTab;
      this.scheduleRender();
      return;
    }
    const act = target.closest<HTMLElement>('[data-act]');
    if (act?.dataset.act !== undefined) this.#action(act.dataset.act, act);
  }

  #command(name: string): void {
    this.#commitInspectorGesture();
    if (name === 'projects') {
      location.hash = HOME_HASH;
      return;
    }
    if (name === 'new') {
      this.#els.dialogNew.showModal();
      return;
    }
    if (name === 'import') {
      this.#importTarget = undefined;
      this.#els.fileMedia.click();
      return;
    }
    if (name === 'import-url') {
      this.#els.dialogUrl.showModal();
      return;
    }
    if (name === 'save') {
      this.run('已保存', () => this.engine.persistence?.flush());
      return;
    }
    if (name === 'export') {
      this.#syncExportForm();
      this.#els.exportProgress.style.width = '0';
      requiredElement('#export-progress-track').hidden = true;
      this.#els.dialogExport.showModal();
      return;
    }
    if (name === 'export-json') {
      const project = this.engine.project;
      if (project === null) return;
      downloadText(JSON.stringify(project, null, 2), 'project.json', 'application/json');
      this.setStatus('已导出 JSON');
      return;
    }
    if (name === 'undo') {
      if (this.engine.session?.transaction.canUndo === true) {
        this.engine.session.transaction.undo();
        this.run('撤销', () => undefined);
      }
      return;
    }
    if (name === 'redo') {
      if (this.engine.session?.transaction.canRedo === true) {
        this.engine.session.transaction.redo();
        this.run('重做', () => undefined);
      }
      return;
    }
    if (name === 'split') {
      let id = this.view.selectedItemId;
      if (id === undefined && this.view.selectedMarkerId !== undefined) {
        const marker = this.engine.project?.markers[this.view.selectedMarkerId];
        if (marker?.owner.type === 'item') id = marker.owner.id;
      }
      if (id === undefined) return;
      this.run('分割', () => {
        const right = splitAt(this.engine, id, this.view.currentTimeUs);
        if (right !== undefined) this.view.selectedItemId = right;
      });
      return;
    }
    if (name === 'delete' || name === 'ripple-delete') {
      const markerId = this.view.selectedMarkerId;
      if (markerId !== undefined) {
        this.#deleteMarker(markerId);
        return;
      }
      const transitionId = this.view.selectedTransitionId;
      if (transitionId !== undefined) {
        this.run('删除转场', () => {
          removeTransition(this.engine, transitionId);
          this.view.selectedTransitionId = undefined;
        });
        return;
      }
      const id = this.view.selectedItemId;
      if (id === undefined) return;
      this.run('删除', () => {
        deleteSelection(this.engine, id, name === 'ripple-delete' || this.view.ripple);
        this.view.selectedItemId = undefined;
      });
      return;
    }
    if (name === 'add-v') this.run('添加视频轨', () => void addTrack(this.engine, 'visual'));
    if (name === 'add-a') this.run('添加音频轨', () => void addTrack(this.engine, 'audio'));
    if (name === 'add-c') this.run('添加字幕轨', () => void addTrack(this.engine, 'caption'));
    if (name === 'marker') {
      this.#placeMarker(this.view.currentTimeUs, {
        ...(this.view.selectedItemId === undefined ? {} : { itemId: this.view.selectedItemId }),
        ...(this.view.selectedTrackId === undefined ? {} : { trackId: this.view.selectedTrackId }),
      });
    }
    if (name === 'diagnostics') this.#showDiagnostics();
    if (name === 'capability') void this.#showCapability();
    if (name === 'shortcuts') this.#showInfo('快捷键', SHORTCUTS);
    if (name === 'import-opfs') {
      this.setStatus('导入后会自动保存');
    }
  }

  #action(name: string, node: HTMLElement): void {
    const itemId = this.view.selectedItemId;
    if (name === 'lib-view') {
      this.view.libraryView = this.view.libraryView === 'grid' ? 'list' : 'grid';
      this.scheduleRender();
      return;
    }
    if (name === 'lib-sort') {
      this.view.librarySort = this.view.librarySort === 'az' ? 'za' : 'az';
      this.scheduleRender();
      return;
    }
    if (name === 'snap') {
      this.view.snap = !this.view.snap;
      this.scheduleRender();
      return;
    }
    if (name === 'program-snap') {
      this.view.programSnap = !this.view.programSnap;
      this.scheduleRender();
      return;
    }
    if (name === 'linked') {
      const enabling = !this.view.linkedEdit;
      this.view.linkedEdit = enabling;
      const item =
        this.view.selectedItemId === undefined
          ? undefined
          : this.engine.project?.items[this.view.selectedItemId];
      if (enabling && item?.linkGroupId !== undefined) {
        this.run('对齐联动', () => realignLinkGroup(this.engine, item.linkGroupId as string, item.id));
        return;
      }
      this.scheduleRender();
      return;
    }
    if (name === 'ripple') {
      this.view.ripple = !this.view.ripple;
      this.scheduleRender();
      return;
    }
    if (name === 'safe-area') {
      this.view.showSafeArea = !this.view.showSafeArea;
      this.scheduleRender();
      return;
    }
    if (name === 'zoom-in') {
      this.#zoom(1.25);
      return;
    }
    if (name === 'zoom-out') {
      this.#zoom(0.8);
      return;
    }
    if (name === 'freeze') {
      if (itemId === undefined) {
        this.setStatus('先选中片段', true);
        return;
      }
      this.run('定格', () => freezeFrame(this.engine, itemId));
      return;
    }
    if (name === 'import-sub') {
      this.#els.fileSub.click();
      return;
    }
    if (name === 'export-srt' || name === 'export-vtt') {
      const project = this.engine.project;
      if (project === null) return;
      const trackId = firstTrackId(project, 'caption');
      if (trackId === undefined) {
        this.setStatus('没有字幕轨', true);
        return;
      }
      try {
        const result = exportSubtitleTrack(project, trackId, name === 'export-srt' ? 'srt' : 'vtt');
        downloadText(
          result.text,
          name === 'export-srt' ? 'captions.srt' : 'captions.vtt',
          'text/plain',
        );
        this.setStatus(`已导出 ${result.cueCount} 条字幕`);
      } catch (error) {
        this.setStatus(errorMessage(error, '字幕导出失败'), true);
      }
      return;
    }
    const trackId = node.closest<HTMLElement>('[data-track]')?.dataset.track;
    if (trackId !== undefined && this.engine.session !== undefined) {
      if (name === 'mute') {
        const track = this.engine.project?.tracks[trackId];
        this.engine.session.transaction.commands.setTrackMuted({
          trackId,
          value: track?.audio?.muted !== true,
        });
        this.scheduleRender();
        return;
      }
      if (name === 'solo') {
        const track = this.engine.project?.tracks[trackId];
        this.engine.session.transaction.commands.setTrackSolo({
          trackId,
          value: track?.audio?.solo !== true,
        });
        this.scheduleRender();
        return;
      }
      if (name === 'lock') {
        const track = this.engine.project?.tracks[trackId];
        this.engine.session.transaction.commands.setTrackLocked({
          trackId,
          value: track?.locked !== true,
        });
        this.scheduleRender();
        return;
      }
      if (name === 'enable') {
        const track = this.engine.project?.tracks[trackId];
        this.engine.session.transaction.commands.setTrackEnabled({
          trackId,
          value: track?.enabled !== true,
        });
        this.scheduleRender();
        return;
      }
    }
    if (name === 'remove-effect') {
      const instanceId = node.dataset.effect;
      if (itemId === undefined || instanceId === undefined) return;
      this.run('删除效果', () => removeEffect(this.engine, itemId, instanceId));
      return;
    }
    if (name === 'delete-transition') {
      const transitionId = this.view.selectedTransitionId;
      if (transitionId === undefined) return;
      this.run('删除转场', () => {
        removeTransition(this.engine, transitionId);
        this.view.selectedTransitionId = undefined;
      });
      return;
    }
    if (itemId === undefined) return;
    if (name === 'loudness') void this.#analyzeLoudness();
    if (name === 'silence') void this.#detectSilence(false);
    if (name === 'remove-silence') void this.#detectSilence(true);
    if (name === 'beats') void this.#markBeats();
    if (name === 'energy') void this.#markEnergy();
    if (name === 'transition-dissolve') {
      this.run('叠化', () => {
        this.view.selectedTransitionId = applyTransition(this.engine, itemId, 'diffusion-dissolve');
        this.view.selectedItemId = undefined;
      });
    }
  }

  #onChange(event: Event): void {
    const target = event.target;
    if (
      !(target instanceof HTMLInputElement) &&
      !(target instanceof HTMLSelectElement) &&
      !(target instanceof HTMLTextAreaElement)
    ) {
      return;
    }
    if (target.id === 'new-preset' || target.id === 'new-title') return;
    if (target.closest('#dialog-new') !== null) return;
    if (target instanceof HTMLInputElement && target.type === 'range') {
      this.#commitInspectorGesture();
      return;
    }
    this.#applyInspector(target);
  }

  #onInput(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.dataset.bind === undefined) return;
    if (target.type === 'range') {
      this.#beginInspectorGesture();
      this.#applyInspector(target);
      return;
    }
    if (target.type === 'color') this.#applyInspector(target);
  }

  #beginInspectorGesture(): void {
    if (this.#inspectorEdit?.active === true) return;
    this.#inspectorEdit = this.engine.beginGesture('属性');
  }

  #commitInspectorGesture(): void {
    if (this.#inspectorEdit === undefined) return;
    this.engine.endGesture();
    this.#inspectorEdit = undefined;
    this.#inspectorKey = '';
    this.setStatus('属性');
    this.#restorePreviewSharpness();
    this.scheduleRender();
    this.#refreshPreview();
  }

  #syncInspectorControl(target: HTMLInputElement): void {
    const bind = target.dataset.bind;
    if (bind === undefined) return;
    const scope = target.closest('.effect-card') ?? this.#els.inspector;
    scope.querySelectorAll<HTMLInputElement>(`[data-bind="${bind}"]`).forEach(node => {
      if (node !== target) node.value = target.value;
    });
  }

  #applyInspector(target: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): void {
    const bind = target.dataset.bind;
    if (bind === 'transition-duration' && this.view.selectedTransitionId !== undefined) {
      const numeric =
        target instanceof HTMLInputElement && target.type !== 'checkbox' ? Number(target.value) : 0;
      if (
        target instanceof HTMLInputElement &&
        (target.type === 'range' || target.type === 'number')
      ) {
        this.#syncInspectorControl(target);
      }
      const live = this.#inspectorEdit?.active === true ? this.#inspectorEdit : undefined;
      const apply = (): void => {
        setTransitionDuration(
          this.engine,
          this.view.selectedTransitionId ?? '',
          Math.round(numeric * 1_000_000),
          live,
        );
      };
      if (live !== undefined) {
        apply();
        void this.engine.preview?.render(this.view.currentTimeUs);
        return;
      }
      this.run('转场时长', apply);
      return;
    }
    const itemId = this.view.selectedItemId;
    if (itemId === undefined || bind === undefined) return;
    if (bind === 'effect-value') {
      const instanceId = target.dataset.effect;
      const numeric =
        target instanceof HTMLInputElement && target.type !== 'checkbox' ? Number(target.value) : 0;
      if (
        target instanceof HTMLInputElement &&
        (target.type === 'range' || target.type === 'number')
      ) {
        this.#syncInspectorControl(target);
      }
      if (instanceId === undefined) return;
      const live = this.#inspectorEdit?.active === true ? this.#inspectorEdit : undefined;
      const apply = (): void => {
        setEffectValue(this.engine, instanceId, numeric, live);
      };
      if (live !== undefined) {
        apply();
        void this.engine.preview?.render(this.view.currentTimeUs);
        return;
      }
      this.run('效果强度', apply);
      return;
    }
    const numeric =
      target instanceof HTMLInputElement && target.type !== 'checkbox' ? Number(target.value) : 0;
    const item = selected(this.engine.project, itemId);
    const live = this.#inspectorEdit?.active === true ? this.#inspectorEdit : undefined;
    if (
      target instanceof HTMLInputElement &&
      (target.type === 'range' || target.type === 'number')
    ) {
      this.#syncInspectorControl(target);
    }
    const apply = (): void => {
      if (bind === 'text' && target instanceof HTMLTextAreaElement) {
        setTextContent(this.engine, itemId, target.value);
      }
      if (bind === 'enabled' && target instanceof HTMLInputElement) {
        setItemEnabled(this.engine, itemId, target.checked);
      }
      if (bind === 'fill' && target instanceof HTMLInputElement) {
        setShapeFill(this.engine, itemId, target.value, live);
      }
      if (bind === 'fontFamily') {
        patchTextStyle(this.engine, itemId, { fontFamilies: fontPresetFamilies(target.value) });
      }
      if (bind === 'fontSize') {
        patchTextStyle(this.engine, itemId, { fontSizePx: Math.max(1, numeric) }, live);
      }
      if (bind === 'fontBold' && target instanceof HTMLInputElement) {
        patchTextStyle(this.engine, itemId, { fontWeight: target.checked ? 700 : 400 });
      }
      if (bind === 'fontItalic' && target instanceof HTMLInputElement) {
        patchTextStyle(this.engine, itemId, {
          fontStyle: target.checked ? 'italic' : 'normal',
        });
      }
      if (bind === 'textFill' && target instanceof HTMLInputElement) {
        patchTextStyle(this.engine, itemId, { fill: target.value }, live);
      }
      if (bind === 'textStroke' && target instanceof HTMLInputElement) {
        patchTextStyle(this.engine, itemId, { stroke: target.value }, live);
      }
      if (bind === 'strokeWidth') {
        patchTextStyle(this.engine, itemId, { strokeWidthPx: Math.max(0, numeric) }, live);
      }
      if (
        bind === 'textAlign' &&
        (target.value === 'start' || target.value === 'center' || target.value === 'end')
      ) {
        patchTextStyle(this.engine, itemId, { align: target.value });
      }
      if (bind === 'textBackground' && target instanceof HTMLInputElement) {
        const current = item === undefined ? undefined : readItemTextStyle(item);
        patchTextStyle(
          this.engine,
          itemId,
          {
            backgroundFill: target.value,
            ...((current?.backgroundOpacity ?? 0) < 0.01 ? { backgroundOpacity: 0.75 } : {}),
          },
          live,
        );
      }
      if (bind === 'backgroundOpacity') {
        patchTextStyle(
          this.engine,
          itemId,
          { backgroundOpacity: Math.max(0, Math.min(1, numeric)) },
          live,
        );
      }
      if (bind === 'opacity') patchVisual(this.engine, itemId, { opacity: numeric }, live);
      if ((bind === 'scaleX' || bind === 'scaleY') && item !== undefined) {
        const { scale } = readTransform(item);
        patchVisual(
          this.engine,
          itemId,
          {
            scale: bind === 'scaleX' ? { x: numeric, y: scale.y } : { x: scale.x, y: numeric },
          },
          live,
        );
      }
      if ((bind === 'posX' || bind === 'posY') && item !== undefined) {
        const { positionPx } = readTransform(item);
        patchVisual(
          this.engine,
          itemId,
          {
            positionPx:
              bind === 'posX' ? { x: numeric, y: positionPx.y } : { x: positionPx.x, y: numeric },
          },
          live,
        );
      }
      if (bind === 'rotation') patchVisual(this.engine, itemId, { rotationDeg: numeric }, live);
      if (
        bind === 'fit' &&
        (target.value === 'contain' ||
          target.value === 'cover' ||
          target.value === 'fill' ||
          target.value === 'none')
      ) {
        patchVisual(this.engine, itemId, { fit: target.value });
      }
      if (
        bind === 'blend' &&
        (target.value === 'normal' ||
          target.value === 'multiply' ||
          target.value === 'screen' ||
          target.value === 'overlay' ||
          target.value === 'darken' ||
          target.value === 'lighten')
      ) {
        patchVisual(this.engine, itemId, { blendMode: target.value });
      }
      const mixerId =
        this.engine.project === null || item === undefined
          ? itemId
          : (linkedMixerItem(this.engine.project, item)?.id ?? itemId);
      if (bind === 'gainDb') patchAudio(this.engine, mixerId, { gainDb: numeric }, live);
      if (bind === 'pan') patchAudio(this.engine, mixerId, { pan: numeric }, live);
      if (bind === 'fadeInMs') {
        patchAudio(this.engine, mixerId, { fadeInUs: Math.round(numeric * 1000) }, live);
      }
      if (bind === 'fadeOutMs') {
        patchAudio(this.engine, mixerId, { fadeOutUs: Math.round(numeric * 1000) }, live);
      }
      if (bind === 'pitch' && (target.value === 'varispeed' || target.value === 'preserve')) {
        patchAudio(this.engine, mixerId, { pitchPolicy: target.value });
      }
      if (bind === 'rate') {
        const mapping = item === undefined ? undefined : itemSource(item)?.timeMapping;
        const reverse =
          mapping !== null &&
          typeof mapping === 'object' &&
          !Array.isArray(mapping) &&
          (mapping as { reverse?: unknown }).reverse === true;
        setSpeed(this.engine, itemId, numeric, reverse, live);
      }
      if (bind === 'reverse' && target instanceof HTMLInputElement) {
        setSpeed(this.engine, itemId, 1, target.checked);
      }
    };
    if (live !== undefined) {
      apply();
      void this.engine.preview?.render(this.view.currentTimeUs);
      return;
    }
    this.run('属性', apply);
  }

  #onLibraryDrag(event: DragEvent): void {
    const drop = (event.target as Element | null)?.closest<HTMLElement>('[data-drop]');
    if (drop?.dataset.drop === undefined || event.dataTransfer === null) return;
    event.dataTransfer.setData('text/aelion-drop', drop.dataset.drop);
    event.dataTransfer.effectAllowed = 'copy';
  }

  #onLibraryDragOver(event: DragEvent): void {
    if (!isLibraryPayloadDrag(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'none';
  }

  #onLibraryDrop(event: DragEvent): void {
    if (!isLibraryPayloadDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
  }

  #onStudioDragOver(event: DragEvent): void {
    if (event.target instanceof Node && this.#els.timeline.contains(event.target)) return;
    if (isLibraryPayloadDrag(event.dataTransfer)) {
      event.preventDefault();
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'none';
      return;
    }
    if (event.dataTransfer?.types.includes('Files') === true) event.preventDefault();
  }

  #onStudioDrop(event: DragEvent): void {
    if (isLibraryPayloadDrag(event.dataTransfer)) {
      event.preventDefault();
      return;
    }
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length === 0) return;
    event.preventDefault();
    this.#ignoreTransportKeysUntil = performance.now() + 800;
    this.#importFiles(files);
  }

  #onTimelineDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    const payload = event.dataTransfer?.getData('text/aelion-drop') ?? '';
    const timeUs = hitTimeFromEvent(
      event as unknown as PointerEvent,
      this.#els.timeline,
      this.view,
    );
    const over = document.elementFromPoint(event.clientX, event.clientY);
    const fromEvent = event.target instanceof Element ? event.target : null;
    const trackId =
      over?.closest<HTMLElement>('[data-track]')?.dataset.track ??
      fromEvent?.closest<HTMLElement>('[data-track]')?.dataset.track;
    if (payload.length > 0) {
      const sourceItemId =
        over?.closest<HTMLElement>('[data-item]')?.dataset.item ??
        fromEvent?.closest<HTMLElement>('[data-item]')?.dataset.item;
      this.#applyDrop(payload, timeUs, trackId, true, sourceItemId);
      return;
    }
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length > 0) {
      this.#importFiles(files, timeUs, {
        ...(trackId === undefined ? {} : { preferredTrackId: trackId, lockTrack: true }),
      });
    }
  }

  #onLibraryDblClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const drop = target.closest<HTMLElement>('[data-drop]');
    if (drop?.dataset.drop === undefined) return;
    event.preventDefault();
    this.#applyDrop(drop.dataset.drop, this.view.currentTimeUs, this.view.selectedTrackId, false);
  }

  #applyDrop(
    payload: string,
    atUs: number,
    trackId: string | undefined,
    lockTrack: boolean,
    sourceItemId?: string,
  ): void {
    if (payload.startsWith('asset:') || payload.startsWith('audio:')) {
      this.run('放置素材', () => {
        const id = insertExistingAsset(
          this.engine,
          payload.slice(payload.indexOf(':') + 1),
          atUs,
          trackId,
          {
            lockTrack,
            ...(payload.startsWith('audio:') ? { stream: 'audio' as const } : {}),
          },
        );
        if (id !== undefined) this.view.selectedItemId = id;
      });
      return;
    }
    if (payload.startsWith('effect:')) {
      const project = this.engine.project;
      const hovered =
        sourceItemId === undefined || project === null ? undefined : project.items[sourceItemId];
      const atItem =
        hovered === undefined && project !== null && trackId !== undefined
          ? itemAtTime(project, trackId, atUs)
          : hovered;
      const itemId = atItem?.id ?? this.view.selectedItemId;
      if (itemId === undefined) {
        this.setStatus('把效果拖到片段上', true);
        return;
      }
      this.view.selectedItemId = itemId;
      this.view.inspectorTab = 'effect';
      this.#inspectorKey = '';
      this.run('效果', () => {
        applyEffect(this.engine, itemId, payload.slice(7));
      });
      return;
    }
    if (payload.startsWith('transition:')) {
      const project = this.engine.project;
      const hovered =
        sourceItemId === undefined || project === null ? undefined : project.items[sourceItemId];
      const atItem =
        hovered === undefined && project !== null && trackId !== undefined
          ? itemAtTime(project, trackId, atUs)
          : hovered;
      const itemId = atItem?.id ?? this.view.selectedItemId;
      if (itemId === undefined) {
        this.setStatus('把转场拖到接头上', true);
        return;
      }
      this.run('转场', () => {
        this.view.selectedTransitionId = applyTransition(this.engine, itemId, payload.slice(11));
        this.view.selectedItemId = undefined;
      });
      return;
    }
    this.run('添加图层', () => {
      const id = insertGenerated(
        this.engine,
        payload as Exclude<
          LibraryDropKind,
          `asset:${string}` | `effect:${string}` | `transition:${string}`
        >,
        atUs,
        trackId,
        { lockTrack },
      );
      this.view.selectedItemId = id;
    });
  }

  #onTimelinePointerDown(event: PointerEvent): void {
    this.#commitInspectorGesture();
    if (event.button !== 0) return;
    if (isTimelineScrollbarHit(event, this.#els.timeline)) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const flag = target.closest('[data-act]');
    if (flag !== null) return;
    const markerNode = target.closest<HTMLElement>('[data-marker]');
    const hostItemFromMarker = markerNode?.dataset.item;
    if (markerNode?.dataset.marker !== undefined && hostItemFromMarker === undefined) {
      this.view.selectedMarkerId = markerNode.dataset.marker;
      this.view.selectedItemId = undefined;
      this.view.selectedTransitionId = undefined;
      this.scheduleRender();
      return;
    }
    const transitionNode = target.closest<HTMLElement>('[data-transition]');
    const itemNode = target.closest<HTMLElement>('[data-item]');
    const trackNode = target.closest<HTMLElement>('[data-track]');
    const timeUs = hitTimeFromEvent(event, this.#els.timeline, this.view);
    if (transitionNode?.dataset.transition !== undefined) {
      const transitionId = transitionNode.dataset.transition;
      const transition = this.engine.project?.transitions[transitionId];
      this.view.selectedTransitionId = transitionId;
      this.view.selectedItemId = undefined;
      this.view.selectedMarkerId = undefined;
      this.view.selectedTrackId = transitionNode.dataset.track;
      if (transition !== undefined && this.view.tool === 'select') {
        void this.#seek(transition.range.startUs);
      }
      const edge = target.closest<HTMLElement>('[data-edge]')?.dataset.edge;
      if (
        this.view.tool === 'select' &&
        (edge === 'start' || edge === 'end') &&
        transition !== undefined
      ) {
        this.engine.beginGesture('调整转场');
        this.#gesture = {
          kind: 'transition-trim',
          itemId: transitionId,
          trackId: transition.trackId,
          edge,
          originUs: timeUs,
          startUs: transition.range.startUs,
          durationUs: transition.range.durationUs,
          pointerId: event.pointerId,
          historyGroup: `transition-${transitionId}`,
        };
        this.#els.timeline.setPointerCapture(event.pointerId);
      }
      this.scheduleRender();
      return;
    }
    if (target.closest('[data-role="ruler"]') !== null || itemNode === null) {
      this.view.selectedTrackId = trackNode?.dataset.track;
      if (itemNode === null) {
        this.view.selectedTransitionId = undefined;
        this.view.selectedMarkerId = undefined;
        void this.#seek(timeUs);
        this.#gesture = {
          kind: 'playhead',
          itemId: '',
          trackId: trackNode?.dataset.track ?? '',
          originUs: timeUs,
          startUs: 0,
          durationUs: 0,
          pointerId: event.pointerId,
          historyGroup: 'playhead',
        };
        this.#els.timeline.setPointerCapture(event.pointerId);
        this.scheduleRender();
        return;
      }
    }
    const itemId = itemNode.dataset.item;
    if (itemId === undefined) return;
    this.view.selectedItemId = itemId;
    this.view.selectedTransitionId = undefined;
    this.view.selectedMarkerId =
      markerNode?.dataset.marker !== undefined && hostItemFromMarker === itemId
        ? markerNode.dataset.marker
        : undefined;
    this.view.selectedTrackId = itemNode.dataset.track;
    const item = selected(this.engine.project, itemId);
    if (item === undefined) return;
    if (this.view.tool === 'razor') {
      this.run('分割', () => {
        const right = splitAt(this.engine, itemId, timeUs);
        if (right !== undefined) this.view.selectedItemId = right;
      });
      return;
    }
    const edge = target.closest<HTMLElement>('[data-edge]')?.dataset.edge;
    const kind: Gesture['kind'] =
      edge === 'start' || edge === 'end'
        ? 'trim'
        : this.view.tool === 'slip'
          ? 'slip'
          : this.view.tool === 'slide'
            ? 'slide'
            : this.view.tool === 'roll'
              ? 'roll'
              : 'move';
    this.#gesture = {
      kind,
      itemId,
      trackId: item.trackId,
      ...(edge === 'start' || edge === 'end' ? { edge } : {}),
      originUs: timeUs,
      startUs: item.range.startUs,
      durationUs: item.range.durationUs,
      pointerId: event.pointerId,
      historyGroup: `edit-${itemId}-${event.pointerId.toString()}`,
    };
    this.#els.timeline.setPointerCapture(event.pointerId);
    this.scheduleRender();
  }

  #onTimelinePointerMove(event: PointerEvent): void {
    const gesture = this.#gesture;
    if (gesture === undefined || event.pointerId !== gesture.pointerId) return;
    if (gesture.kind === 'playhead' || gesture.kind === 'move' || gesture.kind === 'trim') {
      this.#nudgeTimelineScroll(event);
    }
    const timeUs = hitTimeFromEvent(event, this.#els.timeline, this.view);
    const deltaUs = timeUs - gesture.originUs;
    if (gesture.kind === 'playhead') {
      this.#scheduleScrub(timeUs);
      return;
    }
    if (gesture.kind === 'transition-trim' && gesture.edge !== undefined) {
      const project = this.engine.project;
      if (project === null) return;
      const toUs =
        gesture.edge === 'start'
          ? snapTime(gesture.startUs + deltaUs, project, this.view)
          : snapTime(gesture.startUs + gesture.durationUs + deltaUs, project, this.view);
      try {
        resizeTransition(
          this.engine,
          gesture.itemId,
          gesture.edge,
          Math.max(0, toUs),
          this.engine.liveEdit,
        );
      } catch (error) {
        this.setStatus(errorMessage(error, '调整转场失败'), true);
      }
      return;
    }
    const session = this.engine.session;
    const project = this.engine.project;
    const item = selected(project, gesture.itemId);
    if (session === undefined || project === null || item === undefined) return;
    try {
      if (gesture.kind === 'move') {
        const over = document.elementFromPoint(event.clientX, event.clientY);
        const overTrack = over?.closest<HTMLElement>('.track-row');
        const overKind = overTrack?.dataset.kind;
        const itemKind =
          item.type === 'audio' ? 'audio' : item.type === 'caption' ? 'caption' : 'visual';
        const trackId =
          overTrack?.dataset.track !== undefined && overKind === itemKind
            ? overTrack.dataset.track
            : undefined;
        const intended = Math.max(0, gesture.startUs + deltaUs);
        const targetStartUs = this.view.snap
          ? snapItemStart(intended, item, project, this.view)
          : intended;
        if (item.linkGroupId !== undefined && this.view.linkedEdit) {
          moveLinkedGroupAvoidingOverlap(
            this.engine,
            item.linkGroupId,
            targetStartUs - item.range.startUs,
            gesture.historyGroup,
          );
          const latest = this.engine.project?.items[item.id];
          if (latest !== undefined && trackId !== undefined && trackId !== latest.trackId) {
            moveLinkedMemberToTrack(this.engine, latest.id, trackId, gesture.historyGroup);
          }
        } else {
          const result = moveItemAvoidingOverlap(this.engine, {
            itemId: item.id,
            startUs: targetStartUs,
            fromTrackId: gesture.trackId,
            fromStartUs: gesture.startUs,
            ...(trackId !== undefined && trackId !== item.trackId ? { toTrackId: trackId } : {}),
            ...(gesture.swappedOccupantId === undefined
              ? {}
              : { reverseSwapId: gesture.swappedOccupantId }),
            historyGroup: gesture.historyGroup,
          });
          if (result?.kind === 'swap') gesture.swappedOccupantId = result.occupantId;
          const nextItem = this.engine.project?.items[item.id];
          if (nextItem !== undefined && nextItem.trackId !== gesture.trackId) {
            gesture.trackId = nextItem.trackId;
          }
        }
      } else if (gesture.kind === 'trim' && gesture.edge !== undefined) {
        const toUs =
          gesture.edge === 'start'
            ? snapTime(gesture.startUs + deltaUs, project, this.view)
            : snapTime(gesture.startUs + gesture.durationUs + deltaUs, project, this.view);
        resizeTimelineItem(this.engine, item.id, gesture.edge, Math.max(0, toUs), {
          historyGroup: gesture.historyGroup,
          ...(item.linkGroupId !== undefined && this.view.linkedEdit ? { linked: true } : {}),
        });
      } else if (gesture.kind === 'slip') {
        session.transaction.commands.slipItem({
          itemId: item.id,
          deltaSourceUs: deltaUs,
          historyGroup: gesture.historyGroup,
        });
      } else if (gesture.kind === 'slide') {
        session.transaction.commands.slideItem({
          itemId: item.id,
          deltaUs,
          historyGroup: gesture.historyGroup,
        });
      } else if (gesture.kind === 'roll') {
        const pair = neighborPair(project, item.id);
        const left = pair.left ?? item;
        const right = pair.right;
        if (right !== undefined) {
          session.transaction.commands.rollEdit({
            leftItemId: left.id,
            rightItemId: right.id,
            toUs: snapTime(timeUs, project, this.view),
            historyGroup: gesture.historyGroup,
          });
        }
      }
    } catch (error) {
      if (!isIdleEditError(error)) this.setStatus(errorMessage(error, '编辑被拒绝'), true);
    }
  }

  #onTimelinePointerUp(event: PointerEvent): void {
    const gesture = this.#gesture;
    if (gesture?.pointerId !== event.pointerId) return;
    this.#gesture = undefined;
    if (gesture.kind === 'transition-trim') this.engine.endGesture();
    this.#restorePreviewSharpness();
    this.#refreshPreview();
    this.scheduleRender();
  }

  #onTimelineScroll(event: Event): void {
    hideContextMenu();
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.dataset.role !== 'hscroll') return;
    this.view.scrollLeftPx = Math.max(0, target.scrollLeft);
    clampTimelineScroll(this.view, this.engine.project, this.#els.timeline);
    syncTimelineViewport(this.#els.timeline, this.view, this.engine.project);
  }

  #onTimelineWheel(event: WheelEvent): void {
    hideContextMenu();
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      this.#zoom(event.deltaY < 0 ? 1.12 : 0.9, event.clientX);
      return;
    }
    const hscroll = this.#els.timeline.querySelector('[data-role="hscroll"]');
    if (!(hscroll instanceof HTMLElement)) return;
    if (hscroll.scrollWidth <= hscroll.clientWidth) return;
    event.preventDefault();
    hscroll.scrollLeft += event.deltaY + event.deltaX;
  }

  #onSplitterDown(event: PointerEvent): void {
    const handle = (event.target as Element | null)?.closest<HTMLElement>('[data-split]');
    if (handle?.dataset.split === undefined) return;
    const kind = handle.dataset.split;
    const origin = kind === 'timeline' ? event.clientY : event.clientX;
    const base =
      kind === 'left'
        ? this.view.leftWidth
        : kind === 'right'
          ? this.view.rightWidth
          : this.view.timelineHeight;
    const move = (moveEvent: PointerEvent): void => {
      const delta = kind === 'timeline' ? origin - moveEvent.clientY : moveEvent.clientX - origin;
      if (kind === 'left') this.view.leftWidth = Math.min(420, Math.max(196, base + delta));
      if (kind === 'right') this.view.rightWidth = Math.min(420, Math.max(220, base - delta));
      if (kind === 'timeline')
        this.view.timelineHeight = Math.min(
          520,
          Math.max(180, base + (origin - moveEvent.clientY)),
        );
      this.#layout();
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    event.preventDefault();
  }

  #onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') hideContextMenu();
    if (this.#screen !== 'editor') return;
    const typing =
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLSelectElement;
    if (typing) return;
    const meta = event.ctrlKey || event.metaKey;
    if (meta && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      this.#command(event.shiftKey ? 'redo' : 'undo');
      return;
    }
    if (meta && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      this.#command('redo');
      return;
    }
    if (event.code === 'Space') {
      event.preventDefault();
      if (performance.now() < this.#ignoreTransportKeysUntil) return;
      void this.#togglePlay();
      return;
    }
    if (event.key === 'k' || event.key === 'K') {
      event.preventDefault();
      if (this.engine.session?.player.state === 'playing') void this.#togglePlay();
      return;
    }
    if (event.key === 'l' || event.key === 'L') {
      event.preventDefault();
      if (this.engine.session?.player.state !== 'playing') void this.#togglePlay();
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      this.#command('delete');
      return;
    }
    if (event.key === 's' || event.key === 'S') this.#command('split');
    if (event.key === 'm' || event.key === 'M') this.#command('marker');
    if (event.key === 'v' || event.key === 'V') this.view.tool = 'select';
    if (event.key === 'c' || event.key === 'C') this.view.tool = 'razor';
    if (event.key === 'y' || event.key === 'Y') this.view.tool = 'slip';
    if (event.key === 'u' || event.key === 'U') this.view.tool = 'slide';
    if (event.key === 'n' || event.key === 'N') this.view.tool = 'roll';
    if (event.key === 'Home') void this.#seek(0);
    if (event.key === 'End') void this.#seek(Math.max(0, this.engine.renderDurationUs - 1));
    if (event.key === 'ArrowLeft') this.#step(event.shiftKey ? -10 : -1);
    if (event.key === 'ArrowRight') this.#step(event.shiftKey ? 10 : 1);
    if (event.key === '=' || event.key === '+') this.#zoom(1.2);
    if (event.key === '-' || event.key === '_') this.#zoom(0.8);
    if (['v', 'c', 'y', 'u', 'n', 'V', 'C', 'Y', 'U', 'N'].includes(event.key))
      this.scheduleRender();
  }

  #layout(): void {
    this.#els.studio.style.setProperty('--left', `${this.view.leftWidth}px`);
    this.#els.studio.style.setProperty('--right', `${this.view.rightWidth}px`);
    this.#els.studio.style.setProperty('--timeline', `${this.view.timelineHeight}px`);
    this.#syncProgramOverlay();
  }

  #zoom(factor: number, clientX?: number): void {
    const previous = this.view.pixelsPerSecond;
    this.view.pixelsPerSecond = Math.min(MAX_PPS, Math.max(MIN_PPS, previous * factor));
    const local =
      clientX !== undefined
        ? clientX - this.#els.timeline.getBoundingClientRect().left - TRACK_HEADER_WIDTH
        : (this.view.currentTimeUs / 1_000_000) * previous - this.view.scrollLeftPx;
    const timeUs = ((local + this.view.scrollLeftPx) / previous) * 1_000_000;
    this.view.scrollLeftPx = Math.max(0, (timeUs / 1_000_000) * this.view.pixelsPerSecond - local);
    clampTimelineScroll(this.view, this.engine.project, this.#els.timeline);
    this.scheduleRender();
  }

  #nudgeTimelineScroll(event: PointerEvent): void {
    const root = this.#els.timeline;
    const rect = root.getBoundingClientRect();
    const left = rect.left + TRACK_HEADER_WIDTH;
    const right = rect.right;
    const zone = 40;
    let delta = 0;
    if (event.clientX < left + zone) {
      delta = -Math.ceil(((left + zone - event.clientX) / zone) * 18);
    } else if (event.clientX > right - zone) {
      delta = Math.ceil(((event.clientX - (right - zone)) / zone) * 18);
    }
    if (delta === 0) return;
    this.view.scrollLeftPx += delta;
    clampTimelineScroll(this.view, this.engine.project, root);
    syncTimelineViewport(root, this.view, this.engine.project);
  }

  #step(frames: number): void {
    const frameUs = frameDurationUs(this.engine.format.frameRate);
    void this.#seek(
      quantizeToFrame(this.view.currentTimeUs + frames * frameUs, this.engine.format.frameRate),
    );
  }

  #syncProgramOverlay(): void {
    const gesture = this.#programGesture;
    renderProgramOverlay(this.#els.overlay, {
      canvas: this.#els.canvas,
      project: this.engine.project,
      format: this.engine.format,
      timeUs: this.view.currentTimeUs,
      selectedItemId: this.view.selectedItemId,
      yAxis: gesture?.yAxis ?? this.#programYAxis(),
      ...(gesture === undefined ? {} : { transform: gesture.live, snapGuides: gesture.snapGuides }),
    });
  }

  #scheduleProgramPreview(): void {
    if (this.#programApplyScheduled) return;
    this.#programApplyScheduled = true;
    requestAnimationFrame(() => {
      this.#programApplyScheduled = false;
      const gesture = this.#programGesture;
      if (gesture?.moved !== true) return;
      if (!this.#flushProgramPointer(gesture)) return;
      this.#commitProgramLive(gesture);
      this.#syncProgramOverlay();
    });
  }

  #updateProgramLive(
    gesture: ProgramGesture,
    point: { readonly x: number; readonly y: number },
    lockAspect: boolean,
    snapEnabled: boolean,
  ): void {
    const format = this.engine.format;
    const project = this.engine.project;
    const item = project?.items[gesture.itemId];
    gesture.snapGuides = EMPTY_PROGRAM_SNAP_GUIDES;
    if (gesture.kind === 'move') {
      const positionPx = pointerMovePosition(
        gesture.origin,
        gesture.originPoint,
        point,
        gesture.yAxis,
      );
      const live = { ...gesture.origin, positionPx };
      if (!snapEnabled || item === undefined || project === null) {
        gesture.live = live;
        return;
      }
      const snapped = snapProgramMove({
        item,
        transform: live,
        format,
        viewScale: gesture.viewScale,
        yAxis: gesture.yAxis,
        targets: gesture.snapTargets,
      });
      gesture.live = { ...live, positionPx: snapped.positionPx };
      gesture.snapGuides = snapped.guides;
      return;
    }
    if (gesture.kind === 'rotate') {
      gesture.live = {
        ...gesture.origin,
        rotationDeg: snapProgramRotation(
          rotationFromPointer(point, gesture.origin, gesture.originAngle, format, gesture.yAxis),
          snapEnabled,
        ),
      };
      return;
    }
    if (item === undefined || project === null) return;
    gesture.live = {
      ...gesture.origin,
      scale: snapProgramScale(
        scaleFromPointer(
          point,
          gesture.handle,
          gesture.origin,
          gesture.sourceBox,
          format,
          lockAspect,
          gesture.yAxis,
        ),
        gesture.fitScale,
        lockAspect,
        snapEnabled,
      ),
    };
  }

  #commitProgramLive(gesture: ProgramGesture): void {
    const item = this.engine.project?.items[gesture.itemId];
    if (item === undefined) return;
    const live = this.#programEdit?.active === true ? this.#programEdit : undefined;
    if (gesture.kind === 'move') {
      patchVisual(this.engine, gesture.itemId, { positionPx: gesture.live.positionPx }, live);
      return;
    }
    if (gesture.kind === 'rotate') {
      patchVisual(this.engine, gesture.itemId, { rotationDeg: gesture.live.rotationDeg }, live);
      return;
    }
    const fit = gesture.fitScale;
    patchVisual(
      this.engine,
      gesture.itemId,
      {
        scale: {
          x: gesture.live.scale.x / (fit.x === 0 ? 1 : fit.x),
          y: gesture.live.scale.y / (fit.y === 0 ? 1 : fit.y),
        },
      },
      live,
    );
  }

  #onPreviewChromePointerDown(event: Event): void {
    if (!(event instanceof PointerEvent) || event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target === this.#els.canvas || this.#els.canvas.contains(target)) return;
    if (target.closest('.monitor-bar') !== null) return;
    this.#clearPreviewSelection();
  }

  #clearPreviewSelection(): void {
    if (this.view.selectedItemId === undefined && this.view.selectedTransitionId === undefined) {
      return;
    }
    this.view.selectedItemId = undefined;
    this.view.selectedTransitionId = undefined;
    this.scheduleRender();
  }

  #onProgramPointer(event: PreviewCanvasPointerEvent): void {
    if (this.view.tool !== 'select') return;
    const project = this.engine.project;
    if (project === null) return;
    const format = this.engine.format;
    const yAxis = this.#programYAxis();
    const viewScale = containLayout(this.#els.canvas, format).scale;
    const point = event.point;
    event.originalEvent.preventDefault();
    if (event.type === 'move' && this.#programGesture === undefined && event.buttons === 0) {
      if (!point.inside) {
        this.#els.canvas.style.cursor = 'default';
        return;
      }
      const hover = hitTestProgram(
        project,
        format,
        this.view.currentTimeUs,
        point,
        this.view.selectedItemId,
        viewScale,
        yAxis,
      );
      this.#els.canvas.style.cursor = programCursor(hover);
      return;
    }
    if (event.type === 'down') {
      if (!point.inside) {
        this.#clearPreviewSelection();
        return;
      }
      const hit = hitTestProgram(
        project,
        format,
        this.view.currentTimeUs,
        point,
        this.view.selectedItemId,
        viewScale,
        yAxis,
      );
      this.view.selectedItemId = hit?.itemId;
      if (hit !== undefined) this.view.selectedTrackId = project.items[hit.itemId]?.trackId;
      this.scheduleRender();
      if (hit === undefined) return;
      const item = project.items[hit.itemId];
      if (item === undefined) return;
      if (this.engine.session?.player.state === 'playing') {
        void this.engine.togglePlayback(this.view.currentTimeUs);
      }
      try {
        this.#els.canvas.setPointerCapture(event.pointerId);
      } catch {
        // Inactive or synthetic pointers cannot capture; canvas events still drive the gesture.
      }
      this.#commitInspectorGesture();
      const origin = readFittedTransform(item, format, project);
      const source = mediaSourceSize(project, item);
      const visual = itemVisual(item);
      this.#programGesture = {
        kind: hit.handle === 'rotate' ? 'rotate' : hit.handle === 'body' ? 'move' : 'scale',
        handle: hit.handle,
        itemId: hit.itemId,
        pointerId: event.pointerId,
        originPoint: { x: point.x, y: point.y },
        origin,
        originAngle: pointerOriginAngle(point, origin, format, yAxis),
        yAxis,
        viewScale,
        sourceBox: itemSourceBox(item, format),
        snapTargets: collectProgramSnapTargets({
          project,
          format,
          timeUs: this.view.currentTimeUs,
          excludeItemId: item.id,
          yAxis,
        }),
        fitScale: visualFitScale(
          typeof visual?.fit === 'string' ? visual.fit : undefined,
          source?.width ?? format.width,
          source?.height ?? format.height,
          format.width,
          format.height,
        ),
        pending: undefined,
        live: origin,
        snapGuides: EMPTY_PROGRAM_SNAP_GUIDES,
        moved: false,
      };
      this.view.inspectorTab = 'video';
      return;
    }
    const gesture = this.#programGesture;
    if (gesture === undefined || event.pointerId !== gesture.pointerId) return;
    if (event.type === 'cancel') {
      this.#endProgramGesture(true);
      return;
    }
    if (event.type === 'up') {
      this.#endProgramGesture(false);
      return;
    }
    const distance = Math.hypot(point.x - gesture.originPoint.x, point.y - gesture.originPoint.y);
    if (!gesture.moved && distance < 3 / Math.max(gesture.viewScale, 0.001)) return;
    if (!gesture.moved) {
      gesture.moved = true;
      this.#programEdit = this.engine.beginGesture('画面变换');
    }
    // Pointer moves can outrun the display. Keep only the newest sample and do
    // the transform, commit and overlay work once per animation frame.
    gesture.pending = {
      point: { x: point.x, y: point.y },
      lockAspect: !event.originalEvent.shiftKey,
      snapEnabled: this.view.programSnap && !event.originalEvent.altKey,
    };
    this.#scheduleProgramPreview();
  }

  #flushProgramPointer(gesture: ProgramGesture): boolean {
    const pending = gesture.pending;
    if (pending === undefined) return false;
    gesture.pending = undefined;
    this.#updateProgramLive(gesture, pending.point, pending.lockAspect, pending.snapEnabled);
    return true;
  }

  #endProgramGesture(cancel: boolean): void {
    const gesture = this.#programGesture;
    this.#programApplyScheduled = false;
    this.#programGesture = undefined;
    if (gesture?.moved === true) {
      // A pointer sample can arrive after the last animation frame; releasing
      // must land on it, not on the frame before it.
      if (!cancel) {
        this.#flushProgramPointer(gesture);
        this.#commitProgramLive(gesture);
      }
      this.engine.endGesture(cancel);
      this.setStatus(cancel ? '已取消变换' : '画面变换');
    }
    this.#programEdit = undefined;
    this.#inspectorKey = '';
    this.#els.canvas.style.cursor = 'default';
    this.#restorePreviewSharpness();
    this.scheduleRender();
    this.#refreshPreview();
  }

  async #togglePlay(): Promise<void> {
    try {
      await this.engine.togglePlayback(this.view.currentTimeUs);
      this.#syncTransportChrome();
    } catch (error) {
      this.setStatus(errorMessage(error, '播放失败'), true);
    }
  }

  #syncTransportChrome(): void {
    const session = this.engine.session;
    const playing = session?.player.state === 'playing';
    if (session !== undefined) this.view.currentTimeUs = session.player.currentTimeUs;
    this.#els.play.classList.toggle('is-playing', playing);
    if (playing) {
      this.#ensurePlayheadPolling();
      return;
    }
    this.scheduleRender();
  }

  #ensurePlayheadPolling(): void {
    if (this.#playheadPolling) return;
    if (this.#screen !== 'editor' || this.engine.session?.player.state !== 'playing') return;
    this.#playheadPolling = true;
    const tick = (): void => {
      const session = this.engine.session;
      if (
        this.#screen !== 'editor' ||
        session === undefined ||
        session.player.state !== 'playing'
      ) {
        this.#playheadPolling = false;
        this.#els.play.classList.remove('is-playing');
        if (this.#screen === 'editor') this.scheduleRender();
        return;
      }
      this.view.currentTimeUs = session.player.currentTimeUs;
      this.#els.timecode.textContent = formatTimecode(
        this.view.currentTimeUs,
        this.engine.format.frameRate,
      );
      const playhead = this.#els.timeline.querySelector('.playhead');
      if (playhead instanceof HTMLElement) {
        playhead.style.left = `${TRACK_HEADER_WIDTH + (this.view.currentTimeUs / 1_000_000) * this.view.pixelsPerSecond - this.view.scrollLeftPx}px`;
      }
      const item = selected(this.engine.project, this.view.selectedItemId);
      if (item !== undefined && isProgramItem(item)) this.#syncProgramOverlay();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  #importFiles(
    files: readonly File[],
    atUs = this.view.currentTimeUs,
    options?: ImportPlacementOptions,
  ): void {
    this.run(`导入 ${files.length} 个文件`, async () => {
      const imported = await this.engine.importFiles(files, atUs, options);
      const last = imported.at(-1);
      this.view.selectedItemId = last?.videoItemId ?? last?.audioItemId;
    });
  }

  async #importSubtitle(file: File): Promise<void> {
    const text = await file.text();
    const cues = parseSubtitleDocument(text);
    this.run(`导入 ${cues.length} 条字幕`, () => {
      for (const cue of cues) {
        insertCaptionCue(this.engine, cue.startUs, cue.endUs - cue.startUs, cue.text);
      }
    });
  }

  async #analyzeLoudness(): Promise<void> {
    const session = this.engine.session;
    if (session === undefined) return;
    this.setStatus('正在分析响度…');
    try {
      const current = selected(this.engine.project, this.view.selectedItemId);
      const mixer =
        this.engine.project === null || current === undefined
          ? undefined
          : linkedMixerItem(this.engine.project, current);
      const report = await session.audio.analyze({
        ...(mixer === undefined ? {} : { itemIds: [mixer.id] }),
      });
      this.view.analysisText = `LUFS ${report.integratedLufs.toFixed(1)} · True Peak ${report.truePeakDbtp.toFixed(1)} dBTP`;
      this.setStatus('响度分析完成');
      this.scheduleRender();
    } catch (error) {
      this.setStatus(errorMessage(error, '响度分析失败'), true);
    }
  }

  async #detectSilence(remove: boolean): Promise<void> {
    const session = this.engine.session;
    const current = selected(this.engine.project, this.view.selectedItemId);
    const mixer =
      this.engine.project === null || current === undefined
        ? undefined
        : linkedMixerItem(this.engine.project, current);
    const itemId = mixer?.id ?? this.view.selectedItemId;
    if (session === undefined || itemId === undefined) return;
    this.setStatus(remove ? '正在移除静音…' : '正在检测静音…');
    try {
      if (remove) {
        const result = await session.audio.removeSilence({ itemId });
        this.setStatus(`已移除 ${formatSeconds(result.removedUs)} 静音`);
      } else {
        const detection = await session.audio.detectSilence({ itemId });
        const removedUs = Math.round((detection.removedFrames / detection.sampleRate) * 1_000_000);
        this.view.analysisText = `静音 ${detection.silent.length} 段 · 可移除 ${formatSeconds(removedUs)}`;
        this.setStatus('静音检测完成');
      }
      this.scheduleRender();
    } catch (error) {
      this.setStatus(errorMessage(error, '静音处理失败'), true);
    }
  }

  async #markBeats(): Promise<void> {
    const session = this.engine.session;
    if (session === undefined) return;
    this.setStatus('正在检测节拍…');
    try {
      const result = await session.audio.analyzeBeats();
      const sampleRate = result.sampleRate;
      for (const beat of result.beats.slice(0, 64)) {
        addMarker(this.engine, Math.round((beat.frame / sampleRate) * 1_000_000), 'Beat');
      }
      this.setStatus(`已标记 ${Math.min(64, result.beats.length)} 拍`);
      this.scheduleRender();
    } catch (error) {
      this.setStatus(errorMessage(error, '节拍检测失败'), true);
    }
  }

  async #markEnergy(): Promise<void> {
    const session = this.engine.session;
    if (session === undefined) return;
    this.setStatus('正在检测能量切点…');
    try {
      const result = await session.audio.analyzeAudioEnergyChanges();
      for (const change of result.changes.slice(0, 48)) {
        addMarker(this.engine, Math.round((change.frame / result.sampleRate) * 1_000_000), 'Cut');
      }
      this.setStatus(`已标记 ${Math.min(48, result.changes.length)} 个切点`);
      this.scheduleRender();
    } catch (error) {
      this.setStatus(errorMessage(error, '能量分析失败'), true);
    }
  }

  #showDiagnostics(): void {
    const report = this.engine.session?.createDiagnosticReport({ privacy: 'full' });
    this.#showInfo('诊断', JSON.stringify(report ?? {}, null, 2));
  }

  async #showCapability(): Promise<void> {
    const report = await this.engine.session?.probeCapabilities();
    this.#showInfo('能力预检', JSON.stringify(report ?? {}, null, 2));
  }

  #showInfo(title: string, body: string): void {
    requiredElement('#info-title').textContent = title;
    requiredElement('#info-body').textContent = body;
    this.#els.dialogInfo.showModal();
  }

  async #preflight(): Promise<void> {
    const session = this.engine.session;
    if (session === undefined) return;
    const sink = new SeekableMemorySink();
    this.#setExportStatus('正在预检…', 'busy');
    try {
      const options = this.#exportOptions(sink);
      const report =
        options.profile === 'webm-vp9-opus'
          ? await session.export.preflight({
              sink: sink.writable,
              ...(options.videoBitrate === undefined ? {} : { videoBitrate: options.videoBitrate }),
              ...(options.audioBitrate === undefined ? {} : { audioBitrate: options.audioBitrate }),
            })
          : await session.export.preflightProfile(options);
      this.#setExportStatus(
        report.ok ? '预检通过，可以开始导出' : JSON.stringify(report, null, 2),
        report.ok ? 'ok' : 'error',
      );
      sink.cleanup();
    } catch (error) {
      sink.cleanup();
      this.#setExportStatus(errorMessage(error, '预检失败'), 'error');
    }
  }

  async #export(): Promise<void> {
    const session = this.engine.session;
    if (session === undefined) return;
    const sink = new SeekableMemorySink();
    const cancel = requiredElement('#export-cancel') as HTMLButtonElement;
    const start = requiredElement('#export-start') as HTMLButtonElement;
    cancel.hidden = false;
    start.disabled = true;
    this.#els.exportProgress.style.width = '0';
    requiredElement('#export-progress-track').hidden = false;
    this.#setExportStatus('正在导出…', 'busy');
    try {
      const options = this.#exportOptions(sink);
      this.setStatus('正在导出…');
      const onProgress = (value: number): void => {
        this.#els.exportProgress.style.width = `${(value * 100).toFixed(1)}%`;
      };
      if (options.profile === 'webm-vp9-opus') {
        await session.export.start({
          sink: sink.writable,
          ...(options.videoBitrate === undefined ? {} : { videoBitrate: options.videoBitrate }),
          ...(options.audioBitrate === undefined ? {} : { audioBitrate: options.audioBitrate }),
          onProgress,
        });
        downloadBlob(sink.finalize(), 'export.webm', 'video/webm');
      } else {
        await session.export.startProfile({ ...options, onProgress });
        downloadBlob(sink.finalize(), exportName(options.profile), exportMime(options.profile));
      }
      this.#els.exportProgress.style.width = '100%';
      this.setStatus('导出完成');
      this.#setExportStatus('导出完成', 'done');
    } catch (error) {
      sink.cleanup();
      this.setStatus(errorMessage(error, '导出失败'), true);
      this.#setExportStatus(errorMessage(error, '导出失败'), 'error');
    } finally {
      cancel.hidden = true;
      start.disabled = false;
    }
  }

  #syncExportForm(): void {
    const profile = (requiredElement('#export-profile') as HTMLSelectElement).value;
    requiredElement('#export-bitrate-row').hidden = !profileUsesBitrate(profile);
  }

  #setExportStatus(message: string, state: 'idle' | 'ok' | 'error' | 'busy' | 'done'): void {
    this.#els.preflight.textContent = message;
    requiredElement('#export-status').dataset.state = state;
  }

  #exportOptions(
    sink: SeekableMemorySink,
  ): AelionProfileExportOptions & { videoBitrate?: number; audioBitrate?: number } {
    const profile = (requiredElement('#export-profile') as HTMLSelectElement).value;
    const videoBitrate = Number((requiredElement('#v-bitrate') as HTMLInputElement).value) * 1000;
    const audioBitrate = Number((requiredElement('#a-bitrate') as HTMLInputElement).value) * 1000;
    const base = { sink: sink.writable };
    if (profile === 'audio-wav') return { ...base, profile: 'audio-wav', sampleFormat: 's16' };
    if (profile === 'still-png' || profile === 'still-jpeg' || profile === 'still-webp') {
      return { ...base, profile, timeUs: this.view.currentTimeUs };
    }
    if (profile === 'animated-gif') return { ...base, profile: 'animated-gif' };
    if (profile === 'mp4-av1-aac' || profile === 'mp4-hevc-aac' || profile === 'mp4-h264-aac') {
      return { ...base, profile, videoBitrate, audioBitrate };
    }
    return { ...base, profile: 'webm-vp9-opus', videoBitrate, audioBitrate };
  }

  #onHomeClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const view = target.closest<HTMLElement>('[data-home-view]');
    const homeView = view?.dataset.homeView;
    if (homeView === 'grid' || homeView === 'list') {
      this.#home.view = homeView;
      this.#els.home.querySelectorAll<HTMLElement>('[data-home-view]').forEach(button => {
        button.classList.toggle('on', button.dataset.homeView === this.#home.view);
      });
      this.#renderHome();
      return;
    }
    if (target.closest('#home-new') !== null) {
      this.#els.dialogNew.showModal();
      return;
    }
    const remove = target.closest<HTMLElement>('[data-delete-project]');
    if (remove?.dataset.deleteProject !== undefined) {
      event.preventDefault();
      void this.#deleteProject(remove.dataset.deleteProject);
      return;
    }
    const open = target.closest<HTMLElement>('[data-open-project]');
    if (open?.dataset.openProject !== undefined) {
      location.hash = editorHash(open.dataset.openProject);
    }
  }

  #setScreen(screen: 'home' | 'editor'): void {
    this.#screen = screen;
    this.#els.home.hidden = screen !== 'home';
    this.#els.studio.hidden = screen !== 'editor';
    hideContextMenu();
  }

  #renderHome(): void {
    renderHome({
      root: this.#els.homeGrid,
      count: this.#els.homeCount,
      projects: this.#homeProjects,
      state: this.#home,
    });
  }

  async #refreshHome(): Promise<void> {
    this.#homeProjects = await listProjectSummaries();
    this.#renderHome();
  }

  #applyRoute(): Promise<void> {
    this.#routeTail = this.#routeTail.then(
      () => this.#syncRoute(),
      () => this.#syncRoute(),
    );
    return this.#routeTail;
  }

  async #syncRoute(): Promise<void> {
    try {
      const route = parseStudioRoute();
      if (route.screen === 'editor') await this.#enterEditor(route.projectId);
      else await this.#enterHome();
    } catch (error) {
      history.replaceState(null, '', HOME_HASH);
      await this.#enterHome(errorMessage(error, '打开工程失败'), true);
    }
  }

  async #enterHome(status = '选择工程', error = false): Promise<void> {
    if (this.engine.session?.player.state === 'playing') {
      await this.engine.session.player.pause();
    }
    try {
      await this.engine.persistence?.flush();
    } catch (flushError) {
      this.setStatus(errorMessage(flushError, '保存失败'), true);
      this.#setScreen('home');
      await this.#refreshHome();
      return;
    }
    this.#setScreen('home');
    this.setStatus(status, error);
    await this.#refreshHome();
  }

  async #enterEditor(projectId: string): Promise<void> {
    if (this.engine.project?.projectId === projectId && this.engine.persistence !== undefined) {
      this.setStatus('就绪');
      await this.#showEditor();
      return;
    }
    this.setStatus('正在打开…');
    this.#resetEditorView();
    const opened = await this.engine.openStoredProject(projectId);
    if (!opened) {
      history.replaceState(null, '', HOME_HASH);
      await this.#enterHome('找不到该工程', true);
      return;
    }
    this.setStatus('就绪');
    await this.#showEditor();
  }

  async #showEditor(): Promise<void> {
    this.#setScreen('editor');
    this.#layout();
    this.render();
    this.#syncTransportChrome();
    await new Promise<void>(resolve => {
      requestAnimationFrame(() => resolve());
    });
    await this.engine.renderFrame(this.view.currentTimeUs);
  }

  #resetEditorView(): void {
    resetViewState(this.view);
    this.#libraryKey = '';
    this.#inspectorKey = '';
    this.#timelineKey = '';
    this.#waveformQueued.clear();
    this.#filmstripQueued.clear();
    this.#revealedItemId = undefined;
  }

  #revealSelectedClip(): void {
    const itemId = this.view.selectedItemId;
    if (itemId === undefined || itemId === this.#revealedItemId) return;
    const clip = this.#els.timeline.querySelector(`[data-item="${CSS.escape(itemId)}"]`);
    const body = this.#els.timeline.querySelector('[data-role="body"]');
    if (!(clip instanceof HTMLElement) || !(body instanceof HTMLElement)) return;
    const bodyBox = body.getBoundingClientRect();
    const clipBox = clip.getBoundingClientRect();
    if (clipBox.bottom > bodyBox.bottom) body.scrollTop += clipBox.bottom - bodyBox.bottom + 8;
    else if (clipBox.top < bodyBox.top) body.scrollTop -= bodyBox.top - clipBox.top + 8;
    this.#revealedItemId = itemId;
  }

  async #deleteProject(projectId: string): Promise<void> {
    if (!window.confirm('删除这个工程？此操作不可撤销。')) return;
    try {
      await this.engine.deleteStoredProject(projectId);
      this.setStatus('已删除工程');
      await this.#refreshHome();
    } catch (error) {
      this.setStatus(errorMessage(error, '删除失败'), true);
    }
  }

  #onNewProject(): void {
    if (this.#els.dialogNew.returnValue !== 'ok') return;
    const title = (requiredElement('#new-title') as HTMLInputElement).value.trim() || '未命名工程';
    const preset = (requiredElement('#new-preset') as HTMLSelectElement).value.split('x');
    const width = Number(preset[0]);
    const height = Number(preset[1]);
    const fps = Number(preset[2]);
    this.run('已新建工程', async () => {
      this.#resetEditorView();
      const projectId = await this.engine.createProject({
        title,
        width,
        height,
        frameRate: { numerator: fps, denominator: 1 },
      });
      this.#setScreen('editor');
      location.hash = editorHash(projectId);
    });
  }

  #onImportUrl(): void {
    if (this.#els.dialogUrl.returnValue !== 'ok') return;
    const url = (requiredElement('#media-url') as HTMLInputElement).value.trim();
    if (url.length === 0) return;
    this.run('导入 URL', async () => {
      const imported = await this.engine.importUrl(url, this.view.currentTimeUs);
      this.view.selectedItemId = imported.videoItemId ?? imported.audioItemId;
    });
  }

  #placeMarker(
    timeUs: number,
    host: { readonly itemId?: string; readonly trackId?: string; readonly looseItem?: boolean } = {},
  ): void {
    const project = this.engine.project;
    if (project === null) return;
    const item = itemCoveringTime(project, timeUs, {
      ...(host.itemId === undefined ? {} : { itemId: host.itemId }),
      ...(host.trackId === undefined ? {} : { trackId: host.trackId }),
      ...(host.looseItem === undefined ? {} : { looseItem: host.looseItem }),
    });
    if (item === undefined) {
      this.setStatus('把打点落到片段上', true);
      return;
    }
    this.run('打点', () => {
      const id = addMarker(this.engine, timeUs, '标记', { itemId: item.id });
      this.view.selectedMarkerId = id;
      this.view.selectedItemId = item.id;
      this.view.selectedTransitionId = undefined;
    });
  }

  #deleteMarker(markerId: string): void {
    this.run('删除打点', () => {
      removeMarker(this.engine, markerId);
      if (this.view.selectedMarkerId === markerId) this.view.selectedMarkerId = undefined;
    });
  }

  #deleteLibraryAsset(assetId: string): void {
    const project = this.engine.project;
    const asset = project?.assets[assetId];
    if (project === null || project === undefined || asset === undefined) return;
    const name = typeof asset.name === 'string' && asset.name.length > 0 ? asset.name : '未命名素材';
    const used = itemsUsingAsset(project, assetId).length;
    const message =
      used > 0
        ? `删除素材「${name}」？时间线上的 ${used.toString()} 个片段会一并删除。`
        : `删除素材「${name}」？`;
    if (!window.confirm(message)) return;
    const selected = this.view.selectedItemId;
    this.run('删除素材', () => {
      deleteAsset(this.engine, assetId);
      if (selected !== undefined && this.engine.project?.items[selected] === undefined) {
        this.view.selectedItemId = undefined;
      }
    });
  }

  #openRenameAsset(assetId: string): void {
    const asset = this.engine.project?.assets[assetId];
    if (asset === undefined) return;
    this.#renameAssetId = assetId;
    const input = requiredElement('#rename-asset-name') as HTMLInputElement;
    input.value = typeof asset.name === 'string' ? asset.name : assetId;
    this.#els.dialogRename.showModal();
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
  }

  #onRenameAsset(): void {
    const assetId = this.#renameAssetId;
    this.#renameAssetId = undefined;
    if (this.#els.dialogRename.returnValue !== 'ok' || assetId === undefined) return;
    const name = (requiredElement('#rename-asset-name') as HTMLInputElement).value.trim();
    if (name.length === 0) return;
    this.run('重命名素材', () => renameAsset(this.engine, assetId, name));
  }

  #queueWaveforms(project: AelionProject | null): void {
    if (project === null) return;
    if (this.engine.session?.player.state === 'playing') return;
    for (const item of Object.values(project.items)) {
      if (
        item.type !== 'audio' ||
        this.engine.waveforms.has(item.id) ||
        this.#waveformQueued.has(item.id)
      ) {
        continue;
      }
      this.#waveformQueued.add(item.id);
      void this.engine.ensureWaveform(item).then(() => {
        this.#waveformQueued.delete(item.id);
        this.scheduleRender();
      });
    }
  }

  #queueFilmstrips(project: AelionProject | null): void {
    if (project === null) return;
    if (this.engine.session?.player.state === 'playing') return;
    if ((this.engine.preview?.snapshot().renderedFrames ?? 0) === 0) return;
    for (const item of Object.values(project.items)) {
      if (item.type !== 'video' && item.type !== 'image') continue;
      if (this.engine.hasCurrentFilmstrip(item) || this.#filmstripQueued.has(item.id)) continue;
      this.#filmstripQueued.add(item.id);
      void this.engine.ensureFilmstrip(item).finally(() => {
        this.#filmstripQueued.delete(item.id);
        this.scheduleRender();
      });
    }
  }
}

function selected(
  project: AelionProject | null,
  itemId: string | undefined,
): ItemEntity | undefined {
  return itemId === undefined || project === null ? undefined : project.items[itemId];
}

function isLibraryPayloadDrag(transfer: DataTransfer | null): boolean {
  return transfer?.types.includes('text/aelion-drop') === true;
}

function libraryPreviewUrls(
  project: AelionProject | null,
  thumbs: ReadonlyMap<string, string>,
  filmstrips: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const urls = new Map(thumbs);
  if (project === null) return urls;
  for (const item of Object.values(project.items)) {
    const assetId = itemMediaRef(item)?.assetId;
    const film = filmstrips.get(item.id);
    if (assetId !== undefined && film !== undefined && !urls.has(assetId)) urls.set(assetId, film);
  }
  return urls;
}

function formatSeconds(us: number): string {
  return `${(us / 1_000_000).toFixed(2)}s`;
}

function profileUsesBitrate(profile: string): boolean {
  return (
    profile === 'mp4-h264-aac' ||
    profile === 'webm-vp9-opus' ||
    profile === 'mp4-av1-aac' ||
    profile === 'mp4-hevc-aac'
  );
}

function exportName(profile: string): string {
  if (profile.startsWith('still-')) return `frame.${profile.slice(6)}`;
  if (profile === 'audio-wav') return 'mix.wav';
  if (profile === 'animated-gif') return 'sequence.gif';
  if (profile.includes('webm')) return 'export.webm';
  return 'export.mp4';
}

function exportMime(profile: string): string {
  if (profile === 'still-png') return 'image/png';
  if (profile === 'still-jpeg') return 'image/jpeg';
  if (profile === 'still-webp') return 'image/webp';
  if (profile === 'audio-wav') return 'audio/wav';
  if (profile === 'animated-gif') return 'image/gif';
  if (profile.includes('webm')) return 'video/webm';
  return 'video/mp4';
}

const SHORTCUTS = `Space  播放/暂停
K      暂停
L      播放
S      分割
M      在片段上打点
V/C    选择 / 剃刀
Y/U/N  滑移 / 滑动 / 滚动
←/→    逐帧  Shift 十帧
Home/End  起止
+/-    缩放
Del    删除
Ctrl+Z / Ctrl+Y  撤销重做
右键   上下文菜单
Shift+右键  系统菜单`;

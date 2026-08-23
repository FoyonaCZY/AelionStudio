import type { JsonObject } from '@aelionsdk/core';
import type { AelionProject, ItemEntity } from '@aelionsdk/project-schema';
import {
  Aelion,
  IndexedDbProjectRevisionStore,
  ProjectPersistenceController,
  ProductionMediaProvider,
  RuntimeMaterialRegistry,
  attachPreviewCanvas,
  installMigrationMaterials,
  restoreLatestProject,
  type AelionInteractiveEdit,
  type AelionSessionApi,
  type PreviewCanvasController,
  type PreviewCanvasPointerEvent,
  type PreviewCanvasQuality,
  type ProductionMediaProbe,
} from '@aelionsdk/sdk';

import { errorMessage } from './errors.js';
import { IdFactory } from './ids.js';
import { cacheMediaFile, readCachedMedia } from './opfs.js';
import { normalizeMediaFitToFrame } from './commands.js';
import {
  STILL_DURATION_US,
  contentDurationUs,
  createEmptyProject,
  imageItem,
  itemMediaRef,
  mediaItem,
  newTrackEntity,
  sequenceFormat,
  type SequenceFormat,
} from './project.js';
import type { WaveformPeaks } from './timeline.js';
import { newProjectId, STUDIO_DB } from './project-store.js';
import {
  newTrackAnchorId,
  resolveInsertPlacement,
  resolveMediaImportPlacement,
  type InsertPlacement,
} from './timeline-layout.js';

/** Legacy single-project id; existing drafts still appear in the project list. */
export const PROJECT_ID = 'studio_main';
export const SEQUENCE_ID = 'main_sequence';

export interface ImportResult {
  readonly assetId: string;
  readonly name: string;
  readonly kind: 'video' | 'audio' | 'image';
  readonly durationUs: number;
  readonly videoItemId?: string;
  readonly audioItemId?: string;
}

export interface ImportPlacementOptions {
  readonly preferredTrackId?: string;
  readonly lockTrack?: boolean;
}

function assetKindFromProbe(
  probe: ProductionMediaProbe,
  mimeType: string,
): 'video' | 'audio' | 'image' {
  if (mimeType.startsWith('image/')) return 'image';
  const hasVideo = probe.index.tracks.some(track => track.kind === 'video');
  const hasAudio = probe.index.tracks.some(track => track.kind === 'audio');
  if (hasVideo) return 'video';
  if (hasAudio) return 'audio';
  return mimeType.startsWith('audio/') ? 'audio' : 'video';
}

/**
 * Display size of a video track, with container rotation applied.
 *
 * `codedWidth`/`codedHeight` describe the stored frame, so a quarter-turned
 * phone clip reports landscape for portrait footage. Thumbnail capture used to
 * correct this by reading `displayWidth` off a decoded frame, but since SDK
 * 1.2.0-rc.5 a preview request carrying `maxDimension` is downscaled at the
 * provider boundary, so that frame no longer reports the source's real size.
 * Rotation metadata gives the same answer without decoding anything.
 */
function videoDisplaySize(track: {
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly rotation: number;
}): { readonly width: number; readonly height: number } {
  const quarterTurned = Math.abs(Math.round(track.rotation / 90)) % 2 === 1;
  return quarterTurned
    ? { width: track.codedHeight, height: track.codedWidth }
    : { width: track.codedWidth, height: track.codedHeight };
}

function locatorFor(assetId: string, opfsPath: string | undefined, url?: string): JsonObject {
  if (opfsPath !== undefined) return { type: 'opfs', path: opfsPath };
  if (url !== undefined) return { type: 'url', uri: url };
  return { type: 'runtime-binding', bindingId: assetId };
}

const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};

function fileExtension(name: string): string {
  const index = name.lastIndexOf('.');
  return index < 0 ? '' : name.slice(index).toLowerCase();
}

function withMimeType(file: File, mimeType: string): File {
  if (file.type === mimeType) return file;
  return new File([file], file.name, { type: mimeType, lastModified: file.lastModified });
}

async function detectImageMime(file: File): Promise<string | undefined> {
  if (file.type.startsWith('image/')) return file.type;
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (
    header.length >= 8 &&
    header[0] === 0x89 &&
    header[1] === 0x50 &&
    header[2] === 0x4e &&
    header[3] === 0x47 &&
    header[4] === 0x0d &&
    header[5] === 0x0a &&
    header[6] === 0x1a &&
    header[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    header.length >= 12 &&
    header[0] === 0x52 &&
    header[1] === 0x49 &&
    header[2] === 0x46 &&
    header[3] === 0x46 &&
    header[8] === 0x57 &&
    header[9] === 0x45 &&
    header[10] === 0x42 &&
    header[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (header.length >= 6 && header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46) {
    return 'image/gif';
  }
  return IMAGE_MIME_BY_EXT[fileExtension(file.name)];
}

export class EditorEngine {
  public media: ProductionMediaProvider | undefined;
  public session: AelionSessionApi | undefined;
  public preview: PreviewCanvasController | undefined;
  public persistence: ProjectPersistenceController | undefined;
  public readonly ids = new IdFactory();
  public readonly waveforms = new Map<string, WaveformPeaks>();
  public readonly thumbs = new Map<string, string>();
  public readonly filmstrips = new Map<string, string>();
  readonly #filmstripKeys = new Map<string, string>();
  #filmstripTail: Promise<void> = Promise.resolve();
  #filmstripAbort = new AbortController();
  #waveformAbort = new AbortController();
  readonly #store = new IndexedDbProjectRevisionStore({ databaseName: STUDIO_DB });
  #materials: RuntimeMaterialRegistry | undefined;
  #uninstallMaterials: (() => void) | undefined;
  #unsubscribe: (() => void) | undefined;
  #interactive: AelionInteractiveEdit | undefined;
  #onChange: (() => void) | undefined;
  #onError: ((message: string) => void) | undefined;
  #onPreviewReady: (() => void) | undefined;
  #onPreviewPointer: ((event: PreviewCanvasPointerEvent) => void) | undefined;
  #onPlayerState: ((state: string) => void) | undefined;
  #emittedPlayerState: string | undefined;
  #quality: PreviewCanvasQuality = 'adaptive';
  #canvas: HTMLCanvasElement | undefined;
  #previewSuspended = false;
  #startingPlayback = false;

  public get project(): AelionProject | null {
    return this.session?.getSnapshot().project ?? null;
  }

  public get format(): SequenceFormat {
    const project = this.project;
    return project === null
      ? { width: 1920, height: 1080, frameRate: { numerator: 30, denominator: 1 } }
      : sequenceFormat(project);
  }

  public get durationUs(): number {
    return Math.max(
      this.session?.getSnapshot().renderIr?.durationUs ?? 0,
      this.project === null ? 0 : contentDurationUs(this.project),
    );
  }

  public async bootRuntime(
    canvas: HTMLCanvasElement,
    onChange: () => void,
    onError: (message: string) => void,
  ): Promise<void> {
    this.#onChange = onChange;
    this.#onError = onError;
    this.#canvas = canvas;
    await this.#createRuntime(onChange, onError);
    this.#attachPreview(canvas, onError);
  }

  public async openStoredProject(projectId: string): Promise<boolean> {
    const session = this.session;
    if (session === undefined) throw new Error('Session failed to start');
    if (this.project?.projectId === projectId && this.persistence !== undefined) {
      normalizeMediaFitToFrame(this);
      this.#resumePreview();
      await this.renderFrame(0);
      return true;
    }
    await this.#detachProject();
    const restored = await restoreLatestProject(session, this.#store, projectId);
    if (restored === null) return false;
    this.ids.reset();
    this.ids.observe(this.project);
    await this.#rebindAssets();
    await this.#attachPersistence(false);
    normalizeMediaFitToFrame(this);
    this.#resumePreview();
    await this.renderFrame(0);
    return true;
  }

  public async createProject(options: {
    readonly title: string;
    readonly width: number;
    readonly height: number;
    readonly frameRate: { readonly numerator: number; readonly denominator: number };
  }): Promise<string> {
    const session = this.session;
    if (session === undefined) throw new Error('Session failed to start');
    await this.#detachProject();
    const projectId = newProjectId();
    await session.loadProject(
      createEmptyProject({
        projectId,
        sequenceId: SEQUENCE_ID,
        title: options.title,
        sequenceName: 'Sequence 01',
        width: options.width,
        height: options.height,
        frameRate: options.frameRate,
      }),
    );
    this.ids.reset();
    this.ids.observe(this.project);
    await this.#attachPersistence(true);
    await this.persistence?.flush();
    this.#resumePreview();
    await this.renderFrame(0);
    return projectId;
  }

  public async newProject(options: {
    readonly title: string;
    readonly width: number;
    readonly height: number;
    readonly frameRate: { readonly numerator: number; readonly denominator: number };
  }): Promise<string> {
    return this.createProject(options);
  }

  public async deleteStoredProject(projectId: string): Promise<void> {
    if (this.project?.projectId === projectId) await this.#detachProject();
    await this.#store.remove(projectId);
  }

  async #detachProject(): Promise<void> {
    this.#previewSuspended = true;
    this.endGesture();
    const session = this.session;
    if (session?.player.state === 'playing') await session.player.pause();
    const persistence = this.persistence;
    this.persistence = undefined;
    if (persistence !== undefined) await persistence.dispose();
    this.#releaseBoundAssets();
    this.ids.reset();
    this.preview?.dispose();
    this.preview = undefined;
    this.clearPreview();
  }

  #resumePreview(): void {
    this.#previewSuspended = false;
    const canvas = this.#canvas;
    const onError = this.#onError;
    if (this.preview === undefined && canvas !== undefined && onError !== undefined) {
      this.#attachPreview(canvas, onError);
    }
  }

  async #attachPersistence(saveInitial: boolean): Promise<void> {
    const session = this.session;
    if (session === undefined) throw new Error('Session failed to start');
    this.persistence = await ProjectPersistenceController.attach(session, this.#store, {
      debounceMs: 400,
      saveInitial,
      onError: error => this.#onError?.(errorMessage(error, '自动保存失败')),
    });
  }

  #releaseBoundAssets(): void {
    const project = this.project;
    const media = this.media;
    if (project !== null && media !== undefined) {
      for (const id of Object.keys(project.assets)) media.unregister(id);
    }
    media?.clear();
    this.waveforms.clear();
    this.#revokeThumbs();
    this.#revokeFilmstrips();
  }

  public setQuality(quality: PreviewCanvasQuality, renderScale?: number): void {
    this.#quality = quality;
    if (renderScale === undefined) this.preview?.setQuality(quality);
    else this.preview?.setQuality(quality, renderScale);
  }

  public setPreviewPointerHandler(
    handler: ((event: PreviewCanvasPointerEvent) => void) | undefined,
  ): void {
    this.#onPreviewPointer = handler;
  }

  public setPreviewReadyHandler(handler: (() => void) | undefined): void {
    this.#onPreviewReady = handler;
  }

  public setPlayerStateHandler(handler: ((state: string) => void) | undefined): void {
    this.#onPlayerState = handler;
  }

  public get renderDurationUs(): number {
    return this.session?.getSnapshot().renderIr?.durationUs ?? 0;
  }

  public clearPreview(): void {
    const canvas = this.#canvas;
    if (canvas === undefined) return;
    const context = canvas.getContext('2d');
    if (context === null) return;
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = '#0b0b0b';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.restore();
  }

  public async renderFrame(timeUs: number): Promise<void> {
    const durationUs = this.renderDurationUs;
    if (this.#previewSuspended || durationUs <= 0) {
      this.clearPreview();
      return;
    }
    await this.preview?.render(Math.min(Math.max(0, timeUs), durationUs - 1));
  }

  public async seek(timeUs: number): Promise<void> {
    const session = this.session;
    const durationUs = this.renderDurationUs;
    if (session === undefined || durationUs <= 0) return;
    const clamped = Math.min(Math.max(0, timeUs), durationUs - 1);
    if (session.player.state === 'playing') await session.player.seek(clamped);
    else await this.renderFrame(clamped);
  }

  public async togglePlayback(timeUs: number): Promise<'playing' | 'paused'> {
    const session = this.session;
    if (session === undefined) return 'paused';
    const contextState = session.player.getStats().resources.audio.contextState;
    if (
      session.player.state === 'playing' ||
      this.#startingPlayback ||
      contextState === 'running'
    ) {
      this.#startingPlayback = false;
      await session.player.pause();
      return 'paused';
    }
    const durationUs = this.renderDurationUs;
    if (durationUs <= 0) {
      throw new Error('时间线是空的，先放入素材或图层后再播放');
    }
    const playheadUs = timeUs < 0 || timeUs >= durationUs ? 0 : timeUs;
    this.abortBackgroundFilmstrips();
    this.abortBackgroundWaveforms();
    this.#startingPlayback = true;
    try {
      await session.player.seek(playheadUs);
      await session.player.play();
      return 'playing';
    } finally {
      this.#startingPlayback = false;
    }
  }

  public get liveEdit(): AelionInteractiveEdit | undefined {
    return this.#interactive;
  }

  public beginGesture(label: string): AelionInteractiveEdit | undefined {
    this.#interactive?.commit();
    this.#interactive = this.session?.transaction.beginInteractive({ label });
    return this.#interactive;
  }

  public endGesture(cancel = false): void {
    const interactive = this.#interactive;
    this.#interactive = undefined;
    if (interactive === undefined || !interactive.active) return;
    if (cancel) interactive.cancel();
    else interactive.commit();
  }

  public async importFiles(
    files: readonly File[],
    atUs: number,
    options?: ImportPlacementOptions,
  ): Promise<readonly ImportResult[]> {
    const results: ImportResult[] = [];
    for (const file of files) {
      if (file.name.toLowerCase().endsWith('.srt') || file.name.toLowerCase().endsWith('.vtt')) {
        continue;
      }
      results.push(await this.importFile(file, atUs, options));
    }
    return results;
  }

  public async importFile(
    file: File,
    atUs: number,
    options?: ImportPlacementOptions,
  ): Promise<ImportResult> {
    const media = this.media;
    const session = this.session;
    if (media === undefined || session === undefined) throw new Error('Session is not ready');
    const imageMime = await detectImageMime(file);
    const mediaFile = imageMime === undefined ? file : withMimeType(file, imageMime);
    const assetId = this.ids.next('asset');
    const opfsPath = await cacheMediaFile(assetId, mediaFile);
    if (imageMime !== undefined) {
      media.registerImageFile(assetId, mediaFile, { mimeType: imageMime });
      let width: number | undefined;
      let height: number | undefined;
      try {
        const bitmap = await createImageBitmap(mediaFile);
        width = bitmap.width;
        height = bitmap.height;
        bitmap.close();
      } catch {
        // Probe size is optional; the renderer still fits from the decoded frame.
      }
      return this.#commitStillImage({
        session,
        mediaFile,
        assetId,
        opfsPath,
        mimeType: imageMime,
        atUs,
        ...(width === undefined || height === undefined ? {} : { width, height }),
        ...(options?.preferredTrackId === undefined
          ? {}
          : { preferredTrackId: options.preferredTrackId }),
        ...(options?.lockTrack === undefined ? {} : { lockTrack: options.lockTrack }),
      });
    }
    media.registerFile(assetId, mediaFile);
    const probe = await media.probe(assetId);
    const kind = assetKindFromProbe(probe, mediaFile.type);
    const video = probe.index.tracks.find(track => track.kind === 'video');
    const audio = probe.index.tracks.find(track => track.kind === 'audio');
    const durationUs = Math.max(1, probe.index.durationUs);
    const format = this.format;
    const project = session.getSnapshot().project;
    if (project === null) throw new Error('Project is not loaded');

    const videoPlace =
      video === undefined
        ? undefined
        : resolveMediaImportPlacement(project, 'visual', atUs, durationUs, options);
    const alignedStartUs = videoPlace?.startUs ?? Math.max(0, atUs);
    const audioPlace =
      audio === undefined
        ? undefined
        : resolveMediaImportPlacement(project, 'audio', alignedStartUs, durationUs, options);
    const videoItemId =
      video !== undefined && videoPlace !== undefined ? this.ids.next('item') : undefined;
    const audioItemId =
      audio !== undefined && audioPlace !== undefined ? this.ids.next('item') : undefined;
    const linkGroupId =
      videoItemId !== undefined && audioItemId !== undefined ? this.ids.next('link') : undefined;
    const mimeType =
      mediaFile.type.length > 0 ? mediaFile.type : kind === 'audio' ? 'audio/webm' : 'video/mp4';

    session.transaction.edit(
      tx => {
        tx.createEntity('assets', assetId, {
          id: assetId,
          kind,
          name: mediaFile.name,
          mimeType,
          locator: locatorFor(assetId, opfsPath),
          byteLength: mediaFile.size,
          probeHint: {
            durationUs: probe.index.durationUs,
            ...(video === undefined
              ? {}
              : { ...videoDisplaySize(video), videoCodec: video.codec }),
            ...(audio === undefined ? {} : { audioCodec: audio.codec }),
          },
          metadata: {
            fileName: mediaFile.name,
            ...(opfsPath === undefined ? {} : { opfsPath }),
          },
        });
        const videoTrackId =
          videoPlace === undefined
            ? undefined
            : this.#trackIdForPlacement(tx, videoPlace, 'visual');
        const audioTrackId =
          audioPlace === undefined ? undefined : this.#trackIdForPlacement(tx, audioPlace, 'audio');
        if (videoItemId !== undefined && videoTrackId !== undefined && video !== undefined) {
          const item = mediaItem({
            id: videoItemId,
            trackId: videoTrackId,
            kind: 'video',
            assetId,
            name: mediaFile.name,
            atUs: videoPlace?.startUs ?? alignedStartUs,
            durationUs,
            streamIndex: probe.index.tracks.filter(track => track.kind === 'video').indexOf(video),
            format,
            sourceWidth: video.codedWidth,
            sourceHeight: video.codedHeight,
          });
          if (linkGroupId !== undefined) (item as JsonObject).linkGroupId = linkGroupId;
          tx.createEntity('items', videoItemId, item as unknown as JsonObject);
          tx.listInsert('tracks', videoTrackId, ['itemIds'], videoItemId);
        }
        if (audioItemId !== undefined && audioTrackId !== undefined && audio !== undefined) {
          const item = mediaItem({
            id: audioItemId,
            trackId: audioTrackId,
            kind: 'audio',
            assetId,
            name: mediaFile.name,
            atUs: alignedStartUs,
            durationUs,
            streamIndex: probe.index.tracks.filter(track => track.kind === 'audio').indexOf(audio),
            format,
          });
          if (linkGroupId !== undefined) (item as JsonObject).linkGroupId = linkGroupId;
          tx.createEntity('items', audioItemId, item as unknown as JsonObject);
          tx.listInsert('tracks', audioTrackId, ['itemIds'], audioItemId);
        }
        if (linkGroupId !== undefined && videoItemId !== undefined && audioItemId !== undefined) {
          tx.createEntity('linkGroups', linkGroupId, {
            id: linkGroupId,
            kind: 'av-sync',
            itemIds: [videoItemId, audioItemId],
            syncOffsetsUs: { [videoItemId]: 0, [audioItemId]: 0 },
          });
        }
      },
      { label: `导入 ${mediaFile.name}` },
    );

    await this.#silenceIdleTransport();
    void this.#captureThumb(assetId, kind);
    return {
      assetId,
      name: mediaFile.name,
      kind,
      durationUs,
      ...(videoItemId === undefined ? {} : { videoItemId }),
      ...(audioItemId === undefined ? {} : { audioItemId }),
    };
  }

  #commitStillImage(options: {
    readonly session: AelionSessionApi;
    readonly mediaFile: File;
    readonly assetId: string;
    readonly opfsPath: string | undefined;
    readonly mimeType: string;
    readonly atUs: number;
    readonly width?: number;
    readonly height?: number;
    readonly preferredTrackId?: string;
    readonly lockTrack?: boolean;
  }): ImportResult {
    const { session, mediaFile, assetId, opfsPath, mimeType, atUs } = options;
    const project = session.getSnapshot().project;
    if (project === null) throw new Error('Project is not loaded');
    const durationUs = STILL_DURATION_US;
    const placement = resolveMediaImportPlacement(project, 'visual', atUs, durationUs, {
      ...(options.preferredTrackId === undefined
        ? {}
        : { preferredTrackId: options.preferredTrackId }),
      ...(options.lockTrack === undefined ? {} : { lockTrack: options.lockTrack }),
    });
    const videoItemId = this.ids.next('item');
    const format = this.format;
    session.transaction.edit(
      tx => {
        const videoTrackId = this.#trackIdForPlacement(tx, placement, 'visual');
        tx.createEntity('assets', assetId, {
          id: assetId,
          kind: 'image',
          name: mediaFile.name,
          mimeType,
          locator: locatorFor(assetId, opfsPath),
          byteLength: mediaFile.size,
          probeHint: {
            durationUs,
            ...(options.width === undefined || options.height === undefined
              ? {}
              : { width: options.width, height: options.height }),
          },
          metadata: {
            fileName: mediaFile.name,
            ...(opfsPath === undefined ? {} : { opfsPath }),
          },
        });
        tx.createEntity(
          'items',
          videoItemId,
          imageItem({
            id: videoItemId,
            trackId: videoTrackId,
            assetId,
            name: mediaFile.name,
            atUs: placement.startUs,
            durationUs,
            format,
            ...(options.width === undefined || options.height === undefined
              ? {}
              : { sourceWidth: options.width, sourceHeight: options.height }),
          }) as unknown as JsonObject,
        );
        tx.listInsert('tracks', videoTrackId, ['itemIds'], videoItemId);
      },
      { label: `导入 ${mediaFile.name}` },
    );
    void this.#silenceIdleTransport();
    void this.#captureThumb(assetId, 'image');
    return {
      assetId,
      name: mediaFile.name,
      kind: 'image',
      durationUs,
      videoItemId,
    };
  }

  public async importUrl(url: string, atUs: number): Promise<ImportResult> {
    const media = this.media;
    const session = this.session;
    if (media === undefined || session === undefined) throw new Error('Session is not ready');
    const assetId = this.ids.next('asset');
    media.registerUrl(assetId, url);
    const probe = await media.probe(assetId);
    const kind = assetKindFromProbe(probe, '');
    const name = url.split('/').pop() ?? 'remote';
    const file = new File([], name);
    Object.defineProperty(file, 'size', { value: 0 });
    const video = probe.index.tracks.find(track => track.kind === 'video');
    const audio = probe.index.tracks.find(track => track.kind === 'audio');
    const durationUs = Math.max(1, probe.index.durationUs);
    const project = session.getSnapshot().project;
    if (project === null) throw new Error('Project is not loaded');
    const format = this.format;
    const videoPlace =
      video === undefined
        ? undefined
        : resolveInsertPlacement(project, {
            kind: 'visual',
            startUs: atUs,
            durationUs,
            policy: 'sequence',
          });
    const alignedStartUs = videoPlace?.startUs ?? Math.max(0, atUs);
    const audioPlace =
      audio === undefined
        ? undefined
        : resolveInsertPlacement(project, {
            kind: 'audio',
            startUs: alignedStartUs,
            durationUs,
            policy: 'overlay',
          });
    const videoItemId =
      video !== undefined && videoPlace !== undefined ? this.ids.next('item') : undefined;
    const audioItemId =
      audio !== undefined && audioPlace !== undefined ? this.ids.next('item') : undefined;

    session.transaction.edit(
      tx => {
        tx.createEntity('assets', assetId, {
          id: assetId,
          kind,
          name,
          locator: { type: 'url', uri: url },
          probeHint: {
            durationUs: probe.index.durationUs,
            ...(video === undefined ? {} : videoDisplaySize(video)),
          },
          metadata: { url },
        });
        const videoTrackId =
          videoPlace === undefined
            ? undefined
            : this.#trackIdForPlacement(tx, videoPlace, 'visual');
        const audioTrackId =
          audioPlace === undefined ? undefined : this.#trackIdForPlacement(tx, audioPlace, 'audio');
        if (videoItemId !== undefined && videoTrackId !== undefined && video !== undefined) {
          tx.createEntity(
            'items',
            videoItemId,
            mediaItem({
              id: videoItemId,
              trackId: videoTrackId,
              kind: 'video',
              assetId,
              name,
              atUs: videoPlace?.startUs ?? alignedStartUs,
              durationUs,
              format,
              sourceWidth: video.codedWidth,
              sourceHeight: video.codedHeight,
            }) as unknown as JsonObject,
          );
          tx.listInsert('tracks', videoTrackId, ['itemIds'], videoItemId);
        }
        if (audioItemId !== undefined && audioTrackId !== undefined && audio !== undefined) {
          tx.createEntity(
            'items',
            audioItemId,
            mediaItem({
              id: audioItemId,
              trackId: audioTrackId,
              kind: 'audio',
              assetId,
              name,
              atUs: alignedStartUs,
              durationUs,
              format,
            }) as unknown as JsonObject,
          );
          tx.listInsert('tracks', audioTrackId, ['itemIds'], audioItemId);
        }
      },
      { label: `导入 URL` },
    );
    await this.#silenceIdleTransport();
    void this.#captureThumb(assetId, kind);
    return {
      assetId,
      name,
      kind,
      durationUs,
      ...(videoItemId === undefined ? {} : { videoItemId }),
      ...(audioItemId === undefined ? {} : { audioItemId }),
    };
  }

  #trackIdForPlacement(
    tx: {
      createEntity(collection: 'tracks', id: string, value: JsonObject): void;
      listInsert(
        collection: 'sequences',
        id: string,
        path: readonly string[],
        value: string,
        beforeId?: string,
      ): void;
    },
    placement: InsertPlacement,
    kind: 'visual' | 'audio' | 'caption',
  ): string {
    if (!placement.createTrack) return placement.trackId;
    const project = this.project;
    if (project === null) throw new Error('Project is not loaded');
    const track = newTrackEntity({ ids: this.ids, project, kind });
    const beforeId = newTrackAnchorId(project, kind);
    tx.createEntity('tracks', track.id, track as unknown as JsonObject);
    tx.listInsert('sequences', track.sequenceId, ['trackIds'], track.id, beforeId);
    return track.id;
  }

  public async ensureWaveform(item: ItemEntity): Promise<WaveformPeaks | undefined> {
    if (item.type !== 'audio' || this.session === undefined) return undefined;
    const cached = this.waveforms.get(item.id);
    if (cached !== undefined) return cached;
    try {
      const durationSec = Math.max(1, item.range.durationUs / 1_000_000);
      const result = await this.session.audio.waveform({
        itemIds: [item.id],
        maxPoints: Math.min(6_000, Math.max(400, Math.round(durationSec * 100))),
        signal: this.#waveformAbort.signal,
      });
      this.waveforms.set(item.id, result);
      return result;
    } catch {
      return undefined;
    }
  }

  #pruneWaveforms(): void {
    const project = this.project;
    if (project === null) {
      this.waveforms.clear();
      return;
    }
    for (const id of [...this.waveforms.keys()]) {
      if (project.items[id]?.type !== 'audio') this.waveforms.delete(id);
    }
  }

  #filmstripKey(item: ItemEntity): string | undefined {
    const ref = itemMediaRef(item);
    if (ref === undefined || (item.type !== 'video' && item.type !== 'image')) return undefined;
    return `${ref.assetId}:${ref.streamIndex.toString()}:${ref.startUs.toString()}:${item.range.durationUs.toString()}:${item.type}`;
  }

  public hasCurrentFilmstrip(item: ItemEntity): boolean {
    const key = this.#filmstripKey(item);
    return (
      key !== undefined && this.#filmstripKeys.get(item.id) === key && this.filmstrips.has(item.id)
    );
  }

  public abortBackgroundFilmstrips(): void {
    this.#filmstripAbort.abort(new DOMException('Playback started', 'AbortError'));
    this.#filmstripAbort = new AbortController();
  }

  public abortBackgroundWaveforms(): void {
    this.#waveformAbort.abort(new DOMException('Playback started', 'AbortError'));
    this.#waveformAbort = new AbortController();
  }

  public async ensureFilmstrip(item: ItemEntity): Promise<void> {
    const pending = this.#filmstripTail.then(() => this.#renderFilmstrip(item));
    this.#filmstripTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async #renderFilmstrip(item: ItemEntity): Promise<void> {
    if (this.session?.player.state === 'playing') return;
    if ((item.type !== 'video' && item.type !== 'image') || this.media === undefined) return;
    const key = this.#filmstripKey(item);
    if (key === undefined || this.hasCurrentFilmstrip(item)) return;
    const ref = itemMediaRef(item);
    if (ref === undefined) return;
    const signal = this.#filmstripAbort.signal;
    const tileCount =
      item.type === 'image'
        ? 1
        : Math.min(10, Math.max(2, Math.round(item.range.durationUs / 750_000)));
    const frames: VideoFrame[] = [];
    try {
      for (let index = 0; index < tileCount; index += 1) {
        if (signal.aborted) return;
        const timeUs =
          ref.startUs +
          Math.floor(((index + 0.5) / tileCount) * Math.max(1, item.range.durationUs));
        frames.push(
          await this.media.frameAt(ref.assetId, ref.streamIndex, Math.max(0, timeUs), signal, {
            purpose: 'preview',
            maxDimension: 96,
            transient: true,
          }),
        );
      }
      const first = frames[0];
      if (first === undefined) return;
      const aspect = first.displayHeight === 0 ? 16 / 9 : first.displayWidth / first.displayHeight;
      const tileHeight = 48;
      const tileWidth = Math.max(1, Math.round(tileHeight * aspect));
      const canvas = document.createElement('canvas');
      canvas.width = tileWidth * frames.length;
      canvas.height = tileHeight;
      const context = canvas.getContext('2d');
      if (context === null) return;
      frames.forEach((frame, index) => {
        context.drawImage(frame, index * tileWidth, 0, tileWidth, tileHeight);
      });
      const blob = await new Promise<Blob | null>(resolve =>
        canvas.toBlob(resolve, 'image/jpeg', 0.7),
      );
      if (blob === null) return;
      const current = this.project?.items[item.id];
      if (current === undefined || this.#filmstripKey(current) !== key) return;
      const previous = this.filmstrips.get(item.id);
      if (previous !== undefined) URL.revokeObjectURL(previous);
      this.filmstrips.set(item.id, URL.createObjectURL(blob));
      this.#filmstripKeys.set(item.id, key);
      this.#onChange?.();
    } catch {
      // Filmstrip generation is best-effort.
    } finally {
      for (const frame of frames) frame.close();
    }
  }

  #pruneFilmstrips(): void {
    const project = this.project;
    if (project === null) {
      this.#revokeFilmstrips();
      return;
    }
    for (const id of [...this.filmstrips.keys()]) {
      const item = project.items[id];
      if (item === undefined || (item.type !== 'video' && item.type !== 'image')) {
        const url = this.filmstrips.get(id);
        if (url !== undefined) URL.revokeObjectURL(url);
        this.filmstrips.delete(id);
        this.#filmstripKeys.delete(id);
      }
    }
  }

  #revokeFilmstrips(): void {
    for (const url of this.filmstrips.values()) URL.revokeObjectURL(url);
    this.filmstrips.clear();
    this.#filmstripKeys.clear();
  }

  public async dispose(): Promise<void> {
    this.endGesture();
    this.#unsubscribe?.();
    this.#onChange = undefined;
    this.preview?.dispose();
    this.preview = undefined;
    const persistence = this.persistence;
    const session = this.session;
    const media = this.media;
    this.persistence = undefined;
    this.session = undefined;
    this.media = undefined;
    this.#uninstallMaterials?.();
    this.#uninstallMaterials = undefined;
    this.#materials = undefined;
    this.#revokeThumbs();
    this.#revokeFilmstrips();
    try {
      await persistence?.dispose();
    } finally {
      try {
        await session?.dispose();
      } finally {
        media?.dispose();
      }
    }
  }

  async #createRuntime(onChange: () => void, onError: (message: string) => void): Promise<void> {
    this.media = new ProductionMediaProvider({
      maxCachedIndexes: 12,
      maxCachedIndexBytes: 96 * 1024 * 1024,
      maxConcurrentOperations: 4,
      maxPendingOperations: 64,
    });
    this.#materials = new RuntimeMaterialRegistry();
    this.#uninstallMaterials = installMigrationMaterials(this.#materials);
    const session = await Aelion.createSession({
      media: this.media,
      materials: this.#materials,
      // Auto explores WebGPU after a few frames; stay on one backend while dragging.
      preferredBackend: 'webgl2',
      allowBackendFallback: true,
    });
    this.session = session;
    this.#guardIdleTransport(session.player);
    this.#unsubscribe = session.subscribe(event => {
      if (event.type === 'project-changed') {
        this.ids.observe(session.getSnapshot().project);
        this.#pruneWaveforms();
        this.#pruneFilmstrips();
        onChange();
      }
      if (event.type === 'stats-changed') {
        const state = session.player.state;
        if (state !== this.#emittedPlayerState) {
          this.#emittedPlayerState = state;
          this.#onPlayerState?.(state);
        }
      }
      if (event.type === 'diagnostic' && event.diagnostic.severity === 'error') {
        if (!event.diagnostic.message.includes('outside the Render IR duration')) {
          onError(event.diagnostic.message);
        }
      }
    });
  }

  #guardIdleTransport(player: {
    readonly state: string;
    invalidate?: (changeSet: unknown) => void;
  }): void {
    const invalidate = player.invalidate?.bind(player);
    if (invalidate === undefined) return;
    player.invalidate = changeSet => {
      if (player.state !== 'playing') return;
      invalidate(changeSet);
    };
  }

  async #silenceIdleTransport(): Promise<void> {
    const player = this.session?.player as
      | {
          readonly state: string;
          pause(): Promise<void>;
          reset?: () => Promise<void>;
        }
      | undefined;
    if (player === undefined || player.state === 'playing') return;
    await player.pause();
    await player.reset?.();
  }

  #attachPreview(canvas: HTMLCanvasElement, onError: (message: string) => void): void {
    const session = this.session;
    if (session === undefined) return;
    this.preview?.dispose();
    this.preview = attachPreviewCanvas(session, canvas, {
      quality: this.#quality,
      fit: 'contain',
      background: '#0b0b0b',
      onError: error => onError(errorMessage(error, '预览失败')),
      onFrame: () => this.#onPreviewReady?.(),
      onPointer: event => this.#onPreviewPointer?.(event),
    });
  }

  async #rebindAssets(): Promise<void> {
    const project = this.project;
    const media = this.media;
    if (project === null || media === undefined) return;
    for (const asset of Object.values(project.assets)) {
      const locator = (asset as JsonObject).locator;
      const metadata = (asset as JsonObject).metadata;
      const kind = (asset as JsonObject).kind;
      if (locator !== null && typeof locator === 'object' && !Array.isArray(locator)) {
        const type = (locator as JsonObject).type;
        if (type === 'url' && typeof (locator as JsonObject).uri === 'string') {
          media.registerUrl(asset.id, (locator as JsonObject).uri as string);
          continue;
        }
        if (type === 'opfs' && typeof (locator as JsonObject).path === 'string') {
          const path = (locator as JsonObject).path as string;
          const file = await readCachedMedia(path);
          if (file !== undefined) {
            this.#registerRestoredAsset(media, asset.id, kind, file, asset as JsonObject);
            continue;
          }
        }
      }
      if (metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)) {
        const opfsPath = (metadata as JsonObject).opfsPath;
        const url = (metadata as JsonObject).url;
        if (typeof opfsPath === 'string') {
          const file = await readCachedMedia(opfsPath);
          if (file !== undefined) {
            this.#registerRestoredAsset(media, asset.id, kind, file, asset as JsonObject);
          }
        } else if (typeof url === 'string') {
          media.registerUrl(asset.id, url);
        }
      }
    }
    for (const asset of Object.values(project.assets)) {
      const kind = (asset as JsonObject).kind;
      if (kind === 'video' || kind === 'image') {
        void this.#captureThumb(asset.id, kind);
      }
    }
  }

  #registerRestoredAsset(
    media: ProductionMediaProvider,
    assetId: string,
    kind: unknown,
    file: File,
    asset: JsonObject,
  ): void {
    const mimeType = typeof asset.mimeType === 'string' ? asset.mimeType : undefined;
    if (kind === 'image') {
      media.registerImageFile(
        assetId,
        mimeType === undefined ? file : withMimeType(file, mimeType),
        mimeType === undefined ? {} : { mimeType },
      );
      return;
    }
    media.registerFile(assetId, mimeType === undefined ? file : withMimeType(file, mimeType));
  }

  async #captureThumb(assetId: string, kind: 'video' | 'audio' | 'image'): Promise<void> {
    if (kind === 'audio' || this.media === undefined) return;
    try {
      const frame = await this.media.frameAt(assetId, 0, 0, undefined, {
        purpose: 'preview',
        maxDimension: 160,
        transient: true,
      });
      // The provider capped this frame at `maxDimension` already, so draw it at
      // the size it arrived: halving it again would leave an 80px-wide tile.
      // The frame is also no longer a witness to the source's real dimensions,
      // which now come from rotation-corrected probe metadata at import.
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, frame.displayWidth);
      canvas.height = Math.max(1, frame.displayHeight);
      const context = canvas.getContext('2d');
      if (context === null) {
        frame.close();
        return;
      }
      context.drawImage(frame, 0, 0, canvas.width, canvas.height);
      frame.close();
      const blob = await new Promise<Blob | null>(resolve =>
        canvas.toBlob(resolve, 'image/jpeg', 0.72),
      );
      if (blob === null) return;
      const previous = this.thumbs.get(assetId);
      if (previous !== undefined) URL.revokeObjectURL(previous);
      this.thumbs.set(assetId, URL.createObjectURL(blob));
      this.#onChange?.();
    } catch {
      // Thumbnail generation is best-effort.
    }
  }

  #revokeThumbs(): void {
    for (const url of this.thumbs.values()) URL.revokeObjectURL(url);
    this.thumbs.clear();
  }
}

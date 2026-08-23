import type { JsonObject, JsonValue } from '@aelionsdk/core';
import type {
  AelionProject,
  ItemEntity,
  MarkerEntity,
  TrackEntity,
  TransitionEntity,
} from '@aelionsdk/project-schema';
import { createProject, seconds, type CreateProjectOptions } from '@aelionsdk/sdk';

import { parseHexColor } from './color.js';
import type { IdFactory } from './ids.js';
import { fittedTextBox, jsonBox } from './text-metrics.js';

export interface SequenceFormat {
  readonly width: number;
  readonly height: number;
  readonly frameRate: { readonly numerator: number; readonly denominator: number };
}

export interface VisualPatch {
  readonly fit?: 'contain' | 'cover' | 'fill' | 'none';
  readonly opacity?: number;
  readonly blendMode?:
    | 'normal'
    | 'multiply'
    | 'screen'
    | 'overlay'
    | 'darken'
    | 'lighten'
    | 'color-dodge'
    | 'color-burn'
    | 'hard-light'
    | 'soft-light'
    | 'difference'
    | 'exclusion';
  readonly positionPx?: { readonly x: number; readonly y: number };
  readonly scale?: { readonly x: number; readonly y: number };
  readonly rotationDeg?: number;
}

export const MIGRATION_PACKAGE = {
  packageId: 'aelion.migration.builtin',
  packageVersion: '1.0.0',
  packageIntegrity: `sha256:${'9d'.repeat(32)}`,
} as const;

export const EFFECT_CATALOG = [
  {
    id: 'diffusion-brightness',
    name: '亮度',
    value: 100,
    min: 0,
    max: 200,
    step: 1,
    label: '强度',
  },
  {
    id: 'diffusion-contrast',
    name: '对比度',
    value: 100,
    min: 0,
    max: 200,
    step: 1,
    label: '强度',
  },
  {
    id: 'diffusion-saturate',
    name: '饱和度',
    value: 100,
    min: 0,
    max: 200,
    step: 1,
    label: '强度',
  },
  { id: 'diffusion-grayscale', name: '黑白', value: 100, min: 0, max: 100, step: 1, label: '强度' },
  { id: 'diffusion-sepia', name: '棕褐', value: 80, min: 0, max: 100, step: 1, label: '强度' },
  {
    id: 'diffusion-hue-rotate',
    name: '色相',
    value: 0,
    min: -180,
    max: 180,
    step: 1,
    label: '角度',
  },
  { id: 'diffusion-invert', name: '反相', value: 100, min: 0, max: 100, step: 1, label: '强度' },
  { id: 'diffusion-blur', name: '模糊', value: 8, min: 0, max: 40, step: 0.5, label: '半径' },
] as const;

export type EffectCatalogEntry = (typeof EFFECT_CATALOG)[number];

export function effectCatalogEntry(materialId: string): EffectCatalogEntry | undefined {
  return EFFECT_CATALOG.find(entry => entry.id === materialId);
}

export function instanceMaterialId(instance: JsonObject | undefined): string | undefined {
  if (instance === undefined) return undefined;
  const definition = instance.definition;
  if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
    return undefined;
  }
  const materialId = (definition as JsonObject).materialId;
  return typeof materialId === 'string' ? materialId : undefined;
}

export const TRANSITION_CATALOG = [
  { id: 'diffusion-dissolve', name: '交叉叠化' },
  { id: 'diffusion-slide-from-right', name: '右滑入' },
  { id: 'diffusion-slide-from-left', name: '左滑入' },
  { id: 'diffusion-fade-to-black', name: '闪黑' },
  { id: 'diffusion-fade-to-white', name: '闪白' },
] as const;

export function sequenceFormat(project: AelionProject): SequenceFormat {
  const sequence = project.sequences[project.settings.defaultSequenceId];
  const format = sequence?.format;
  return {
    width: typeof format?.width === 'number' ? format.width : 1920,
    height: typeof format?.height === 'number' ? format.height : 1080,
    frameRate:
      format?.frameRate !== undefined
        ? { numerator: format.frameRate.numerator, denominator: format.frameRate.denominator }
        : { numerator: 30, denominator: 1 },
  };
}

export function contentDurationUs(project: AelionProject): number {
  let maxUs = 0;
  for (const item of Object.values(project.items)) {
    maxUs = Math.max(maxUs, item.range.startUs + item.range.durationUs);
  }
  return maxUs;
}

export function transitionLabel(project: AelionProject, transition: TransitionEntity): string {
  const instance = project.materialInstances[transition.materialInstanceId];
  const rawName = instance === undefined ? undefined : (instance as JsonObject).name;
  if (typeof rawName === 'string' && rawName.length > 0) return rawName;
  return '转场';
}

export function visualFitScale(
  fit: string | undefined,
  sourceWidth: number,
  sourceHeight: number,
  destWidth: number,
  destHeight: number,
): { readonly x: number; readonly y: number } {
  if (
    !(sourceWidth > 0) ||
    !(sourceHeight > 0) ||
    !(destWidth > 0) ||
    !(destHeight > 0) ||
    fit === 'fill'
  ) {
    return { x: 1, y: 1 };
  }
  if (fit === 'none') {
    return { x: sourceWidth / destWidth, y: sourceHeight / destHeight };
  }
  const sourceAspect = sourceWidth / sourceHeight;
  const destAspect = destWidth / destHeight;
  return sourceAspect > destAspect
    ? { x: 1, y: destAspect / sourceAspect }
    : { x: sourceAspect / destAspect, y: 1 };
}

export function assetHasEmbeddedAudio(asset: JsonObject): boolean {
  if (asset.kind === 'audio') return true;
  const probe = asset.probeHint;
  if (probe === null || probe === undefined || typeof probe !== 'object' || Array.isArray(probe)) {
    return false;
  }
  return typeof (probe as JsonObject).audioCodec === 'string';
}

export function probeSourceSize(
  probe: unknown,
): { readonly width: number; readonly height: number } | undefined {
  if (probe === null || probe === undefined || typeof probe !== 'object' || Array.isArray(probe)) {
    return undefined;
  }
  const record = probe as JsonObject;
  const width = typeof record.width === 'number' ? record.width : undefined;
  const height = typeof record.height === 'number' ? record.height : undefined;
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return undefined;
  return { width, height };
}

export function mediaSourceSize(
  project: AelionProject,
  item: ItemEntity,
): { readonly width: number; readonly height: number } | undefined {
  const ref = itemMediaRef(item);
  if (ref === undefined) return undefined;
  const asset = project.assets[ref.assetId] as JsonObject | undefined;
  return probeSourceSize(asset?.probeHint);
}

export function defaultVisual(format: SequenceFormat, opacity = 1): JsonObject {
  return {
    fit: 'contain',
    transform: {
      positionPx: { x: format.width / 2, y: format.height / 2 },
      anchor: { x: 0.5, y: 0.5 },
      scale: { x: 1, y: 1 },
      rotationDeg: 0,
      skewDeg: { x: 0, y: 0 },
    },
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
    opacity,
    blendMode: 'normal',
  };
}

export function mediaLayerVisual(
  format: SequenceFormat,
  _sourceWidth?: number,
  _sourceHeight?: number,
): JsonObject {
  return { ...defaultVisual(format), fit: 'contain' };
}

export function createEmptyProject(options: CreateProjectOptions): AelionProject {
  const builder = createProject(options);
  builder.addTrack({ id: 'track_v1', kind: 'visual', name: 'V1' });
  builder.addTrack({ id: 'track_v2', kind: 'visual', name: 'V2' });
  builder.addTrack({ id: 'track_v3', kind: 'visual', name: 'V3' });
  builder.addTrack({ id: 'track_c1', kind: 'caption', name: 'C1' });
  builder.addTrack({ id: 'track_a1', kind: 'audio', name: 'A1' });
  builder.addTrack({ id: 'track_a2', kind: 'audio', name: 'A2' });
  return builder.build();
}

export function firstTrackId(
  project: AelionProject,
  kind: TrackEntity['kind'],
): string | undefined {
  const sequence = project.sequences[project.settings.defaultSequenceId];
  return sequence?.trackIds.find(id => project.tracks[id]?.kind === kind);
}

export function orderedTracks(project: AelionProject): TrackEntity[] {
  const sequence = project.sequences[project.settings.defaultSequenceId];
  if (sequence === undefined) return [];
  const tracks = sequence.trackIds.flatMap(id => {
    const track = project.tracks[id];
    return track === undefined ? [] : [track];
  });
  const visual = tracks.filter(track => track.kind === 'visual').reverse();
  const caption = tracks.filter(track => track.kind === 'caption');
  const audio = tracks.filter(track => track.kind === 'audio');
  return [...visual, ...caption, ...audio];
}

export function itemSource(item: ItemEntity): JsonObject | undefined {
  const source = (item as JsonObject).source;
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return undefined;
  return source;
}

export function itemMediaRef(
  item: ItemEntity,
):
  | { readonly assetId: string; readonly startUs: number; readonly streamIndex: number }
  | undefined {
  const source = itemSource(item);
  if (source === undefined || typeof source.assetId !== 'string') return undefined;
  const range = source.sourceRange;
  const stream = source.stream;
  const startUs =
    range !== null && typeof range === 'object' && !Array.isArray(range)
      ? numberField((range as JsonObject).startUs, 0)
      : 0;
  const streamIndex =
    stream !== null && typeof stream === 'object' && !Array.isArray(stream)
      ? numberField((stream as JsonObject).index, 0)
      : 0;
  return { assetId: source.assetId, startUs, streamIndex };
}

export function itemVisual(item: ItemEntity): JsonObject | undefined {
  const visual = (item as JsonObject).visual;
  if (visual === null || typeof visual !== 'object' || Array.isArray(visual)) return undefined;
  return visual;
}

export function itemAudio(item: ItemEntity): JsonObject | undefined {
  const audio = (item as JsonObject).audio;
  if (audio === null || typeof audio !== 'object' || Array.isArray(audio)) return undefined;
  return audio;
}

export function linkedMixerItem(
  project: AelionProject,
  item: ItemEntity,
): ItemEntity | undefined {
  if (itemAudio(item) !== undefined) return item;
  const group = item.linkGroupId === undefined ? undefined : project.linkGroups[item.linkGroupId];
  if (group === undefined) return undefined;
  for (const id of group.itemIds) {
    if (id === item.id) continue;
    const other = project.items[id];
    if (other !== undefined && itemAudio(other) !== undefined) return other;
  }
  return undefined;
}

export function numberField(value: JsonValue | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function stringField(value: JsonValue | undefined, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function vecField(
  value: JsonValue | undefined,
  fallback: { x: number; y: number },
): { x: number; y: number } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const record = value as { x?: unknown; y?: unknown };
  return {
    x: typeof record.x === 'number' ? record.x : fallback.x,
    y: typeof record.y === 'number' ? record.y : fallback.y,
  };
}

export interface VisualTransform {
  readonly positionPx: { readonly x: number; readonly y: number };
  readonly scale: { readonly x: number; readonly y: number };
  readonly rotationDeg: number;
  readonly anchor: { readonly x: number; readonly y: number };
}

export function readTransform(item: ItemEntity): VisualTransform {
  const visual = itemVisual(item);
  const transform = visual?.transform;
  if (transform === null || typeof transform !== 'object' || Array.isArray(transform)) {
    return {
      positionPx: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotationDeg: 0,
      anchor: { x: 0.5, y: 0.5 },
    };
  }
  const record = transform as JsonObject;
  return {
    positionPx: vecField(record.positionPx, { x: 0, y: 0 }),
    scale: vecField(record.scale, { x: 1, y: 1 }),
    rotationDeg: numberField(record.rotationDeg, 0),
    anchor: vecField(record.anchor, { x: 0.5, y: 0.5 }),
  };
}

export function readFittedTransform(
  item: ItemEntity,
  format: SequenceFormat,
  project: AelionProject | null = null,
): VisualTransform {
  const transform = readTransform(item);
  const size = project === null ? undefined : mediaSourceSize(project, item);
  if (size === undefined) return transform;
  const fit = itemVisual(item)?.fit;
  const fitted = visualFitScale(
    typeof fit === 'string' ? fit : undefined,
    size.width,
    size.height,
    format.width,
    format.height,
  );
  return {
    ...transform,
    scale: { x: transform.scale.x * fitted.x, y: transform.scale.y * fitted.y },
  };
}

export function clipLabel(item: ItemEntity): string {
  if (typeof item.name === 'string' && item.name.length > 0) return item.name;
  if (item.type === 'text') {
    const paragraphs = (item as JsonObject).paragraphs;
    if (Array.isArray(paragraphs)) {
      const first = paragraphs[0];
      if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
        const runs = (first as JsonObject).runs;
        if (Array.isArray(runs)) {
          const text = runs
            .map(run =>
              run !== null && typeof run === 'object' && !Array.isArray(run)
                ? stringField((run as JsonObject).text)
                : '',
            )
            .join('');
          if (text.length > 0) return text;
        }
      }
    }
  }
  if (item.type === 'caption') return stringField((item as JsonObject).text, '字幕');
  return item.type;
}

export function linearTimeMapping(
  rate = { numerator: 1, denominator: 1 },
  reverse = false,
  boundary: 'error' | 'hold' | 'loop' | 'transparent' = 'hold',
): JsonObject {
  return {
    type: 'linear',
    rate: { numerator: rate.numerator, denominator: rate.denominator },
    reverse,
    boundary,
  };
}

export function mediaItem(options: {
  readonly id: string;
  readonly trackId: string;
  readonly kind: 'video' | 'audio';
  readonly assetId: string;
  readonly name: string;
  readonly atUs: number;
  readonly durationUs: number;
  readonly sourceStartUs?: number;
  readonly streamIndex?: number;
  readonly format: SequenceFormat;
  readonly sourceWidth?: number;
  readonly sourceHeight?: number;
}): ItemEntity {
  const source = {
    assetId: options.assetId,
    stream: { type: options.kind, index: options.streamIndex ?? 0 },
    sourceRange: { startUs: options.sourceStartUs ?? 0, durationUs: options.durationUs },
    timeMapping: linearTimeMapping(),
  };
  if (options.kind === 'video') {
    return {
      id: options.id,
      trackId: options.trackId,
      type: 'video',
      name: options.name,
      enabled: true,
      range: { startUs: options.atUs, durationUs: options.durationUs },
      source,
      visual: mediaLayerVisual(options.format, options.sourceWidth, options.sourceHeight),
      materialInstanceIds: [],
    };
  }
  return {
    id: options.id,
    trackId: options.trackId,
    type: 'audio',
    name: options.name,
    enabled: true,
    range: { startUs: options.atUs, durationUs: options.durationUs },
    source,
    audio: { gainDb: 0, pan: 0, fadeInUs: 0, fadeOutUs: 0, pitchPolicy: 'varispeed' },
    materialInstanceIds: [],
  };
}

export function imageItem(options: {
  readonly id: string;
  readonly trackId: string;
  readonly assetId: string;
  readonly name: string;
  readonly atUs: number;
  readonly durationUs: number;
  readonly format: SequenceFormat;
  readonly sourceWidth?: number;
  readonly sourceHeight?: number;
}): ItemEntity {
  return {
    id: options.id,
    trackId: options.trackId,
    type: 'image',
    name: options.name,
    enabled: true,
    range: { startUs: options.atUs, durationUs: options.durationUs },
    source: {
      assetId: options.assetId,
      stream: { type: 'video', index: 0 },
      sourceRange: { startUs: 0, durationUs: options.durationUs },
      timeMapping: linearTimeMapping(),
    },
    visual: mediaLayerVisual(options.format, options.sourceWidth, options.sourceHeight),
    materialInstanceIds: [],
  };
}

export function textItem(options: {
  readonly id: string;
  readonly trackId: string;
  readonly text: string;
  readonly atUs: number;
  readonly durationUs: number;
  readonly format: SequenceFormat;
  readonly fontSizePx?: number;
  readonly fill?: string;
  readonly name?: string;
}): ItemEntity {
  const fontSizePx = options.fontSizePx ?? 72;
  const box = fittedTextBox(options.text, fontSizePx, options.format);
  return {
    id: options.id,
    trackId: options.trackId,
    type: 'text',
    name: options.name ?? options.text.slice(0, 24),
    enabled: true,
    range: { startUs: options.atUs, durationUs: options.durationUs },
    box: jsonBox(box),
    overflow: 'auto-fit',
    writingMode: 'horizontal-tb',
    paragraphs: [
      {
        style: {},
        runs: [
          {
            text: options.text,
            style: {
              fontFamilies: ['Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'sans-serif'],
              fontSizePx,
              fontWeight: 700,
              fill: options.fill ?? '#ffffff',
            },
          },
        ],
      },
    ],
    visual: { ...defaultVisual(options.format), fit: 'none' },
    materialInstanceIds: [],
  };
}

export function captionItem(options: {
  readonly id: string;
  readonly trackId: string;
  readonly text: string;
  readonly atUs: number;
  readonly durationUs: number;
  readonly format: SequenceFormat;
}): ItemEntity {
  return {
    id: options.id,
    trackId: options.trackId,
    type: 'caption',
    name: options.text.slice(0, 24),
    enabled: true,
    range: { startUs: options.atUs, durationUs: options.durationUs },
    text: options.text,
    box: jsonBox(fittedTextBox(options.text, 42, options.format, { yRatio: 0.78 })),
    style: {
      fontFamilies: ['Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'sans-serif'],
      fontSizePx: 42,
      fontWeight: 600,
      fill: '#ffffff',
      stroke: '#000000',
      strokeWidthPx: 2,
      align: 'center',
    },
    overflow: 'auto-fit',
    visual: { ...defaultVisual(options.format), fit: 'none' },
    materialInstanceIds: [],
  };
}

export function shapeItem(options: {
  readonly id: string;
  readonly trackId: string;
  readonly kind: 'rectangle' | 'ellipse';
  readonly atUs: number;
  readonly durationUs: number;
  readonly format: SequenceFormat;
  readonly fill: string;
}): ItemEntity {
  const size = Math.min(options.format.width, options.format.height) * 0.45;
  return {
    id: options.id,
    trackId: options.trackId,
    type: 'shape',
    name: options.kind === 'rectangle' ? '矩形' : '椭圆',
    enabled: true,
    range: { startUs: options.atUs, durationUs: options.durationUs },
    shape: {
      kind: options.kind,
      box: {
        x: (options.format.width - size) / 2,
        y: (options.format.height - size) / 2,
        width: size,
        height: size,
      },
      fill: parseHexColor(options.fill),
      cornerRadiusPx: options.kind === 'rectangle' ? 8 : 0,
    },
    visual: { ...defaultVisual(options.format), fit: 'none' },
    materialInstanceIds: [],
  };
}

export function generatorItem(options: {
  readonly id: string;
  readonly trackId: string;
  readonly kind: 'solid' | 'linear-gradient';
  readonly colors: readonly string[];
  readonly atUs: number;
  readonly durationUs: number;
  readonly format: SequenceFormat;
  readonly name: string;
}): ItemEntity {
  return {
    id: options.id,
    trackId: options.trackId,
    type: 'generator',
    name: options.name,
    enabled: true,
    range: { startUs: options.atUs, durationUs: options.durationUs },
    generator: {
      kind: options.kind,
      colors: options.colors.map(parseHexColor),
      ...(options.kind === 'linear-gradient' ? { angleDeg: 90 } : {}),
    },
    visual: defaultVisual(options.format),
    materialInstanceIds: [],
  };
}

export function adjustmentItem(options: {
  readonly id: string;
  readonly trackId: string;
  readonly atUs: number;
  readonly durationUs: number;
  readonly format: SequenceFormat;
}): ItemEntity {
  return {
    id: options.id,
    trackId: options.trackId,
    type: 'adjustment',
    name: '调整图层',
    enabled: true,
    range: { startUs: options.atUs, durationUs: options.durationUs },
    visual: defaultVisual(options.format),
    materialInstanceIds: [],
  };
}

export function materialInstanceEntity(options: {
  readonly id: string;
  readonly materialId: string;
  readonly name: string;
  readonly parameters?: JsonObject;
}): JsonObject {
  return {
    id: options.id,
    definition: { ...MIGRATION_PACKAGE, materialId: options.materialId },
    name: options.name,
    enabled: true,
    previewPolicy: 'required',
    parameters: options.parameters ?? { value: 100 },
  };
}

export function markerEntity(options: {
  readonly id: string;
  readonly timeUs: number;
  readonly label: string;
  readonly color?: string;
  readonly sequenceId?: string;
  readonly itemId?: string;
}): MarkerEntity {
  return {
    id: options.id,
    owner:
      options.itemId === undefined
        ? { type: 'sequence', id: options.sequenceId ?? '' }
        : { type: 'item', id: options.itemId },
    timeUs: options.timeUs,
    durationUs: 0,
    label: options.label,
    color: options.color ?? '#e85d4c',
  };
}

export function newTrackEntity(options: {
  readonly ids: IdFactory;
  readonly project: AelionProject;
  readonly kind: TrackEntity['kind'];
}): TrackEntity {
  const counts = Object.values(options.project.tracks).filter(
    track => track.kind === options.kind,
  ).length;
  const prefix = options.kind === 'visual' ? 'V' : options.kind === 'audio' ? 'A' : 'C';
  const id = options.ids.next(`track_${options.kind}`);
  return {
    id,
    sequenceId: options.project.settings.defaultSequenceId,
    kind: options.kind,
    name: `${prefix}${counts + 1}`,
    enabled: true,
    locked: false,
    itemIds: [],
    materialInstanceIds: [],
    ...(options.kind === 'audio'
      ? { audio: { gainDb: 0, pan: 0, muted: false, solo: false } }
      : {}),
  };
}

export const STILL_DURATION_US = seconds(5);
export const TITLE_DURATION_US = seconds(4);

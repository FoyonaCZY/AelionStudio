import type { JsonObject } from '@aelionsdk/core';
import type { AelionProject, ItemEntity, TrackEntity } from '@aelionsdk/project-schema';
import {
  buildRateEnvelope,
  seconds,
  type AelionInteractiveEdit,
  type AelionSessionApi,
} from '@aelionsdk/sdk';

import { parseHexColor } from './color.js';
import type { EditorEngine } from './engine.js';
import {
  STILL_DURATION_US,
  effectCatalogEntry,
  instanceMaterialId,
  TITLE_DURATION_US,
  TRANSITION_CATALOG,
  adjustmentItem,
  captionItem,
  clipLabel,
  generatorItem,
  imageItem,
  itemAudio,
  itemSource,
  itemVisual,
  linearTimeMapping,
  materialInstanceEntity,
  markerEntity,
  mediaItem,
  newTrackEntity,
  probeSourceSize,
  readTransform,
  sequenceFormat,
  shapeItem,
  textItem,
  type VisualPatch,
} from './project.js';
import { frameDurationUs } from './format.js';
import {
  boxKeepingCenter,
  jsonBox,
  itemPlainText,
  itemStyleRecord,
  measurePlainText,
  readItemTextStyle,
  textInkBox,
} from './text-metrics.js';
import {
  insertPolicyForMedia,
  magnetStartOnTrack,
  newTrackAnchorId,
  overlappingItemOnTrack,
  packLeftRightSwap,
  resolveInsertPlacement,
  settleAfterPackedPair,
  shouldSwapOccupant,
  type ResolveInsertOptions,
} from './timeline-layout.js';

export type LibraryDropKind =
  | 'text-title'
  | 'text-subtitle'
  | 'caption'
  | 'shape-rect'
  | 'shape-ellipse'
  | 'matte-black'
  | 'matte-white'
  | 'gradient'
  | 'adjustment'
  | `effect:${string}`
  | `transition:${string}`
  | `asset:${string}`;

function requireSession(engine: EditorEngine): AelionSessionApi {
  if (engine.session === undefined) throw new Error('Session is not ready');
  return engine.session;
}

type EditCallback = Parameters<AelionSessionApi['transaction']['edit']>[0];

function write(
  engine: EditorEngine,
  label: string,
  apply: EditCallback,
  interactive?: AelionInteractiveEdit,
): void {
  if (interactive?.active === true) {
    interactive.update(apply);
    return;
  }
  requireSession(engine).transaction.edit(apply, { label });
}

function requireProject(engine: EditorEngine): AelionProject {
  const project = engine.project;
  if (project === null) throw new Error('Project is not loaded');
  return project;
}

export function selectedItem(
  engine: EditorEngine,
  itemId: string | undefined,
): ItemEntity | undefined {
  if (itemId === undefined) return undefined;
  return engine.project?.items[itemId];
}

export function addTrack(
  engine: EditorEngine,
  kind: TrackEntity['kind'],
  options?: { readonly historyGroup?: string },
): string {
  const session = requireSession(engine);
  const project = requireProject(engine);
  const track = newTrackEntity({ ids: engine.ids, project, kind });
  const sequence = project.sequences[project.settings.defaultSequenceId];
  if (sequence === undefined) throw new Error('Default sequence is missing');
  const beforeId = newTrackAnchorId(project, kind);
  session.transaction.edit(
    tx => {
      tx.createEntity('tracks', track.id, track as unknown as JsonObject);
      tx.listInsert('sequences', sequence.id, ['trackIds'], track.id, beforeId);
    },
    {
      label: `添加 ${kind} 轨道`,
      ...(options?.historyGroup === undefined ? {} : { historyGroup: options.historyGroup }),
    },
  );
  return track.id;
}

function takeInsertSlot(
  engine: EditorEngine,
  options: ResolveInsertOptions & { readonly historyGroup?: string },
): { trackId: string; startUs: number } {
  const placement = resolveInsertPlacement(requireProject(engine), options);
  if (placement.createTrack) {
    return {
      trackId: addTrack(engine, options.kind, {
        ...(options.historyGroup === undefined ? {} : { historyGroup: options.historyGroup }),
      }),
      startUs: placement.startUs,
    };
  }
  return { trackId: placement.trackId, startUs: placement.startUs };
}

export function insertExistingAsset(
  engine: EditorEngine,
  assetId: string,
  atUs: number,
  trackId?: string,
  options?: { readonly lockTrack?: boolean },
): string | undefined {
  const session = requireSession(engine);
  const project = requireProject(engine);
  const asset = project.assets[assetId];
  if (asset === undefined) return undefined;
  const format = sequenceFormat(project);
  const kind = (asset as JsonObject).kind;
  const name = typeof asset.name === 'string' ? asset.name : assetId;
  const probe = (asset as JsonObject).probeHint;
  const durationUs =
    kind === 'image'
      ? STILL_DURATION_US
      : probe !== null &&
          typeof probe === 'object' &&
          !Array.isArray(probe) &&
          typeof (probe as JsonObject).durationUs === 'number'
        ? Math.max(1, (probe as JsonObject).durationUs as number)
        : TITLE_DURATION_US;
  const trackKind: TrackEntity['kind'] = kind === 'audio' ? 'audio' : 'visual';
  const historyGroup = engine.ids.next('hist');
  const slot = takeInsertSlot(engine, {
    kind: trackKind,
    startUs: atUs,
    durationUs,
    policy: insertPolicyForMedia(typeof kind === 'string' ? kind : 'video'),
    ...(trackId === undefined ? {} : { preferredTrackId: trackId }),
    ...(options?.lockTrack === undefined ? {} : { lockTrack: options.lockTrack }),
    historyGroup,
  });
  const id = engine.ids.next('item');
  const sourceSize = probeSourceSize(probe);
  const sized =
    sourceSize === undefined
      ? {}
      : { sourceWidth: sourceSize.width, sourceHeight: sourceSize.height };
  const item =
    kind === 'audio'
      ? mediaItem({
          id,
          trackId: slot.trackId,
          kind: 'audio',
          assetId,
          name,
          atUs: slot.startUs,
          durationUs,
          format,
        })
      : kind === 'image'
        ? imageItem({
            id,
            trackId: slot.trackId,
            assetId,
            name,
            atUs: slot.startUs,
            durationUs,
            format,
            ...sized,
          })
        : mediaItem({
            id,
            trackId: slot.trackId,
            kind: 'video',
            assetId,
            name,
            atUs: slot.startUs,
            durationUs,
            format,
            ...sized,
          });
  session.transaction.commands.insertItem({
    item,
    label: `放置 ${name}`,
    historyGroup,
  });
  return id;
}

export function insertGenerated(
  engine: EditorEngine,
  kind: Exclude<LibraryDropKind, `asset:${string}` | `effect:${string}` | `transition:${string}`>,
  atUs: number,
  trackId?: string,
  options?: { readonly lockTrack?: boolean },
): string {
  const session = requireSession(engine);
  const project = requireProject(engine);
  const format = sequenceFormat(project);
  const durationUs = kind === 'caption' ? seconds(3) : TITLE_DURATION_US;
  const trackKind: TrackEntity['kind'] = kind === 'caption' ? 'caption' : 'visual';
  const historyGroup = engine.ids.next('hist');
  const slot = takeInsertSlot(engine, {
    kind: trackKind,
    startUs: atUs,
    durationUs,
    policy: 'overlay',
    ...(trackId === undefined ? {} : { preferredTrackId: trackId }),
    ...(options?.lockTrack === undefined ? {} : { lockTrack: options.lockTrack }),
    historyGroup,
  });
  const id = engine.ids.next('item');
  let item: ItemEntity;
  if (kind === 'text-title' || kind === 'text-subtitle') {
    item = textItem({
      id,
      trackId: slot.trackId,
      text: kind === 'text-title' ? '标题' : '副标题',
      atUs: slot.startUs,
      durationUs,
      format,
      fontSizePx: kind === 'text-title' ? 96 : 48,
      name: kind === 'text-title' ? '标题' : '副标题',
    });
  } else if (kind === 'caption') {
    item = captionItem({
      id,
      trackId: slot.trackId,
      text: '字幕',
      atUs: slot.startUs,
      durationUs,
      format,
    });
  } else if (kind === 'shape-rect' || kind === 'shape-ellipse') {
    item = shapeItem({
      id,
      trackId: slot.trackId,
      kind: kind === 'shape-rect' ? 'rectangle' : 'ellipse',
      atUs: slot.startUs,
      durationUs,
      format,
      fill: '#3d8bfd',
    });
  } else if (kind === 'matte-black' || kind === 'matte-white' || kind === 'gradient') {
    item = generatorItem({
      id,
      trackId: slot.trackId,
      kind: kind === 'gradient' ? 'linear-gradient' : 'solid',
      colors:
        kind === 'matte-white'
          ? ['#ffffff']
          : kind === 'matte-black'
            ? ['#000000']
            : ['#1a1a1a', '#3d8bfd'],
      atUs: slot.startUs,
      durationUs,
      format,
      name: kind === 'gradient' ? '渐变' : kind === 'matte-white' ? '白色色块' : '黑色色块',
    });
  } else {
    item = adjustmentItem({
      id,
      trackId: slot.trackId,
      atUs: slot.startUs,
      durationUs,
      format,
    });
  }
  session.transaction.commands.insertItem({
    item,
    label: `添加 ${clipLabel(item)}`,
    historyGroup,
  });
  return id;
}

export function insertCaptionCue(
  engine: EditorEngine,
  atUs: number,
  durationUs: number,
  text: string,
): string {
  const session = requireSession(engine);
  const project = requireProject(engine);
  const cueDurationUs = Math.max(1, durationUs);
  const historyGroup = engine.ids.next('hist');
  const slot = takeInsertSlot(engine, {
    kind: 'caption',
    startUs: atUs,
    durationUs: cueDurationUs,
    policy: 'overlay',
    historyGroup,
  });
  const item = captionItem({
    id: engine.ids.next('item'),
    trackId: slot.trackId,
    text,
    atUs: slot.startUs,
    durationUs: cueDurationUs,
    format: sequenceFormat(project),
  });
  session.transaction.commands.insertItem({ item, label: '导入字幕', historyGroup });
  return item.id;
}

export function applyEffect(
  engine: EditorEngine,
  itemId: string,
  materialId: string,
): string | undefined {
  const session = requireSession(engine);
  const project = requireProject(engine);
  const item = project.items[itemId];
  if (item === undefined) return undefined;
  const matches = item.materialInstanceIds.filter(
    id =>
      instanceMaterialId(project.materialInstances[id] as JsonObject | undefined) === materialId,
  );
  const existing = matches[0];
  if (existing !== undefined) {
    const extras = matches.slice(1);
    if (extras.length > 0) {
      session.transaction.edit(
        tx => {
          for (const extra of extras) {
            tx.listRemove('items', itemId, ['materialInstanceIds'], extra);
            tx.deleteEntity('materialInstances', extra);
          }
        },
        { label: '合并重复效果' },
      );
    }
    return existing;
  }
  const catalog = effectCatalogEntry(materialId);
  const instanceId = engine.ids.next('material');
  session.transaction.edit(
    tx => {
      tx.createEntity(
        'materialInstances',
        instanceId,
        materialInstanceEntity({
          id: instanceId,
          materialId,
          name: catalog?.name ?? materialId,
          parameters:
            materialId === 'diffusion-blur'
              ? { value: catalog?.value ?? 8, width: 1920, height: 1080 }
              : { value: catalog?.value ?? 100 },
        }),
      );
      tx.listInsert('items', itemId, ['materialInstanceIds'], instanceId);
    },
    { label: `效果 ${catalog?.name ?? materialId}` },
  );
  return instanceId;
}

export function removeEffect(engine: EditorEngine, itemId: string, instanceId: string): void {
  const session = requireSession(engine);
  const project = requireProject(engine);
  if (project.items[itemId] === undefined) return;
  session.transaction.edit(
    tx => {
      tx.listRemove('items', itemId, ['materialInstanceIds'], instanceId);
      if (project.materialInstances[instanceId] !== undefined) {
        tx.deleteEntity('materialInstances', instanceId);
      }
    },
    { label: '删除效果' },
  );
}

export function setEffectValue(
  engine: EditorEngine,
  instanceId: string,
  value: number,
  interactive?: AelionInteractiveEdit,
): void {
  const project = requireProject(engine);
  if (project.materialInstances[instanceId] === undefined) return;
  write(
    engine,
    '效果强度',
    tx => {
      tx.setField('materialInstances', instanceId, ['parameters', 'value'], value);
    },
    interactive,
  );
}

export function applyTransition(
  engine: EditorEngine,
  fromItemId: string,
  materialId: string,
  durationUs = seconds(1),
): string {
  const session = requireSession(engine);
  const project = requireProject(engine);
  const selected = project.items[fromItemId];
  if (selected === undefined) throw new Error('先点选一段，或把转场拖到片段上');
  const pair = findTransitionPair(project, selected, durationUs);
  if (pair === undefined) {
    throw new Error('同一轨道上找不到紧挨着的另一段。把两段放到同一条轨道并靠在一起。');
  }
  const { from, to } = pair;
  const track = project.tracks[from.trackId];
  if (track === undefined) throw new Error('轨道不存在');
  const catalog = TRANSITION_CATALOG.find(entry => entry.id === materialId);
  const materialInstanceId = engine.ids.next('material');
  const transitionId = engine.ids.next('transition');
  const range = transitionRangeForPair(from, to, durationUs);
  const stale = Object.values(project.transitions).filter(
    transition =>
      (transition.fromItemId === from.id && transition.toItemId === to.id) ||
      (transition.fromItemId === to.id && transition.toItemId === from.id),
  );
  session.transaction.edit(
    tx => {
      for (const previous of stale) {
        tx.listRemove('sequences', previous.sequenceId, ['transitionIds'], previous.id);
        tx.deleteEntity('transitions', previous.id);
        tx.deleteEntity('materialInstances', previous.materialInstanceId);
      }
      tx.createEntity(
        'materialInstances',
        materialInstanceId,
        materialInstanceEntity({
          id: materialInstanceId,
          materialId,
          name: catalog?.name ?? materialId,
          parameters: {},
        }),
      );
      tx.createEntity('transitions', transitionId, {
        id: transitionId,
        sequenceId: project.settings.defaultSequenceId,
        trackId: track.id,
        kind: track.kind === 'audio' ? 'audio' : 'visual',
        fromItemId: from.id,
        toItemId: to.id,
        range,
        materialInstanceId,
      });
      tx.listInsert(
        'sequences',
        project.settings.defaultSequenceId,
        ['transitionIds'],
        transitionId,
      );
    },
    { label: catalog?.name ?? '转场' },
  );
  return transitionId;
}

export function removeTransition(engine: EditorEngine, transitionId: string): void {
  const session = requireSession(engine);
  const project = requireProject(engine);
  const transition = project.transitions[transitionId];
  if (transition === undefined) return;
  session.transaction.edit(
    tx => {
      tx.listRemove('sequences', transition.sequenceId, ['transitionIds'], transition.id);
      tx.deleteEntity('transitions', transition.id);
      tx.deleteEntity('materialInstances', transition.materialInstanceId);
    },
    { label: '删除转场' },
  );
}

export function resizeTransition(
  engine: EditorEngine,
  transitionId: string,
  edge: 'start' | 'end',
  toUs: number,
  interactive?: AelionInteractiveEdit,
): void {
  const project = requireProject(engine);
  const transition = project.transitions[transitionId];
  if (transition === undefined) return;
  const minUs = frameDurationUs(sequenceFormat(project).frameRate);
  const endUs = transition.range.startUs + transition.range.durationUs;
  const next =
    edge === 'start'
      ? {
          startUs: Math.max(0, Math.min(toUs, endUs - minUs)),
          durationUs: endUs - Math.max(0, Math.min(toUs, endUs - minUs)),
        }
      : {
          startUs: transition.range.startUs,
          durationUs: Math.max(minUs, toUs - transition.range.startUs),
        };
  write(
    engine,
    '调整转场',
    tx => {
      tx.setField('transitions', transitionId, ['range', 'startUs'], next.startUs);
      tx.setField('transitions', transitionId, ['range', 'durationUs'], next.durationUs);
    },
    interactive,
  );
}

export function setTransitionDuration(
  engine: EditorEngine,
  transitionId: string,
  durationUs: number,
  interactive?: AelionInteractiveEdit,
): void {
  const project = requireProject(engine);
  const transition = project.transitions[transitionId];
  if (transition === undefined) return;
  const minUs = frameDurationUs(sequenceFormat(project).frameRate);
  const nextDurationUs = Math.max(minUs, Math.round(durationUs));
  const centerUs = transition.range.startUs + Math.floor(transition.range.durationUs / 2);
  const startUs = Math.max(0, centerUs - Math.floor(nextDurationUs / 2));
  write(
    engine,
    '转场时长',
    tx => {
      tx.setField('transitions', transitionId, ['range', 'startUs'], startUs);
      tx.setField('transitions', transitionId, ['range', 'durationUs'], nextDurationUs);
    },
    interactive,
  );
}

export function itemAtTime(
  project: AelionProject,
  trackId: string,
  atUs: number,
): ItemEntity | undefined {
  const track = project.tracks[trackId];
  if (track === undefined) return undefined;
  let nearest: ItemEntity | undefined;
  let nearestDelta = Number.POSITIVE_INFINITY;
  for (const id of track.itemIds) {
    const item = project.items[id];
    if (item === undefined) continue;
    const startUs = item.range.startUs;
    const endUs = startUs + item.range.durationUs;
    if (atUs >= startUs && atUs < endUs) return item;
    const delta = Math.min(Math.abs(atUs - startUs), Math.abs(atUs - endUs));
    if (delta < nearestDelta) {
      nearest = item;
      nearestDelta = delta;
    }
  }
  return nearest;
}

function findTransitionPair(
  project: AelionProject,
  selected: ItemEntity,
  slackUs: number,
): { readonly from: ItemEntity; readonly to: ItemEntity } | undefined {
  const next = nearestNeighbor(project, selected, 'after', slackUs);
  if (next !== undefined) return { from: selected, to: next };
  const previous = nearestNeighbor(project, selected, 'before', slackUs);
  if (previous !== undefined) return { from: previous, to: selected };
  return undefined;
}

function nearestNeighbor(
  project: AelionProject,
  selected: ItemEntity,
  side: 'before' | 'after',
  slackUs: number,
): ItemEntity | undefined {
  const track = project.tracks[selected.trackId];
  if (track === undefined) return undefined;
  const selectedEnd = selected.range.startUs + selected.range.durationUs;
  let best: ItemEntity | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const id of track.itemIds) {
    const item = project.items[id];
    if (item === undefined || item.id === selected.id) continue;
    const itemEnd = item.range.startUs + item.range.durationUs;
    const overlaps = item.range.startUs < selectedEnd && itemEnd > selected.range.startUs;
    const gap =
      side === 'after' ? item.range.startUs - selectedEnd : selected.range.startUs - itemEnd;
    if (side === 'after' && item.range.startUs < selected.range.startUs) continue;
    if (side === 'before' && item.range.startUs > selected.range.startUs) continue;
    if (!overlaps && (gap < -slackUs || gap > slackUs)) continue;
    const score = overlaps ? 0 : Math.abs(gap);
    if (score < bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

function transitionRangeForPair(
  from: ItemEntity,
  to: ItemEntity,
  durationUs: number,
): { readonly startUs: number; readonly durationUs: number } {
  const fromEnd = from.range.startUs + from.range.durationUs;
  const overlapStart = Math.max(from.range.startUs, to.range.startUs);
  const overlapEnd = Math.min(fromEnd, to.range.startUs + to.range.durationUs);
  const cutUs = overlapEnd > overlapStart ? Math.round((overlapStart + overlapEnd) / 2) : fromEnd;
  return {
    startUs: Math.max(0, cutUs - Math.floor(durationUs / 2)),
    durationUs,
  };
}

export function splitAt(engine: EditorEngine, itemId: string, atUs: number): string | undefined {
  const session = requireSession(engine);
  const project = requireProject(engine);
  const item = project.items[itemId];
  if (item === undefined) return undefined;
  if (atUs <= item.range.startUs || atUs >= item.range.startUs + item.range.durationUs) {
    throw new Error('把播放头放到片段内部再分割');
  }
  if (item.linkGroupId !== undefined) {
    const group = project.linkGroups[item.linkGroupId];
    if (group === undefined) return undefined;
    const rightItemIds = Object.fromEntries(group.itemIds.map(id => [id, engine.ids.next('item')]));
    const result = session.transaction.commands.splitLinkedGroup({
      groupId: group.id,
      rightGroupId: engine.ids.next('link'),
      atUs,
      rightItemIds,
      label: '分割联动片段',
    });
    return result.rightItemIds[item.id];
  }
  return session.transaction.commands.splitItem({
    itemId: item.id,
    rightItemId: engine.ids.next('item'),
    atUs,
    label: '分割',
  }).rightItemId;
}

export function deleteSelection(engine: EditorEngine, itemId: string, ripple: boolean): void {
  const session = requireSession(engine);
  const project = requireProject(engine);
  const item = project.items[itemId];
  if (item === undefined) return;
  if (item.linkGroupId !== undefined) {
    session.transaction.commands.removeLinkedGroup({
      groupId: item.linkGroupId,
      label: '删除联动组',
    });
    return;
  }
  if (ripple) {
    session.transaction.commands.rippleRemoveItem({ itemId, label: '波纹删除' });
    return;
  }
  session.transaction.commands.removeItem({ itemId, label: '删除片段' });
}

export function addMarker(engine: EditorEngine, timeUs: number, label = '标记'): void {
  const session = requireSession(engine);
  const project = requireProject(engine);
  session.transaction.commands.addMarker({
    marker: markerEntity({
      id: engine.ids.next('marker'),
      sequenceId: project.settings.defaultSequenceId,
      timeUs,
      label,
    }),
    label: '添加标记',
  });
}

export function patchVisual(
  engine: EditorEngine,
  itemId: string,
  patch: VisualPatch,
  interactive?: AelionInteractiveEdit,
): void {
  const item = requireProject(engine).items[itemId];
  const visual = item === undefined ? undefined : itemVisual(item);
  if (item === undefined || visual === undefined) return;
  write(
    engine,
    '画面属性',
    tx => {
      if (patch.fit !== undefined) tx.setField('items', itemId, ['visual', 'fit'], patch.fit);
      if (patch.opacity !== undefined)
        tx.setField('items', itemId, ['visual', 'opacity'], patch.opacity);
      if (patch.blendMode !== undefined) {
        tx.setField('items', itemId, ['visual', 'blendMode'], patch.blendMode);
      }
      if (patch.positionPx !== undefined) {
        tx.setField('items', itemId, ['visual', 'transform', 'positionPx'], patch.positionPx);
      }
      if (patch.scale !== undefined) {
        tx.setField('items', itemId, ['visual', 'transform', 'scale'], patch.scale);
      }
      if (patch.rotationDeg !== undefined) {
        tx.setField('items', itemId, ['visual', 'transform', 'rotationDeg'], patch.rotationDeg);
      }
    },
    interactive,
  );
}

export function normalizeMediaFitToFrame(engine: EditorEngine): void {
  const session = engine.session;
  const project = engine.project;
  if (session === undefined || project === null) return;
  const identity = { x: 1, y: 1 };
  const patches: string[] = [];
  for (const item of Object.values(project.items)) {
    if (item.type !== 'image' && item.type !== 'video') continue;
    const fit = itemVisual(item)?.fit;
    const scale = readTransform(item).scale;
    if (fit === 'contain' && Math.abs(scale.x - 1) < 1e-4 && Math.abs(scale.y - 1) < 1e-4) {
      continue;
    }
    patches.push(item.id);
  }
  if (patches.length === 0) return;
  session.transaction.edit(
    tx => {
      for (const id of patches) {
        tx.setField('items', id, ['visual', 'fit'], 'contain');
        tx.setField('items', id, ['visual', 'transform', 'scale'], identity);
      }
    },
    { label: '素材完整适应预览框' },
  );
}

export function patchAudio(
  engine: EditorEngine,
  itemId: string,
  patch: {
    gainDb?: number;
    pan?: number;
    fadeInUs?: number;
    fadeOutUs?: number;
    pitchPolicy?: 'varispeed' | 'preserve';
  },
  interactive?: AelionInteractiveEdit,
): void {
  const item = requireProject(engine).items[itemId];
  if (item === undefined || itemAudio(item) === undefined) return;
  write(
    engine,
    '音频属性',
    tx => {
      if (patch.gainDb !== undefined)
        tx.setField('items', itemId, ['audio', 'gainDb'], patch.gainDb);
      if (patch.pan !== undefined) tx.setField('items', itemId, ['audio', 'pan'], patch.pan);
      if (patch.fadeInUs !== undefined)
        tx.setField('items', itemId, ['audio', 'fadeInUs'], patch.fadeInUs);
      if (patch.fadeOutUs !== undefined) {
        tx.setField('items', itemId, ['audio', 'fadeOutUs'], patch.fadeOutUs);
      }
      if (patch.pitchPolicy !== undefined) {
        tx.setField('items', itemId, ['audio', 'pitchPolicy'], patch.pitchPolicy);
      }
    },
    interactive,
  );
}

export function setShapeFill(
  engine: EditorEngine,
  itemId: string,
  hex: string,
  interactive?: AelionInteractiveEdit,
): void {
  const item = requireProject(engine).items[itemId];
  if (item === undefined || item.type !== 'shape') return;
  write(
    engine,
    '填充色',
    tx => {
      tx.setField('items', itemId, ['shape', 'fill'], parseHexColor(hex));
    },
    interactive,
  );
}

export interface TextStylePatch {
  readonly fontFamilies?: readonly string[];
  readonly fontSizePx?: number;
  readonly fontWeight?: number;
  readonly fontStyle?: 'normal' | 'italic' | 'oblique';
  readonly fill?: string;
  readonly stroke?: string;
  readonly strokeWidthPx?: number;
  readonly align?: 'start' | 'center' | 'end';
  readonly backgroundFill?: string;
  readonly backgroundOpacity?: number;
}

function applyStylePatch(existing: JsonObject, patch: TextStylePatch): JsonObject {
  const next: JsonObject = { ...existing };
  if (patch.fontFamilies !== undefined) next.fontFamilies = [...patch.fontFamilies];
  if (patch.fontSizePx !== undefined) next.fontSizePx = patch.fontSizePx;
  if (patch.fontWeight !== undefined) next.fontWeight = patch.fontWeight;
  if (patch.fontStyle !== undefined) next.fontStyle = patch.fontStyle;
  if (patch.fill !== undefined) next.fill = patch.fill;
  if (patch.stroke !== undefined) next.stroke = patch.stroke;
  if (patch.strokeWidthPx !== undefined) next.strokeWidthPx = patch.strokeWidthPx;
  if (patch.align !== undefined) next.align = patch.align;
  if (patch.backgroundFill !== undefined) next.backgroundFill = patch.backgroundFill;
  if (patch.backgroundOpacity !== undefined) next.backgroundOpacity = patch.backgroundOpacity;
  if (
    typeof next.strokeWidthPx === 'number' &&
    next.strokeWidthPx > 0 &&
    typeof next.stroke !== 'string'
  ) {
    next.stroke = '#000000';
  }
  return next;
}

function writeTextStyle(
  engine: EditorEngine,
  item: ItemEntity,
  style: JsonObject,
  interactive?: AelionInteractiveEdit,
): void {
  const project = requireProject(engine);
  const format = sequenceFormat(project);
  const previous = textInkBox(item, format);
  const text = itemPlainText(item);
  const fontSizePx = typeof style.fontSizePx === 'number' ? style.fontSizePx : 32;
  const letterSpacingPx = typeof style.letterSpacingPx === 'number' ? style.letterSpacingPx : 0;
  const measured = measurePlainText(text, fontSizePx, letterSpacingPx);
  const box = jsonBox(
    boxKeepingCenter(previous, { x: 0, y: 0, width: measured.width, height: measured.height }),
  );
  write(
    engine,
    '文字样式',
    tx => {
      if (item.type === 'caption') {
        tx.setField('items', item.id, ['style'], style);
      } else {
        const paragraphs = (item as JsonObject).paragraphs;
        const first =
          Array.isArray(paragraphs) && paragraphs[0] !== null && typeof paragraphs[0] === 'object'
            ? (paragraphs[0] as JsonObject)
            : { style: {}, runs: [] };
        tx.setField(
          'items',
          item.id,
          ['paragraphs'],
          [
            {
              style: first.style ?? {},
              runs: [{ text, style }],
            },
          ],
        );
      }
      tx.setField('items', item.id, ['box'], box);
    },
    interactive,
  );
}

export function patchTextStyle(
  engine: EditorEngine,
  itemId: string,
  patch: TextStylePatch,
  interactive?: AelionInteractiveEdit,
): void {
  const item = requireProject(engine).items[itemId];
  if (item === undefined || (item.type !== 'text' && item.type !== 'caption')) return;
  writeTextStyle(engine, item, applyStylePatch(itemStyleRecord(item), patch), interactive);
}

export function setTextContent(engine: EditorEngine, itemId: string, text: string): void {
  const session = requireSession(engine);
  const project = requireProject(engine);
  const item = project.items[itemId];
  if (item === undefined || (item.type !== 'text' && item.type !== 'caption')) return;
  const format = sequenceFormat(project);
  const previous = textInkBox(item, format);
  const style = readItemTextStyle(item);
  const next = measurePlainText(text, style.fontSizePx, style.letterSpacingPx);
  const box = jsonBox(
    boxKeepingCenter(previous, { x: 0, y: 0, width: next.width, height: next.height }),
  );
  if (item.type === 'caption') {
    session.transaction.edit(
      tx => {
        tx.setField('items', itemId, ['text'], text);
        tx.setField('items', itemId, ['name'], text.slice(0, 24));
        tx.setField('items', itemId, ['box'], box);
      },
      { label: '编辑字幕' },
    );
    return;
  }
  const paragraphs = (item as JsonObject).paragraphs;
  const first =
    Array.isArray(paragraphs) && paragraphs[0] !== null && typeof paragraphs[0] === 'object'
      ? (paragraphs[0] as JsonObject)
      : { style: {}, runs: [] };
  const runs = Array.isArray(first.runs) ? first.runs : [];
  const run =
    runs[0] !== null && typeof runs[0] === 'object' && !Array.isArray(runs[0])
      ? (runs[0] as JsonObject)
      : { style: {} };
  session.transaction.edit(
    tx => {
      tx.setField(
        'items',
        itemId,
        ['paragraphs'],
        [
          {
            style: first.style ?? {},
            runs: [{ text, style: run.style ?? {} }],
          },
        ],
      );
      tx.setField('items', itemId, ['name'], text.slice(0, 24));
      tx.setField('items', itemId, ['box'], box);
    },
    { label: '编辑文字' },
  );
}

export function setSpeed(
  engine: EditorEngine,
  itemId: string,
  rate: number,
  reverse: boolean,
  interactive?: AelionInteractiveEdit,
): void {
  const item = requireProject(engine).items[itemId];
  const source = item === undefined ? undefined : itemSource(item);
  if (item === undefined || source === undefined) return;
  const numerator = Math.max(1, Math.round(rate * 1000));
  const mapping = linearTimeMapping({ numerator, denominator: 1000 }, reverse);
  write(
    engine,
    '变速',
    tx => {
      tx.setField('items', itemId, ['source', 'timeMapping'], mapping);
    },
    interactive,
  );
}

export function freezeFrame(engine: EditorEngine, itemId: string, holdUs = seconds(2)): void {
  const session = requireSession(engine);
  const item = requireProject(engine).items[itemId];
  const source = item === undefined ? undefined : itemSource(item);
  if (item === undefined || source === undefined) return;
  const sourceRange = source.sourceRange as JsonObject;
  const startUs = typeof sourceRange.startUs === 'number' ? sourceRange.startUs : 0;
  const durationUs =
    typeof sourceRange.durationUs === 'number' ? sourceRange.durationUs : item.range.durationUs;
  const points = buildRateEnvelope({
    sourceStartUs: startUs,
    segments: [
      { rate: 1, durationUs },
      { rate: 0, durationUs: holdUs },
    ],
  });
  session.transaction.edit(
    tx => {
      tx.setField('items', itemId, ['source', 'timeMapping'], {
        type: 'curve',
        points: points.map(point => ({ ...point })),
        boundary: 'hold',
      });
      tx.setField('items', itemId, ['range', 'durationUs'], durationUs + holdUs);
    },
    { label: '定格' },
  );
}

export function setItemEnabled(engine: EditorEngine, itemId: string, enabled: boolean): void {
  requireSession(engine).transaction.edit(
    tx => {
      tx.setField('items', itemId, ['enabled'], enabled);
    },
    { label: enabled ? '启用片段' : '禁用片段' },
  );
}

export function resizeTimelineItem(
  engine: EditorEngine,
  itemId: string,
  edge: 'start' | 'end',
  toUs: number,
  options: { readonly historyGroup?: string; readonly linked?: boolean } = {},
): void {
  const session = requireSession(engine);
  const project = requireProject(engine);
  const item = project.items[itemId];
  if (item === undefined) return;
  const minDurationUs = Math.max(1, frameDurationUs(sequenceFormat(project).frameRate));
  const members =
    options.linked === true && item.linkGroupId !== undefined
      ? (project.linkGroups[item.linkGroupId]?.itemIds ?? [itemId]).flatMap(id => {
          const value = project.items[id];
          return value === undefined ? [] : [value];
        })
      : [item];
  if (members.some(member => project.tracks[member.trackId]?.locked === true)) return;
  let delta =
    edge === 'end'
      ? Math.round(toUs) - (item.range.startUs + item.range.durationUs)
      : Math.round(toUs) - item.range.startUs;
  for (const member of members) {
    const limit = resizeDeltaLimit(project, member, edge, minDurationUs);
    delta = Math.min(limit.max, Math.max(limit.min, delta));
  }
  if (delta === 0) return;
  session.transaction.edit(
    tx => {
      for (const member of members) {
        const nextStartUs = edge === 'start' ? member.range.startUs + delta : member.range.startUs;
        const nextDurationUs =
          edge === 'end' ? member.range.durationUs + delta : member.range.durationUs - delta;
        tx.setField('items', member.id, ['range', 'startUs'], nextStartUs);
        tx.setField('items', member.id, ['range', 'durationUs'], nextDurationUs);
        const source = itemSource(member);
        const range = source?.sourceRange;
        if (
          source === undefined ||
          range === null ||
          typeof range !== 'object' ||
          Array.isArray(range)
        ) {
          continue;
        }
        const sourceStartUs = typeof range.startUs === 'number' ? range.startUs : 0;
        const sourceDurationUs =
          typeof range.durationUs === 'number' ? range.durationUs : member.range.durationUs;
        tx.setField(
          'items',
          member.id,
          ['source', 'sourceRange', 'startUs'],
          Math.max(0, sourceStartUs + (edge === 'start' ? delta : 0)),
        );
        tx.setField(
          'items',
          member.id,
          ['source', 'sourceRange', 'durationUs'],
          Math.max(1, sourceDurationUs + (edge === 'end' ? delta : -delta)),
        );
      }
    },
    {
      label: '修剪',
      ...(options.historyGroup === undefined ? {} : { historyGroup: options.historyGroup }),
    },
  );
}

function isTimedMedia(item: ItemEntity): boolean {
  return item.type === 'video' || item.type === 'audio';
}

function resizeDeltaLimit(
  project: AelionProject,
  item: ItemEntity,
  edge: 'start' | 'end',
  minDurationUs: number,
): { readonly min: number; readonly max: number } {
  const window = isTimedMedia(item) ? mediaSourceWindow(project, item) : undefined;
  const { left, right } = neighborPair(project, item.id);
  const gapBefore =
    left === undefined
      ? item.range.startUs
      : item.range.startUs - (left.range.startUs + left.range.durationUs);
  const gapAfter =
    right === undefined
      ? Number.MAX_SAFE_INTEGER / 4
      : right.range.startUs - (item.range.startUs + item.range.durationUs);
  if (edge === 'end') {
    const sourceMax =
      window?.assetDurationUs === undefined
        ? Number.MAX_SAFE_INTEGER / 4
        : Math.max(0, window.assetDurationUs - window.sourceStartUs - window.sourceDurationUs);
    return {
      min: minDurationUs - item.range.durationUs,
      max: Math.min(sourceMax, gapAfter > 0 ? gapAfter : 0),
    };
  }
  const sourceMin = -Math.min(
    item.range.startUs,
    window === undefined ? item.range.startUs : window.sourceStartUs,
  );
  return {
    min: Math.max(sourceMin, gapBefore > 0 ? -gapBefore : 0),
    max: item.range.durationUs - minDurationUs,
  };
}

function mediaSourceWindow(
  project: AelionProject,
  item: ItemEntity,
):
  | {
      readonly sourceStartUs: number;
      readonly sourceDurationUs: number;
      readonly assetDurationUs?: number;
    }
  | undefined {
  const source = itemSource(item);
  if (source === undefined) return undefined;
  const range = source.sourceRange;
  if (range === null || typeof range !== 'object' || Array.isArray(range)) return undefined;
  const sourceStartUs = typeof range.startUs === 'number' ? range.startUs : 0;
  const sourceDurationUs =
    typeof range.durationUs === 'number' ? range.durationUs : item.range.durationUs;
  const asset = typeof source.assetId === 'string' ? project.assets[source.assetId] : undefined;
  const probe = asset === undefined ? undefined : (asset as JsonObject).probeHint;
  const durationUs =
    probe !== null && typeof probe === 'object' && !Array.isArray(probe)
      ? (probe as JsonObject).durationUs
      : undefined;
  return {
    sourceStartUs,
    sourceDurationUs,
    ...(typeof durationUs === 'number' ? { assetDurationUs: durationUs } : {}),
  };
}

export function neighborPair(
  project: AelionProject,
  itemId: string,
): { left?: ItemEntity; right?: ItemEntity } {
  const item = project.items[itemId];
  const track = item === undefined ? undefined : project.tracks[item.trackId];
  if (item === undefined || track === undefined) return {};
  const sorted = track.itemIds
    .flatMap(id => {
      const value = project.items[id];
      return value === undefined ? [] : [value];
    })
    .sort((left, right) => left.range.startUs - right.range.startUs);
  const index = sorted.findIndex(value => value.id === itemId);
  return {
    ...(sorted[index - 1] === undefined ? {} : { left: sorted[index - 1] }),
    ...(sorted[index + 1] === undefined ? {} : { right: sorted[index + 1] }),
  };
}

function relocateItem(
  tx: Parameters<EditCallback>[0],
  item: ItemEntity,
  toTrackId: string,
  startUs: number,
): void {
  if (item.trackId !== toTrackId) {
    tx.listRemove('tracks', item.trackId, ['itemIds'], item.id);
    tx.setField('items', item.id, ['trackId'], toTrackId);
    tx.listInsert('tracks', toTrackId, ['itemIds'], item.id);
  }
  if (item.range.startUs !== startUs) {
    tx.setField('items', item.id, ['range', 'startUs'], startUs);
  }
}

function itemTrackKind(item: ItemEntity): TrackEntity['kind'] {
  return item.type === 'audio' ? 'audio' : item.type === 'caption' ? 'caption' : 'visual';
}

export type MoveItemResult =
  | { readonly kind: 'swap'; readonly occupantId: string }
  | { readonly kind: 'move' };

/**
 * Move a clip under the pointer. Same-track swap packs the right clip onto the
 * left clip's in-point and seats the left clip immediately after it; later
 * clips shift only if they collide. Cross-track swap exchanges tracks and
 * leaves other clips' in/out alone.
 */
export function moveItemAvoidingOverlap(
  engine: EditorEngine,
  options: {
    readonly itemId: string;
    readonly startUs: number;
    readonly toTrackId?: string;
    readonly fromTrackId?: string;
    readonly fromStartUs?: number;
    readonly reverseSwapId?: string;
    readonly historyGroup?: string;
  },
): MoveItemResult | undefined {
  const project = requireProject(engine);
  const moved = project.items[options.itemId];
  if (moved === undefined) return undefined;
  const intendedStart = Math.max(0, Math.round(options.startUs));
  const destTrackId = options.toTrackId ?? moved.trackId;
  const destTrack = project.tracks[destTrackId];
  const homeTrackId = options.fromTrackId ?? moved.trackId;
  const homeStartUs = Math.max(0, Math.round(options.fromStartUs ?? moved.range.startUs));
  if (destTrack === undefined || destTrack.locked || destTrack.kind !== itemTrackKind(moved)) {
    return undefined;
  }
  const occupant = overlappingItemOnTrack(
    project,
    destTrackId,
    intendedStart,
    moved.range.durationUs,
    [moved.id],
  );
  const homeTrack = project.tracks[homeTrackId];
  const canSwap =
    occupant !== undefined &&
    homeTrack !== undefined &&
    !homeTrack.locked &&
    homeTrack.kind === itemTrackKind(occupant) &&
    shouldSwapOccupant(
      intendedStart,
      moved.range.durationUs,
      occupant.range.startUs,
      occupant.range.durationUs,
      occupant.id === options.reverseSwapId ? 0.25 : 0.5,
    );

  if (occupant === undefined || !canSwap) {
    const nextStartUs =
      occupant === undefined
        ? intendedStart
        : magnetStartOnTrack(project, destTrackId, intendedStart, moved.range.durationUs, [
            moved.id,
          ]);
    if (nextStartUs === undefined) return undefined;
    if (destTrackId === moved.trackId && nextStartUs === moved.range.startUs) return undefined;
    const writes = new Map<string, { readonly trackId: string; readonly startUs: number }>([
      [moved.id, { trackId: destTrackId, startUs: nextStartUs }],
    ]);
    if (!applyItemRelocations(engine, writes, '移动', options.historyGroup)) return undefined;
    return { kind: 'move' };
  }

  const placed = new Map<string, { readonly trackId: string; readonly startUs: number }>();
  if (homeTrackId === destTrackId) {
    const movedIsLeft = homeStartUs <= occupant.range.startUs;
    const left = movedIsLeft ? moved : occupant;
    const right = movedIsLeft ? occupant : moved;
    const leftStartUs = movedIsLeft ? homeStartUs : occupant.range.startUs;
    const packed = packLeftRightSwap(leftStartUs, right.range.durationUs);
    placed.set(right.id, { trackId: destTrackId, startUs: packed.rightStartUs });
    placed.set(left.id, { trackId: destTrackId, startUs: packed.leftStartUs });
    const pairEndUs = packed.leftStartUs + left.range.durationUs;
    const writes = writesFromSettled(
      project,
      placed,
      settleAfterPackedPair(
        trackItemsAfterMove(project, destTrackId, placed),
        new Set([left.id, right.id]),
        packed.rightStartUs,
        pairEndUs,
      ),
    );
    if (!applyItemRelocations(engine, writes, '交换片段', options.historyGroup)) return undefined;
    return { kind: 'swap', occupantId: occupant.id };
  }

  const exceptPair = [moved.id, occupant.id];
  const incomingStart = magnetStartOnTrack(
    project,
    destTrackId,
    intendedStart,
    moved.range.durationUs,
    exceptPair,
  );
  const occupantStart = magnetStartOnTrack(
    project,
    homeTrackId,
    occupant.range.startUs,
    occupant.range.durationUs,
    exceptPair,
  );
  if (incomingStart === undefined || occupantStart === undefined) return undefined;
  placed.set(moved.id, { trackId: destTrackId, startUs: incomingStart });
  placed.set(occupant.id, { trackId: homeTrackId, startUs: occupantStart });
  if (!applyItemRelocations(engine, placed, '交换片段', options.historyGroup)) return undefined;
  return { kind: 'swap', occupantId: occupant.id };
}

function writesFromSettled(
  project: AelionProject,
  placed: ReadonlyMap<string, { readonly trackId: string; readonly startUs: number }>,
  settled: readonly { readonly id: string; readonly startUs: number }[],
): Map<string, { readonly trackId: string; readonly startUs: number }> {
  const writes = new Map(placed);
  for (const entry of settled) {
    const item = project.items[entry.id];
    if (item === undefined) continue;
    const nextTrackId = placed.get(entry.id)?.trackId ?? item.trackId;
    if (item.range.startUs === entry.startUs && item.trackId === nextTrackId) continue;
    writes.set(entry.id, { trackId: nextTrackId, startUs: entry.startUs });
  }
  return writes;
}

function applyItemRelocations(
  engine: EditorEngine,
  writes: ReadonlyMap<string, { readonly trackId: string; readonly startUs: number }>,
  label: string,
  historyGroup?: string,
): boolean {
  const project = requireProject(engine);
  let changed = false;
  for (const [id, next] of writes) {
    const item = project.items[id];
    if (item === undefined) continue;
    if (item.trackId !== next.trackId || item.range.startUs !== next.startUs) changed = true;
  }
  if (!changed) return false;
  requireSession(engine).transaction.edit(
    tx => {
      for (const [id, next] of writes) {
        const item = project.items[id];
        if (item === undefined) continue;
        relocateItem(tx, item, next.trackId, next.startUs);
      }
      syncTransitionsAfterMoves(tx, project, writes);
    },
    {
      label,
      ...(historyGroup === undefined ? {} : { historyGroup }),
    },
  );
  return true;
}

function projectedItem(
  item: ItemEntity,
  placed: ReadonlyMap<string, { readonly trackId: string; readonly startUs: number }>,
): ItemEntity {
  const next = placed.get(item.id);
  if (next === undefined) return item;
  return {
    ...item,
    trackId: next.trackId,
    range: { ...item.range, startUs: next.startUs },
  };
}

function syncTransitionsAfterMoves(
  tx: Parameters<EditCallback>[0],
  project: AelionProject,
  placed: ReadonlyMap<string, { readonly trackId: string; readonly startUs: number }>,
): void {
  for (const transition of Object.values(project.transitions)) {
    const fromOrig = project.items[transition.fromItemId];
    const toOrig = project.items[transition.toItemId];
    if (fromOrig === undefined || toOrig === undefined) continue;
    const from = projectedItem(fromOrig, placed);
    const to = projectedItem(toOrig, placed);
    if (from.trackId !== to.trackId) {
      tx.listRemove('sequences', transition.sequenceId, ['transitionIds'], transition.id);
      tx.deleteEntity('transitions', transition.id);
      tx.deleteEntity('materialInstances', transition.materialInstanceId);
      continue;
    }
    const earlier = from.range.startUs <= to.range.startUs ? from : to;
    const later = earlier === from ? to : from;
    const range = transitionRangeForPair(earlier, later, transition.range.durationUs);
    if (transition.fromItemId !== earlier.id) {
      tx.setField('transitions', transition.id, ['fromItemId'], earlier.id);
    }
    if (transition.toItemId !== later.id) {
      tx.setField('transitions', transition.id, ['toItemId'], later.id);
    }
    if (transition.trackId !== from.trackId) {
      tx.setField('transitions', transition.id, ['trackId'], from.trackId);
    }
    if (transition.range.startUs !== range.startUs) {
      tx.setField('transitions', transition.id, ['range', 'startUs'], range.startUs);
    }
  }
}

function trackItemsAfterMove(
  project: AelionProject,
  trackId: string,
  placed: ReadonlyMap<string, { readonly trackId: string; readonly startUs: number }>,
): { readonly id: string; readonly startUs: number; readonly durationUs: number }[] {
  const items: { readonly id: string; readonly startUs: number; readonly durationUs: number }[] =
    [];
  for (const item of Object.values(project.items)) {
    const nextTrackId = placed.get(item.id)?.trackId ?? item.trackId;
    if (nextTrackId !== trackId) continue;
    items.push({
      id: item.id,
      startUs: placed.get(item.id)?.startUs ?? item.range.startUs,
      durationUs: item.range.durationUs,
    });
  }
  return items;
}

export function moveLinkedGroupAvoidingOverlap(
  engine: EditorEngine,
  groupId: string,
  deltaUs: number,
  historyGroup?: string,
): void {
  const project = requireProject(engine);
  const group = project.linkGroups[groupId];
  if (group === undefined) return;
  const members = group.itemIds.flatMap(id => {
    const item = project.items[id];
    return item === undefined ? [] : [item];
  });
  if (members.length === 0) return;
  const except = group.itemIds;
  let delta = Math.round(deltaUs);
  for (const member of members) {
    delta = Math.max(delta, -member.range.startUs);
  }
  for (let pass = 0; pass <= members.length; pass += 1) {
    const before = delta;
    for (const member of members) {
      delta = clampDeltaBeforeOverlap(project, member, delta, except);
    }
    if (delta === before) break;
  }
  if (delta === 0) return;
  requireSession(engine).transaction.commands.moveLinkedGroup({
    groupId,
    deltaUs: delta,
    ...(historyGroup === undefined ? {} : { historyGroup }),
  });
}

function clampDeltaBeforeOverlap(
  project: AelionProject,
  item: ItemEntity,
  deltaUs: number,
  except: readonly string[],
): number {
  if (deltaUs === 0) return 0;
  const intended = item.range.startUs + deltaUs;
  const occupant = overlappingItemOnTrack(
    project,
    item.trackId,
    intended,
    item.range.durationUs,
    except,
  );
  if (occupant === undefined) return deltaUs;
  if (deltaUs > 0) {
    return Math.max(
      0,
      Math.min(deltaUs, occupant.range.startUs - item.range.durationUs - item.range.startUs),
    );
  }
  return Math.min(
    0,
    Math.max(deltaUs, occupant.range.startUs + occupant.range.durationUs - item.range.startUs),
  );
}

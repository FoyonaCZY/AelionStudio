import type { JsonObject } from '@aelionsdk/core';
import type { AelionProject, ItemEntity } from '@aelionsdk/project-schema';

import {
  itemVisual,
  orderedTracks,
  readFittedTransform,
  type SequenceFormat,
  type VisualTransform,
} from './project.js';
import { textInkBox } from './text-metrics.js';

export type ProgramHandle = 'body' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate';

export interface ProgramHit {
  readonly itemId: string;
  readonly handle: ProgramHandle;
}

export interface ProgramBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/**
 * Builtin visual transform stores `positionPx.y` as Y-up on every backend.
 * Overlay and pointer math convert that into CSS Y-down (`'gl'`).
 */
export type ProgramYAxis = 'gl' | 'css';

const CORNERS: readonly ProgramHandle[] = ['nw', 'ne', 'se', 'sw'];
const EDGES: readonly ProgramHandle[] = ['n', 'e', 's', 'w'];

export function programYAxisFromBackend(_backend?: 'webgpu' | 'webgl2' | null): ProgramYAxis {
  return 'gl';
}

export function containLayout(
  canvas: HTMLCanvasElement,
  format: SequenceFormat,
): { left: number; top: number; width: number; height: number; scale: number } {
  const bounds = canvas.getBoundingClientRect();
  const parent = canvas.parentElement?.getBoundingClientRect();
  const cssWidth = bounds.width;
  const cssHeight = bounds.height;
  const backingWidth = canvas.width || cssWidth || 1;
  const backingHeight = canvas.height || cssHeight || 1;
  const scaleBacking = Math.min(backingWidth / format.width, backingHeight / format.height);
  const toCssX = cssWidth / backingWidth;
  const toCssY = cssHeight / backingHeight;
  const width = format.width * scaleBacking * toCssX;
  const height = format.height * scaleBacking * toCssY;
  const offsetX = ((backingWidth - format.width * scaleBacking) / 2) * toCssX;
  const offsetY = ((backingHeight - format.height * scaleBacking) / 2) * toCssY;
  return {
    left: (parent === undefined ? 0 : bounds.left - parent.left) + offsetX,
    top: (parent === undefined ? 0 : bounds.top - parent.top) + offsetY,
    width,
    height,
    scale: scaleBacking * toCssX,
  };
}

export function itemSourceBox(item: ItemEntity, format: SequenceFormat): ProgramBox {
  if (item.type === 'text' || item.type === 'caption') {
    return textInkBox(item, format);
  }
  if (item.type === 'shape') {
    const shape = (item as JsonObject).shape;
    if (shape !== null && typeof shape === 'object' && !Array.isArray(shape)) {
      return readBox((shape as JsonObject).box, format);
    }
  }
  return { x: 0, y: 0, width: format.width, height: format.height };
}

export function isProgramItem(item: ItemEntity): boolean {
  return item.enabled && item.type !== 'audio' && item.type !== 'adjustment';
}

export function programItemsAtTime(project: AelionProject, timeUs: number): ItemEntity[] {
  const items: ItemEntity[] = [];
  for (const track of orderedTracks(project)) {
    if (track.kind === 'audio') continue;
    for (const itemId of [...track.itemIds].reverse()) {
      const item = project.items[itemId];
      if (
        item === undefined ||
        !isProgramItem(item) ||
        itemVisual(item) === undefined ||
        timeUs < item.range.startUs ||
        timeUs >= item.range.startUs + item.range.durationUs
      ) {
        continue;
      }
      items.push(item);
    }
  }
  return items;
}

function yDownUv(uv: Vec2, yAxis: ProgramYAxis): Vec2 {
  return yAxis === 'gl' ? { x: uv.x, y: 1 - uv.y } : uv;
}

function toScreenY(shaderY: number, format: SequenceFormat, yAxis: ProgramYAxis): number {
  return yAxis === 'gl' ? format.height - shaderY : shaderY;
}

function yDownPosition(positionPx: Vec2, format: SequenceFormat, yAxis: ProgramYAxis): Vec2 {
  return { x: positionPx.x, y: toScreenY(positionPx.y, format, yAxis) };
}

export function projectFromUv(
  uv: Vec2,
  transform: VisualTransform,
  format: SequenceFormat,
  yAxis: ProgramYAxis = 'gl',
): Vec2 {
  const rad = (transform.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const anchor = yDownUv(transform.anchor, yAxis);
  const pos = yDownPosition(transform.positionPx, format, yAxis);
  const lx = (uv.x - anchor.x) * transform.scale.x * format.width;
  const ly = (uv.y - anchor.y) * transform.scale.y * format.height;
  return {
    x: pos.x + cos * lx - sin * ly,
    y: pos.y + sin * lx + cos * ly,
  };
}

export function uvFromProject(
  point: Vec2,
  transform: VisualTransform,
  format: SequenceFormat,
  yAxis: ProgramYAxis = 'gl',
): Vec2 {
  const local = localUv(point, transform, format, yAxis);
  const anchor = yDownUv(transform.anchor, yAxis);
  return {
    x: local.x / (transform.scale.x === 0 ? 1 : transform.scale.x) + anchor.x,
    y: local.y / (transform.scale.y === 0 ? 1 : transform.scale.y) + anchor.y,
  };
}

function localUv(
  point: Vec2,
  transform: VisualTransform,
  format: SequenceFormat,
  yAxis: ProgramYAxis,
): Vec2 {
  const rad = (transform.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const pos = yDownPosition(transform.positionPx, format, yAxis);
  const dx = point.x - pos.x;
  const dy = point.y - pos.y;
  return {
    x: (cos * dx + sin * dy) / format.width,
    y: (-sin * dx + cos * dy) / format.height,
  };
}

export function handleUv(box: ProgramBox, format: SequenceFormat, handle: ProgramHandle): Vec2 {
  const u0 = box.x / format.width;
  const v0 = box.y / format.height;
  const u1 = (box.x + box.width) / format.width;
  const v1 = (box.y + box.height) / format.height;
  const um = (u0 + u1) / 2;
  const vm = (v0 + v1) / 2;
  if (handle === 'nw') return { x: u0, y: v0 };
  if (handle === 'n') return { x: um, y: v0 };
  if (handle === 'ne') return { x: u1, y: v0 };
  if (handle === 'e') return { x: u1, y: vm };
  if (handle === 'se') return { x: u1, y: v1 };
  if (handle === 's') return { x: um, y: v1 };
  if (handle === 'sw') return { x: u0, y: v1 };
  if (handle === 'w') return { x: u0, y: vm };
  return { x: um, y: vm };
}

export function rotateHandlePoint(
  box: ProgramBox,
  transform: VisualTransform,
  format: SequenceFormat,
  viewScale: number,
  yAxis: ProgramYAxis = 'gl',
): Vec2 {
  const top = projectFromUv(handleUv(box, format, 'n'), transform, format, yAxis);
  const bottom = projectFromUv(handleUv(box, format, 's'), transform, format, yAxis);
  const dx = top.x - bottom.x;
  const dy = top.y - bottom.y;
  const length = Math.hypot(dx, dy) || 1;
  const offset = 22 / Math.max(viewScale, 0.001);
  return { x: top.x + (dx / length) * offset, y: top.y + (dy / length) * offset };
}

export function hitTestProgram(
  project: AelionProject,
  format: SequenceFormat,
  timeUs: number,
  point: Vec2,
  selectedItemId: string | undefined,
  viewScale: number,
  yAxis: ProgramYAxis = 'gl',
): ProgramHit | undefined {
  const radius = 10 / Math.max(viewScale, 0.001);
  const selected = selectedItemId === undefined ? undefined : project.items[selectedItemId];
  if (
    selected !== undefined &&
    isProgramItem(selected) &&
    timeUs >= selected.range.startUs &&
    timeUs < selected.range.startUs + selected.range.durationUs
  ) {
    const handle = hitHandles(selected, format, point, viewScale, radius, yAxis, project);
    if (handle !== undefined) return { itemId: selected.id, handle };
  }
  for (const item of programItemsAtTime(project, timeUs)) {
    if (pointInItem(item, format, point, yAxis, project))
      return { itemId: item.id, handle: 'body' };
  }
  return undefined;
}

export function scaleFromPointer(
  point: Vec2,
  handle: ProgramHandle,
  origin: VisualTransform,
  box: ProgramBox,
  format: SequenceFormat,
  lockAspect: boolean,
  yAxis: ProgramYAxis = 'gl',
): Vec2 {
  const uv = handleUv(box, format, handle);
  const local = localUv(point, origin, format, yAxis);
  const anchor = yDownUv(origin.anchor, yAxis);
  const du = uv.x - anchor.x;
  const dv = uv.y - anchor.y;
  let scaleX = Math.abs(du) > 1e-6 ? local.x / du : origin.scale.x;
  let scaleY = Math.abs(dv) > 1e-6 ? local.y / dv : origin.scale.y;
  if (lockAspect && CORNERS.includes(handle)) {
    const factorX = origin.scale.x === 0 ? 1 : scaleX / origin.scale.x;
    const factorY = origin.scale.y === 0 ? 1 : scaleY / origin.scale.y;
    const factor = Math.abs(factorX) >= Math.abs(factorY) ? factorX : factorY;
    scaleX = origin.scale.x * factor;
    scaleY = origin.scale.y * factor;
  }
  return { x: clampScale(scaleX), y: clampScale(scaleY) };
}

export function rotationFromPointer(
  point: Vec2,
  origin: VisualTransform,
  originAngle: number,
  format: SequenceFormat,
  yAxis: ProgramYAxis = 'gl',
): number {
  const originY = yDownPosition(origin.positionPx, format, yAxis).y;
  const next = Math.atan2(point.y - originY, point.x - origin.positionPx.x);
  let degrees = origin.rotationDeg + ((next - originAngle) * 180) / Math.PI;
  while (degrees > 180) degrees -= 360;
  while (degrees < -180) degrees += 360;
  return degrees;
}

export function pointerOriginAngle(
  point: Vec2,
  origin: VisualTransform,
  format: SequenceFormat,
  yAxis: ProgramYAxis,
): number {
  return Math.atan2(
    point.y - yDownPosition(origin.positionPx, format, yAxis).y,
    point.x - origin.positionPx.x,
  );
}

export function pointerMovePosition(
  origin: VisualTransform,
  originPoint: Vec2,
  point: Vec2,
  yAxis: ProgramYAxis,
): { readonly x: number; readonly y: number } {
  const dy = point.y - originPoint.y;
  return {
    x: origin.positionPx.x + point.x - originPoint.x,
    y: origin.positionPx.y + (yAxis === 'gl' ? -dy : dy),
  };
}

export function programCursor(hit: ProgramHit | undefined): string {
  if (hit === undefined) return 'default';
  if (hit.handle === 'body') return 'move';
  if (hit.handle === 'rotate') return 'grab';
  if (hit.handle === 'n' || hit.handle === 's') return 'ns-resize';
  if (hit.handle === 'e' || hit.handle === 'w') return 'ew-resize';
  if (hit.handle === 'ne' || hit.handle === 'sw') return 'nesw-resize';
  return 'nwse-resize';
}

export function renderProgramOverlay(
  root: HTMLElement,
  options: {
    readonly canvas: HTMLCanvasElement;
    readonly project: AelionProject | null;
    readonly format: SequenceFormat;
    readonly timeUs: number;
    readonly selectedItemId: string | undefined;
    readonly yAxis?: ProgramYAxis;
    readonly transform?: VisualTransform;
  },
): void {
  const item =
    options.project === null || options.selectedItemId === undefined
      ? undefined
      : options.project.items[options.selectedItemId];
  if (
    item === undefined ||
    !isProgramItem(item) ||
    options.timeUs < item.range.startUs ||
    options.timeUs >= item.range.startUs + item.range.durationUs
  ) {
    root.hidden = true;
    root.innerHTML = '';
    return;
  }
  const layout = containLayout(options.canvas, options.format);
  if (
    layout.width < 2 ||
    layout.height < 2 ||
    !Number.isFinite(layout.scale) ||
    layout.scale <= 0
  ) {
    root.hidden = true;
    root.innerHTML = '';
    return;
  }
  const yAxis = options.yAxis ?? 'gl';
  const transform = options.transform ?? readFittedTransform(item, options.format, options.project);
  const box = itemSourceBox(item, options.format);
  const corners = CORNERS.map(handle =>
    projectFromUv(handleUv(box, options.format, handle), transform, options.format, yAxis),
  );
  const rotate = rotateHandlePoint(box, transform, options.format, layout.scale, yAxis);
  const north = projectFromUv(handleUv(box, options.format, 'n'), transform, options.format, yAxis);
  const radius = 5 / Math.max(layout.scale, 0.001);
  const points = corners.map(point => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
  const handles = [...CORNERS, ...EDGES].map(handle => {
    const point = projectFromUv(
      handleUv(box, options.format, handle),
      transform,
      options.format,
      yAxis,
    );
    return `<circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="${radius.toFixed(2)}" />`;
  });
  root.hidden = false;
  root.style.left = `${layout.left.toFixed(1)}px`;
  root.style.top = `${layout.top.toFixed(1)}px`;
  root.style.width = `${layout.width.toFixed(1)}px`;
  root.style.height = `${layout.height.toFixed(1)}px`;
  root.innerHTML = `<svg viewBox="0 0 ${options.format.width} ${options.format.height}" preserveAspectRatio="none">
    <polygon class="program-box" points="${points}" />
    <line class="program-stem" x1="${north.x.toFixed(2)}" y1="${north.y.toFixed(2)}" x2="${rotate.x.toFixed(2)}" y2="${rotate.y.toFixed(2)}" />
    ${handles.join('')}
    <circle class="program-rotate" cx="${rotate.x.toFixed(2)}" cy="${rotate.y.toFixed(2)}" r="${(radius * 1.15).toFixed(2)}" />
  </svg>`;
}

function readBox(value: unknown, format: SequenceFormat): ProgramBox {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { x: 0, y: 0, width: format.width, height: format.height };
  }
  const record = value as JsonObject;
  const x = typeof record.x === 'number' ? record.x : 0;
  const y = typeof record.y === 'number' ? record.y : 0;
  const width = typeof record.width === 'number' ? record.width : format.width;
  const height = typeof record.height === 'number' ? record.height : format.height;
  return { x, y, width, height };
}

function pointInItem(
  item: ItemEntity,
  format: SequenceFormat,
  point: Vec2,
  yAxis: ProgramYAxis,
  project: AelionProject | null = null,
): boolean {
  const transform = readFittedTransform(item, format, project);
  const box = itemSourceBox(item, format);
  const uv = uvFromProject(point, transform, format, yAxis);
  const u0 = box.x / format.width;
  const v0 = box.y / format.height;
  const u1 = (box.x + box.width) / format.width;
  const v1 = (box.y + box.height) / format.height;
  return (
    uv.x >= Math.min(u0, u1) &&
    uv.x <= Math.max(u0, u1) &&
    uv.y >= Math.min(v0, v1) &&
    uv.y <= Math.max(v0, v1)
  );
}

function hitHandles(
  item: ItemEntity,
  format: SequenceFormat,
  point: Vec2,
  viewScale: number,
  radius: number,
  yAxis: ProgramYAxis,
  project: AelionProject | null = null,
): ProgramHandle | undefined {
  const transform = readFittedTransform(item, format, project);
  const box = itemSourceBox(item, format);
  const rotate = rotateHandlePoint(box, transform, format, viewScale, yAxis);
  if (Math.hypot(point.x - rotate.x, point.y - rotate.y) <= radius) return 'rotate';
  for (const handle of [...CORNERS, ...EDGES]) {
    const target = projectFromUv(handleUv(box, format, handle), transform, format, yAxis);
    if (Math.hypot(point.x - target.x, point.y - target.y) <= radius) return handle;
  }
  if (pointInItem(item, format, point, yAxis, project)) return 'body';
  return undefined;
}

function clampScale(value: number): number {
  const sign = value < 0 ? -1 : 1;
  return sign * Math.min(8, Math.max(0.05, Math.abs(value)));
}

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

export interface ProgramSnapGuides {
  readonly vertical: readonly number[];
  readonly horizontal: readonly number[];
}

export const EMPTY_PROGRAM_SNAP_GUIDES: ProgramSnapGuides = {
  vertical: [],
  horizontal: [],
};

const CORNERS: readonly ProgramHandle[] = ['nw', 'ne', 'se', 'sw'];
const EDGES: readonly ProgramHandle[] = ['n', 'e', 's', 'w'];
const HANDLE_ORDER: readonly ProgramHandle[] = [...CORNERS, ...EDGES];
const MOVE_SNAP_SCREEN_PX = 8;
const ROTATE_SNAP_DEG = 5;
const ROTATE_SNAP_STEP_DEG = 90;
const SCALE_SNAP_RATIO = 0.04;

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

export interface ProgramSnapTargets {
  readonly x: readonly number[];
  readonly y: readonly number[];
}

/**
 * Collects the guide lines a moved layer can snap to. Only the dragged layer
 * moves during a gesture, so callers resolve this once at pointer-down instead
 * of re-laying-out every other visible layer on each pointer move.
 */
export function collectProgramSnapTargets(options: {
  readonly project: AelionProject;
  readonly format: SequenceFormat;
  readonly timeUs: number;
  readonly excludeItemId: string;
  readonly yAxis: ProgramYAxis;
}): ProgramSnapTargets {
  const { project, format, yAxis } = options;
  const x = [...frameSnapTargets(format.width)];
  const y = [...frameSnapTargets(format.height)];
  for (const other of programItemsAtTime(project, options.timeUs)) {
    if (other.id === options.excludeItemId) continue;
    const otherTransform = readFittedTransform(other, format, project);
    const otherAabb = itemScreenAabb(other, otherTransform, format, yAxis);
    const otherPos = yDownPosition(otherTransform.positionPx, format, yAxis);
    x.push(otherAabb.minX, otherAabb.midX, otherAabb.maxX, otherPos.x);
    y.push(otherAabb.minY, otherAabb.midY, otherAabb.maxY, otherPos.y);
  }
  return { x, y };
}

export function snapProgramMove(options: {
  readonly item: ItemEntity;
  readonly transform: VisualTransform;
  readonly format: SequenceFormat;
  readonly viewScale: number;
  readonly yAxis: ProgramYAxis;
  readonly targets: ProgramSnapTargets;
}): { readonly positionPx: Vec2; readonly guides: ProgramSnapGuides } {
  const { item, transform, format, yAxis, targets } = options;
  const threshold = MOVE_SNAP_SCREEN_PX / Math.max(options.viewScale, 0.001);
  const aabb = itemScreenAabb(item, transform, format, yAxis);
  const pos = yDownPosition(transform.positionPx, format, yAxis);
  const xSnap = nearestDelta([aabb.minX, aabb.midX, aabb.maxX, pos.x], targets.x, threshold);
  const ySnap = nearestDelta([aabb.minY, aabb.midY, aabb.maxY, pos.y], targets.y, threshold);
  const dy = ySnap === undefined ? 0 : yAxis === 'gl' ? -ySnap.delta : ySnap.delta;
  return {
    positionPx: {
      x: transform.positionPx.x + (xSnap?.delta ?? 0),
      y: transform.positionPx.y + dy,
    },
    guides: {
      vertical: xSnap === undefined ? [] : [xSnap.guide],
      horizontal: ySnap === undefined ? [] : [ySnap.guide],
    },
  };
}

export function snapProgramRotation(degrees: number, enabled: boolean): number {
  if (!enabled) return degrees;
  let best = degrees;
  let bestDist = ROTATE_SNAP_DEG;
  for (let target = -180; target <= 180; target += ROTATE_SNAP_STEP_DEG) {
    const dist = angularDistance(degrees, target);
    if (dist <= bestDist) {
      best = target;
      bestDist = dist;
    }
  }
  if (best === -180 && degrees > 0) return 180;
  if (best === 180 && degrees < 0) return -180;
  return best;
}

export function snapProgramScale(
  scale: Vec2,
  identity: Vec2,
  lockAspect: boolean,
  enabled: boolean,
): Vec2 {
  if (!enabled) return scale;
  const snappedX = nearest(
    scale.x,
    [identity.x, -identity.x],
    Math.abs(identity.x) * SCALE_SNAP_RATIO,
  );
  const snappedY = nearest(
    scale.y,
    [identity.y, -identity.y],
    Math.abs(identity.y) * SCALE_SNAP_RATIO,
  );
  if (lockAspect && (snappedX === undefined || snappedY === undefined)) return scale;
  return { x: snappedX ?? scale.x, y: snappedY ?? scale.y };
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
    readonly snapGuides?: ProgramSnapGuides;
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
    return;
  }
  const yAxis = options.yAxis ?? 'gl';
  const transform = options.transform ?? readFittedTransform(item, options.format, options.project);
  const box = itemSourceBox(item, options.format);
  const corners = CORNERS.map(handle =>
    projectFromUv(handleUv(box, options.format, handle), transform, options.format, yAxis),
  );
  const edges = EDGES.map(handle =>
    projectFromUv(handleUv(box, options.format, handle), transform, options.format, yAxis),
  );
  const handles = [...corners, ...edges];
  const rotate = rotateHandlePoint(box, transform, options.format, layout.scale, yAxis);
  const north = projectFromUv(handleUv(box, options.format, 'n'), transform, options.format, yAxis);
  const radius = 5 / Math.max(layout.scale, 0.001);
  const points = corners.map(point => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
  root.hidden = false;
  root.style.left = `${layout.left.toFixed(1)}px`;
  root.style.top = `${layout.top.toFixed(1)}px`;
  root.style.width = `${layout.width.toFixed(1)}px`;
  root.style.height = `${layout.height.toFixed(1)}px`;

  const nodes = overlayNodes(root);
  nodes.svg.setAttribute('viewBox', `0 0 ${options.format.width} ${options.format.height}`);
  nodes.box.setAttribute('points', points);
  setLine(nodes.stem, north, rotate);
  handles.forEach((point, index) => {
    setCircle(nodes.handles[index], point, radius);
  });
  setCircle(nodes.rotate, rotate, radius * 1.15);
  setGuide(nodes.guideX, options.snapGuides?.vertical[0], 'vertical', options.format);
  setGuide(nodes.guideY, options.snapGuides?.horizontal[0], 'horizontal', options.format);
}

interface OverlayNodes {
  readonly svg: SVGSVGElement;
  readonly guideX: SVGLineElement;
  readonly guideY: SVGLineElement;
  readonly box: SVGPolygonElement;
  readonly stem: SVGLineElement;
  readonly handles: readonly SVGCircleElement[];
  readonly rotate: SVGCircleElement;
}

/**
 * A drag repaints the overlay every frame. Reparsing an `innerHTML` template
 * that often churns the DOM and forces style recalculation, so the skeleton is
 * built once per host element and only its attributes move afterwards.
 */
const OVERLAY_NODES = new WeakMap<HTMLElement, OverlayNodes>();

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgElement<K extends keyof SVGElementTagNameMap>(
  tag: K,
  className?: string,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  if (className !== undefined) node.setAttribute('class', className);
  return node;
}

function overlayNodes(root: HTMLElement): OverlayNodes {
  const existing = OVERLAY_NODES.get(root);
  if (existing !== undefined && existing.svg.isConnected) return existing;
  const svg = svgElement('svg');
  svg.setAttribute('preserveAspectRatio', 'none');
  // Guides paint behind the selection box, matching the previous markup order.
  const guideX = svgElement('line', 'program-guide');
  const guideY = svgElement('line', 'program-guide');
  const box = svgElement('polygon', 'program-box');
  const stem = svgElement('line', 'program-stem');
  const handles = Array.from({ length: HANDLE_ORDER.length }, () => svgElement('circle'));
  const rotate = svgElement('circle', 'program-rotate');
  svg.append(guideX, guideY, box, stem, ...handles, rotate);
  root.replaceChildren(svg);
  const nodes: OverlayNodes = { svg, guideX, guideY, box, stem, handles, rotate };
  OVERLAY_NODES.set(root, nodes);
  return nodes;
}

function setCircle(node: SVGCircleElement | undefined, point: Vec2, radius: number): void {
  if (node === undefined) return;
  node.setAttribute('cx', point.x.toFixed(2));
  node.setAttribute('cy', point.y.toFixed(2));
  node.setAttribute('r', radius.toFixed(2));
}

function setLine(node: SVGLineElement, from: Vec2, to: Vec2): void {
  node.setAttribute('x1', from.x.toFixed(2));
  node.setAttribute('y1', from.y.toFixed(2));
  node.setAttribute('x2', to.x.toFixed(2));
  node.setAttribute('y2', to.y.toFixed(2));
}

function setGuide(
  node: SVGLineElement,
  offset: number | undefined,
  axis: 'vertical' | 'horizontal',
  format: SequenceFormat,
): void {
  // Inline style, not a presentation attribute: a later stylesheet rule for
  // .program-guide would silently outrank the attribute.
  if (offset === undefined) {
    node.style.display = 'none';
    return;
  }
  node.style.display = '';
  if (axis === 'vertical') {
    setLine(node, { x: offset, y: 0 }, { x: offset, y: format.height });
    return;
  }
  setLine(node, { x: 0, y: offset }, { x: format.width, y: offset });
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
  for (const handle of HANDLE_ORDER) {
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

function frameSnapTargets(size: number): readonly number[] {
  return [size / 2, size / 3, (size * 2) / 3, 0, size];
}

function itemScreenAabb(
  item: ItemEntity,
  transform: VisualTransform,
  format: SequenceFormat,
  yAxis: ProgramYAxis,
): { minX: number; maxX: number; minY: number; maxY: number; midX: number; midY: number } {
  const box = itemSourceBox(item, format);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const handle of CORNERS) {
    const point = projectFromUv(handleUv(box, format, handle), transform, format, yAxis);
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  return {
    minX,
    maxX,
    minY,
    maxY,
    midX: (minX + maxX) / 2,
    midY: (minY + maxY) / 2,
  };
}

function nearest(value: number, targets: readonly number[], threshold: number): number | undefined {
  let best: number | undefined;
  let bestDist = threshold;
  for (const target of targets) {
    const dist = Math.abs(value - target);
    if (best === undefined ? dist <= threshold : dist < bestDist) {
      best = target;
      bestDist = dist;
    }
  }
  return best;
}

function nearestDelta(
  features: readonly number[],
  targets: readonly number[],
  threshold: number,
): { delta: number; guide: number } | undefined {
  let best: { delta: number; guide: number; dist: number } | undefined;
  for (const value of features) {
    const guide = nearest(value, targets, threshold);
    if (guide === undefined) continue;
    const dist = Math.abs(value - guide);
    if (best === undefined || dist < best.dist) {
      best = { delta: guide - value, guide, dist };
    }
  }
  return best === undefined ? undefined : { delta: best.delta, guide: best.guide };
}

function angularDistance(a: number, b: number): number {
  let dist = Math.abs(a - b) % 360;
  if (dist > 180) dist = 360 - dist;
  return dist;
}


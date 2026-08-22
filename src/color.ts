import type { JsonObject } from '@aelionsdk/core';

export type LinearRgba = readonly [number, number, number, number];

export interface LinearColor {
  readonly space: 'srgb-linear';
  readonly rgba: LinearRgba;
}

function channel(hex: string, offset: number): number {
  return Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
}

function linearize(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function parseHexColor(hex: string): JsonObject {
  if (!/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/u.test(hex)) {
    throw new TypeError('color must be #RRGGBB or #RRGGBBAA');
  }
  return {
    space: 'srgb-linear',
    rgba: [
      linearize(channel(hex, 1)),
      linearize(channel(hex, 3)),
      linearize(channel(hex, 5)),
      hex.length === 9 ? channel(hex, 7) : 1,
    ],
  };
}

export function encodeHex(color: LinearColor | undefined, fallback = '#ffffff'): string {
  if (color === undefined) return fallback;
  const encode = (linear: number): string => {
    const srgb = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, srgb)) * 255)
      .toString(16)
      .padStart(2, '0');
  };
  const r = color.rgba[0];
  const g = color.rgba[1];
  const b = color.rgba[2];
  return `#${encode(r)}${encode(g)}${encode(b)}`;
}

export function readLinearColor(value: unknown): LinearColor | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as { space?: unknown; rgba?: unknown };
  if (record.space !== 'srgb-linear' || !Array.isArray(record.rgba) || record.rgba.length !== 4) {
    return undefined;
  }
  const rgba = record.rgba.map(entry => (typeof entry === 'number' ? entry : 0));
  const r = rgba[0] ?? 0;
  const g = rgba[1] ?? 0;
  const b = rgba[2] ?? 0;
  const a = rgba[3] ?? 1;
  return { space: 'srgb-linear', rgba: [r, g, b, a] };
}

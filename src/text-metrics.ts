import type { JsonObject } from '@aelionsdk/core';
import type { ItemEntity } from '@aelionsdk/project-schema';

export interface TextFormat {
  readonly width: number;
  readonly height: number;
}

export interface TextBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface TextStyle {
  readonly fontFamilies: readonly string[];
  readonly fontSizePx: number;
  readonly fontWeight: number;
  readonly fontStyle: 'normal' | 'italic' | 'oblique';
  readonly lineHeightPx: number;
  readonly letterSpacingPx: number;
  readonly strokeWidthPx: number;
  readonly fill: string;
  readonly align: 'start' | 'center' | 'end';
  readonly direction: 'ltr' | 'rtl';
}

interface LaidSpan {
  readonly text: string;
  readonly x: number;
  readonly style: TextStyle;
}

interface LaidLine {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly spans: readonly LaidSpan[];
}

const graphemeSegmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

function record(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function graphemes(value: string): readonly string[] {
  return Array.from(graphemeSegmenter.segment(value), segment => segment.segment);
}

/** Matches `portableGlyphAdvance` in the compositor so the overlay hugs painted glyphs. */
export function glyphAdvancePx(character: string, fontSizePx: number, letterSpacingPx = 0): number {
  const codePoint = character.codePointAt(0) ?? 0;
  const em =
    character === ' '
      ? 0.33
      : codePoint >= 0x2e80 || codePoint > 0xffff
        ? 1
        : /[ilI1.,'`]/u.test(character)
          ? 0.32
          : /[MW@#%]/u.test(character)
            ? 0.9
            : 0.6;
  return fontSizePx * em + letterSpacingPx;
}

export function measurePlainText(
  text: string,
  fontSizePx: number,
  letterSpacingPx = 0,
): { width: number; height: number } {
  const lines = text.split(/\r?\n/u);
  let width = 0;
  for (const line of lines) {
    const lineWidth = graphemes(line).reduce(
      (total, character) => total + glyphAdvancePx(character, fontSizePx, letterSpacingPx),
      0,
    );
    width = Math.max(width, lineWidth);
  }
  return {
    width: Math.max(1, width),
    height: Math.max(fontSizePx * 1.2, lines.length * fontSizePx * 1.2),
  };
}

function readStyle(runStyle: JsonObject, paragraphStyle: JsonObject = {}): TextStyle {
  const combined = { ...paragraphStyle, ...runStyle };
  const families = Array.isArray(combined.fontFamilies)
    ? combined.fontFamilies.filter((value): value is string => typeof value === 'string')
    : [typeof combined.fontFamily === 'string' ? combined.fontFamily : 'sans-serif'];
  const fontSizePx = Math.max(1, finite(combined.fontSizePx, 32));
  const fontStyle = combined.fontStyle;
  const align = combined.align;
  const direction = combined.direction;
  return {
    fontFamilies: families.length === 0 ? ['sans-serif'] : families,
    fontSizePx,
    fontWeight: Math.max(1, Math.min(1_000, finite(combined.fontWeight, 400))),
    fontStyle: fontStyle === 'italic' || fontStyle === 'oblique' ? fontStyle : 'normal',
    lineHeightPx: Math.max(fontSizePx, finite(combined.lineHeightPx, fontSizePx * 1.2)),
    letterSpacingPx: finite(combined.letterSpacingPx, 0),
    strokeWidthPx: Math.max(0, finite(combined.strokeWidthPx, 0)),
    fill: typeof combined.fill === 'string' && combined.fill.length > 0 ? combined.fill : '#ffffff',
    align: align === 'center' || align === 'end' ? align : 'start',
    direction: direction === 'rtl' ? 'rtl' : 'ltr',
  };
}

function canvasFont(style: TextStyle): string {
  const families = style.fontFamilies
    .map(value => (/^[\w-]+$/u.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`))
    .join(', ');
  return `${style.fontStyle} ${style.fontWeight.toString()} ${style.fontSizePx.toString()}px ${families}`;
}

function tokenAdvance(token: string, style: TextStyle): number {
  return graphemes(token).reduce(
    (total, character) =>
      total + glyphAdvancePx(character, style.fontSizePx, style.letterSpacingPx),
    0,
  );
}

function runTokens(value: string): readonly string[] {
  return value
    .split(/(\r?\n|[\t ]+|(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]))/gu)
    .filter(Boolean);
}

function lineOffset(width: number, boxWidth: number, style: TextStyle): number {
  if (style.align === 'center') return (boxWidth - width) / 2;
  if (style.align === 'end') return style.direction === 'rtl' ? 0 : boxWidth - width;
  return style.direction === 'rtl' ? boxWidth - width : 0;
}

function readLayoutBox(item: ItemEntity, format: TextFormat): TextBox {
  const box = record((item as JsonObject).box);
  return {
    x: finite(box.x, 0),
    y: finite(box.y, 0),
    width: Math.max(1, finite(box.width, format.width)),
    height: Math.max(1, finite(box.height, format.height)),
  };
}

function textParagraphs(item: ItemEntity): readonly { style: JsonObject; runs: JsonObject[] }[] {
  if (item.type === 'caption') {
    const style = record((item as JsonObject).style);
    const rawText = (item as JsonObject).text;
    const text = typeof rawText === 'string' ? rawText : '';
    return [{ style, runs: [{ text, style } as JsonObject] }];
  }
  const paragraphs = (item as JsonObject).paragraphs;
  if (!Array.isArray(paragraphs)) return [];
  return paragraphs.flatMap(paragraphValue => {
    const paragraph = record(paragraphValue);
    const runs = Array.isArray(paragraph.runs) ? paragraph.runs.map(record) : [];
    return [{ style: record(paragraph.style), runs }];
  });
}

function layoutInkLines(item: ItemEntity, format: TextFormat): readonly LaidLine[] {
  const box = readLayoutBox(item, format);
  const lines: LaidLine[] = [];
  let cursorY = box.y;
  let currentWidth = 0;
  let currentHeight = 0;
  let currentSpans: LaidSpan[] = [];
  let currentAlign: TextStyle | undefined;
  const flush = (): void => {
    if (currentHeight <= 0 && currentWidth <= 0) return;
    const style = currentAlign ?? readStyle({});
    const offset = lineOffset(currentWidth, box.width, style);
    lines.push({
      x: box.x + offset,
      y: cursorY,
      width: Math.max(1, currentWidth),
      height: Math.max(1, currentHeight),
      spans: currentSpans.map(span => ({ ...span, x: span.x + offset })),
    });
    cursorY += currentHeight;
    currentWidth = 0;
    currentHeight = 0;
    currentSpans = [];
  };
  for (const paragraph of textParagraphs(item)) {
    for (const run of paragraph.runs) {
      const style = readStyle(record(run.style), paragraph.style);
      const text = typeof run.text === 'string' ? run.text : '';
      for (const token of runTokens(text)) {
        if (token === '\n' || token === '\r\n') {
          flush();
          continue;
        }
        if (currentWidth === 0 && currentHeight === 0) currentAlign = style;
        const advance = tokenAdvance(token, style);
        if (currentWidth > 0 && currentWidth + advance > box.width && token.trim().length > 0) {
          flush();
          currentAlign = style;
        }
        currentSpans.push({ text: token, x: box.x + currentWidth, style });
        currentWidth += advance;
        currentHeight = Math.max(currentHeight, style.lineHeightPx);
      }
    }
    flush();
  }
  return lines;
}

function spanPaintY(line: LaidLine, style: TextStyle): number {
  return line.y + Math.max(0, (line.height - style.lineHeightPx) / 2);
}

export function textInkBox(item: ItemEntity, format: TextFormat): TextBox {
  const layout = readLayoutBox(item, format);
  const lines = layoutInkLines(item, format);
  if (lines.length === 0) {
    const size = Math.max(24, Math.min(layout.width, layout.height, 48));
    return { x: layout.x, y: layout.y, width: size, height: size };
  }
  const bounds = {
    x0: Number.POSITIVE_INFINITY,
    y0: Number.POSITIVE_INFINITY,
    x1: Number.NEGATIVE_INFINITY,
    y1: Number.NEGATIVE_INFINITY,
  };
  let pad = 1;
  let fontSizePx = 0;
  for (const line of lines) {
    for (const span of line.spans) {
      pad = Math.max(pad, span.style.strokeWidthPx);
      fontSizePx = Math.max(fontSizePx, span.style.fontSizePx);
      const y = spanPaintY(line, span.style);
      if (span.style.direction === 'rtl') {
        const advance = tokenAdvance(span.text, span.style);
        bounds.x0 = Math.min(bounds.x0, span.x);
        bounds.y0 = Math.min(bounds.y0, y);
        bounds.x1 = Math.max(bounds.x1, span.x + advance);
        bounds.y1 = Math.max(bounds.y1, y + span.style.fontSizePx);
        continue;
      }
      let cursor = span.x;
      for (const character of graphemes(span.text)) {
        const advance = glyphAdvancePx(
          character,
          span.style.fontSizePx,
          span.style.letterSpacingPx,
        );
        if (advance >= 0.5) {
          bounds.x0 = Math.min(bounds.x0, cursor);
          bounds.y0 = Math.min(bounds.y0, y);
          bounds.x1 = Math.max(bounds.x1, cursor + advance);
          bounds.y1 = Math.max(bounds.y1, y + span.style.fontSizePx);
        }
        cursor += advance;
      }
    }
  }
  if (!Number.isFinite(bounds.x0) || !Number.isFinite(bounds.y0)) {
    const size = Math.max(24, Math.min(layout.width, layout.height, 48));
    return { x: layout.x, y: layout.y, width: size, height: size };
  }
  const leftPad = Math.max(pad, fontSizePx * 0.14);
  return {
    x: bounds.x0 - leftPad,
    y: bounds.y0 - pad,
    width: Math.max(1, bounds.x1 - bounds.x0 + leftPad + pad),
    height: Math.max(1, bounds.y1 - bounds.y0 + pad * 2),
  };
}

export function paintTextItem(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  item: ItemEntity,
  format: TextFormat,
): void {
  context.textAlign = 'start';
  context.textBaseline = 'top';
  for (const line of layoutInkLines(item, format)) {
    for (const span of line.spans) {
      context.font = canvasFont(span.style);
      context.fillStyle = span.style.fill;
      context.direction = span.style.direction;
      const y = spanPaintY(line, span.style);
      if (span.style.direction === 'rtl') {
        context.fillText(span.text, span.x + tokenAdvance(span.text, span.style), y);
        continue;
      }
      let cursor = span.x;
      for (const character of graphemes(span.text)) {
        context.fillText(character, cursor, y);
        cursor += glyphAdvancePx(character, span.style.fontSizePx, span.style.letterSpacingPx);
      }
    }
  }
}

export function fittedTextBox(
  text: string,
  fontSizePx: number,
  format: TextFormat,
  options: { readonly yRatio?: number; readonly letterSpacingPx?: number } = {},
): TextBox {
  const measured = measurePlainText(text, fontSizePx, options.letterSpacingPx ?? 0);
  const width = Math.min(format.width, Math.max(1, measured.width));
  const height = Math.min(format.height, Math.max(1, measured.height));
  return {
    x: (format.width - width) / 2,
    y: format.height * (options.yRatio ?? 0.35),
    width,
    height,
  };
}

export function boxKeepingCenter(previous: TextBox, nextSize: TextBox): TextBox {
  return {
    x: previous.x + previous.width / 2 - nextSize.width / 2,
    y: previous.y + previous.height / 2 - nextSize.height / 2,
    width: nextSize.width,
    height: nextSize.height,
  };
}

export function jsonBox(box: TextBox): JsonObject {
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

/** Text for the raster overlays (TR-MOV-07): glyph outlines of a bundled font (`ctx.fonts`) as even-odd fills, single-line fonts as strokes. */

import { parseFont, type ParsedFont } from '../../../lib/font/font';
import { flattenLoop } from '../../../lib/font/outline';
import type { Vec2 } from '../../../model/vectors';
import { textOutline } from '../../../geometry/textOutline';
import type { ExecutionContext } from '../../types';
import type { OverlayFill, OverlayStroke, Rgb } from './rasterOverlay';

const CURVE_POINTS = 6;
const parsedFonts = new Map<string, ParsedFont | null>();

/** The first bundled font that parses to a usable outline or stroke font, or null (no `ctx.fonts`, no bytes, no parse). */
export function overlayFont(ctx: ExecutionContext | undefined): ParsedFont | null {
  const provider = ctx?.fonts;
  if (provider === undefined || provider === null) return null;
  for (const font of provider.list()) {
    const cached = parsedFonts.get(font.sha256);
    if (cached !== undefined) {
      if (cached !== null) return cached;
      continue;
    }
    const bytes = provider.bytes(font.id);
    const parsed = bytes === null ? null : parseFont(bytes);
    const usable = parsed !== null && parsed.ok ? parsed.font : null;
    parsedFonts.set(font.sha256, usable);
    if (usable !== null) return usable;
  }
  return null;
}

/** Text placed in logical pixels: its fills and strokes and the advance width of the line. */
export interface PlacedText {
  readonly fills: readonly OverlayFill[];
  readonly strokes: readonly OverlayStroke[];
  readonly width: number;
}

/** `content` with its baseline at `baseline`, its left end (or right end with `align: 'right'`) at `x`, cap height `capPx`, in `color` at depth `z`. */
export function placeText(
  font: ParsedFont,
  content: string,
  capPx: number,
  x: number,
  baseline: number,
  align: 'left' | 'right',
  color: Rgb,
  z: number,
): PlacedText {
  const outline = textOutline({ content, height: capPx, anchor: 'left' }, font);
  if ('error' in outline) return { fills: [], strokes: [], width: 0 };
  const width = outline.layout.advanceWidth;
  const left = align === 'right' ? x - width : x;
  const place = (point: Vec2): Vec2 => [left + point[0], baseline - point[1]];
  const fills = outline.regions.map(
    (region): OverlayFill => ({
      color,
      z,
      loops: [region.outer, ...region.holes].map((loop) => flattenLoop(loop, CURVE_POINTS).map(place)),
    }),
  );
  const strokes = outline.strokes.map(
    (stroke): OverlayStroke => ({ color, z, halfWidth: Math.max(0.6, capPx / 12), points: stroke.map(place) }),
  );
  return { fills, strokes, width };
}

/**
 * The single-line (open-stroke) font format of llull (03 WRP M5): a JSON document of glyphs made of polylines, for engraving, where an outline font would trace both sides of a
 * stroke. Bundled: `server/fonts/LlullSingleLine.json` (an original work, CC0-1.0).
 * @invariant the document is validated once: glyph, stroke and point counts are capped, every number is finite and within +-1e5 font units
 * @failure not JSON, the wrong format tag or version, a malformed glyph, over the caps -> WRP_FONT_PARSE
 */

import type { Vec2 } from '../../model/vectors';
import { isFiniteNumber } from '../isFiniteNumber';
import { isRecord } from '../isRecord';
import { parseError } from './reader';

const MAX_GLYPHS = 4096;
const MAX_STROKES = 64;
const MAX_POINTS = 1024;
const MAX_TOTAL_POINTS = 400_000;
const LIMIT = 1e5;

export interface StrokeFont {
  readonly unitsPerEm: number;
  readonly ascender: number;
  readonly descender: number;
  readonly lineGap: number;
  readonly capHeight: number;
  readonly names: { readonly family: string; readonly style: string; readonly licence?: string };
  readonly glyphCount: number;
  /** Glyph index of a code point (lower case falls back to its capital); 0 when the font has none. */
  readonly glyphIndex: (codePoint: number) => number;
  readonly advance: (glyph: number) => number;
  /** Strokes of a glyph in font units, y up. */
  readonly strokes: (glyph: number) => readonly (readonly Vec2[])[];
}

/** A stroke font starts with an opening brace (an sfnt starts with a version tag). */
export const isStrokeFont = (bytes: Uint8Array): boolean => bytes[0] === 0x7b;

const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256)
    throw parseError(`stroke font: ${label} must be a short non-empty string`);
  return value;
};

const metric = (record: Record<string, unknown>, key: string, positive: boolean): number => {
  const value = record[key];
  if (!isFiniteNumber(value) || Math.abs(value) > LIMIT || (positive && !(value > 0)))
    throw parseError(`stroke font: ${key} must be a finite number${positive ? ' > 0' : ''}`);
  return value;
};

function readStroke(raw: unknown, budget: { points: number }): Vec2[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_POINTS)
    throw parseError(`stroke font: a stroke needs 1..${MAX_POINTS} points`);
  budget.points += raw.length;
  if (budget.points > MAX_TOTAL_POINTS) throw parseError(`stroke font: more than ${MAX_TOTAL_POINTS} points`);
  const points = raw.map((point): Vec2 => {
    if (
      !Array.isArray(point) ||
      point.length !== 2 ||
      !isFiniteNumber(point[0]) ||
      !isFiniteNumber(point[1]) ||
      Math.abs(point[0]) > LIMIT ||
      Math.abs(point[1]) > LIMIT
    )
      throw parseError('stroke font: a point is not a pair of finite numbers');
    return [point[0], point[1]];
  });
  // coincident neighbours are one point: a stroke never has a zero-length piece
  return points.filter((p, k) => k === 0 || Math.hypot(p[0] - (points[k - 1] as Vec2)[0], p[1] - (points[k - 1] as Vec2)[1]) > 1e-9);
}

export function readStrokeFont(bytes: Uint8Array): StrokeFont {
  let root: unknown;
  try {
    root = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw parseError('stroke font: not valid UTF-8 JSON');
  }
  if (!isRecord(root) || root['format'] !== 'llull-stroke-font' || root['version'] !== 1)
    throw parseError("stroke font: format must be 'llull-stroke-font' version 1");
  const unitsPerEm = metric(root, 'unitsPerEm', true);
  if (unitsPerEm < 16 || unitsPerEm > 16384) throw parseError('stroke font: unitsPerEm is outside 16..16384');
  const glyphs = root['glyphs'];
  if (!isRecord(glyphs)) throw parseError('stroke font: glyphs must be an object');
  const keys = Object.keys(glyphs).sort();
  if (keys.length === 0 || keys.length > MAX_GLYPHS) throw parseError(`stroke font: ${keys.length} glyphs (expected 1..${MAX_GLYPHS})`);
  const budget = { points: 0 };
  const index = new Map<number, number>();
  const advances: number[] = [Math.round(unitsPerEm / 2)];
  const strokes: Vec2[][][] = [[]];
  for (const key of keys) {
    const glyph = glyphs[key];
    const code = key.codePointAt(0);
    if ([...key].length !== 1 || code === undefined || !isRecord(glyph))
      throw parseError(`stroke font: glyph key '${key}' must be one character with an object body`);
    const raw = glyph['strokes'];
    if (!Array.isArray(raw) || raw.length > MAX_STROKES)
      throw parseError(`stroke font: glyph '${key}' needs at most ${MAX_STROKES} strokes`);
    index.set(code, strokes.length);
    advances.push(metric(glyph, 'advance', false));
    strokes.push(raw.map((stroke) => readStroke(stroke, budget)));
  }
  const licence = root['licence'];
  return {
    unitsPerEm,
    ascender: metric(root, 'ascender', false),
    descender: metric(root, 'descender', false),
    lineGap: metric(root, 'lineGap', false),
    capHeight: metric(root, 'capHeight', true),
    names: {
      family: text(root['family'], 'family'),
      style: text(root['style'], 'style'),
      ...(typeof licence === 'string' && licence.length > 0 && licence.length <= 256 ? { licence } : {}),
    },
    glyphCount: strokes.length,
    glyphIndex: (codePoint) => index.get(codePoint) ?? index.get(String.fromCodePoint(codePoint).toUpperCase().codePointAt(0) ?? -1) ?? 0,
    advance: (glyph) => advances[glyph] ?? 0,
    strokes: (glyph) => strokes[glyph] ?? [],
  };
}

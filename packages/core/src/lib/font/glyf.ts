/**
 * TrueType glyph outlines (`loca` + `glyf`): simple glyphs (flags, delta-coded coordinates) and composite glyphs (offset + scale / 2x2 transforms),
 * returned as raw contours of on/off-curve points in font units (03 WRP, TECHNICAL_SPEC §5.4).
 * @invariant a hostile font is bounded: glyph ranges inside `glyf`, <= MAX_CONTOURS contours and MAX_GLYPH_POINTS points per glyph (composites
 *   included), composite depth <= MAX_COMPOSITE_DEPTH and <= MAX_COMPONENTS components per glyph tree, so a composite loop cannot recurse forever
 * A mirrored component (negative determinant) has its contours reversed so winding stays consistent.
 * @failure any out-of-range read, bad count, point-matching composite -> WRP_FONT_PARSE
 */

import { type ByteView, parseError } from './reader';

interface GlyphPoint {
  readonly x: number;
  readonly y: number;
  readonly on: boolean;
}

export type RawContour = readonly GlyphPoint[];

const MAX_CONTOURS = 4096;
const MAX_GLYPH_POINTS = 20000;
const MAX_COMPOSITE_DEPTH = 8;
const MAX_COMPONENTS = 256;

interface Budget {
  points: number;
  components: number;
}

export interface GlyphSource {
  readonly glyf: ByteView;
  readonly loca: ByteView;
  readonly longLoca: boolean;
  readonly numGlyphs: number;
}

function range(source: GlyphSource, glyph: number): readonly [number, number] {
  if (!Number.isInteger(glyph) || glyph < 0 || glyph >= source.numGlyphs)
    throw parseError(`glyf: glyph ${glyph} is outside 0..${source.numGlyphs - 1}`);
  const { loca, longLoca } = source;
  const start = longLoca ? loca.u32(4 * glyph) : 2 * loca.u16(2 * glyph);
  const end = longLoca ? loca.u32(4 * glyph + 4) : 2 * loca.u16(2 * glyph + 2);
  if (end < start || end > source.glyf.length) throw parseError(`glyf: glyph ${glyph} range ${start}..${end} lies outside the table`);
  return [start, end];
}

function simpleGlyph(table: ByteView, count: number, budget: Budget): RawContour[] {
  if (count > MAX_CONTOURS) throw parseError(`glyf: ${count} contours`);
  const ends: number[] = [];
  for (let k = 0; k < count; k++) {
    const end = table.u16(10 + 2 * k);
    if (k > 0 && end <= (ends[k - 1] as number)) throw parseError('glyf: contour end points are not increasing');
    ends.push(end);
  }
  const points = count === 0 ? 0 : (ends[count - 1] as number) + 1;
  budget.points += points;
  if (budget.points > MAX_GLYPH_POINTS) throw parseError(`glyf: more than ${MAX_GLYPH_POINTS} points in one glyph`);
  let at = 10 + 2 * count;
  at += 2 + table.u16(at);
  const flags: number[] = [];
  while (flags.length < points) {
    const flag = table.u8(at++);
    flags.push(flag);
    if ((flag & 8) !== 0) for (let repeat = table.u8(at++); repeat > 0 && flags.length < points; repeat--) flags.push(flag);
  }
  const axis = (short: number, same: number): number[] => {
    const values: number[] = [];
    let value = 0;
    for (const flag of flags) {
      if ((flag & short) !== 0) {
        const delta = table.u8(at++);
        value += (flag & same) !== 0 ? delta : -delta;
      } else if ((flag & same) === 0) {
        value += table.i16(at);
        at += 2;
      }
      values.push(value);
    }
    return values;
  };
  const xs = axis(2, 16);
  const ys = axis(4, 32);
  const contours: GlyphPoint[][] = [];
  let first = 0;
  for (const last of ends) {
    const contour: GlyphPoint[] = [];
    for (let k = first; k <= last; k++) contour.push({ x: xs[k] as number, y: ys[k] as number, on: ((flags[k] as number) & 1) === 1 });
    contours.push(contour);
    first = last + 1;
  }
  return contours;
}

const f2dot14 = (table: ByteView, at: number): number => table.i16(at) / 16384;

function compositeGlyph(source: GlyphSource, table: ByteView, depth: number, budget: Budget): RawContour[] {
  const out: RawContour[] = [];
  let at = 10;
  for (;;) {
    if (++budget.components > MAX_COMPONENTS) throw parseError(`glyf: more than ${MAX_COMPONENTS} composite components`);
    const flags = table.u16(at);
    const child = table.u16(at + 2);
    at += 4;
    let dx: number;
    let dy: number;
    if ((flags & 1) !== 0) {
      dx = table.i16(at);
      dy = table.i16(at + 2);
      at += 4;
    } else {
      dx = table.i8(at);
      dy = table.i8(at + 1);
      at += 2;
    }
    if ((flags & 2) === 0) throw parseError('glyf: composite glyph placed by point matching is not supported');
    let [a, b, c, d] = [1, 0, 0, 1];
    if ((flags & 8) !== 0) {
      a = d = f2dot14(table, at);
      at += 2;
    } else if ((flags & 0x40) !== 0) {
      a = f2dot14(table, at);
      d = f2dot14(table, at + 2);
      at += 4;
    } else if ((flags & 0x80) !== 0) {
      [a, b, c, d] = [f2dot14(table, at), f2dot14(table, at + 2), f2dot14(table, at + 4), f2dot14(table, at + 6)];
      at += 8;
    }
    const mirrored = a * d - b * c < 0;
    for (const contour of outline(source, child, depth + 1, budget)) {
      const placed = contour.map((point) => ({ x: a * point.x + c * point.y + dx, y: b * point.x + d * point.y + dy, on: point.on }));
      out.push(mirrored ? placed.reverse() : placed);
    }
    if ((flags & 0x20) === 0) break;
  }
  return out;
}

function outline(source: GlyphSource, glyph: number, depth: number, budget: Budget): RawContour[] {
  if (depth > MAX_COMPOSITE_DEPTH) throw parseError(`glyf: composite glyphs nested deeper than ${MAX_COMPOSITE_DEPTH}`);
  const [start, end] = range(source, glyph);
  if (end === start) return [];
  const table = source.glyf.sub(start, end - start, `glyph ${glyph}`);
  const count = table.i16(0);
  return count >= 0 ? simpleGlyph(table, count, budget) : compositeGlyph(source, table, depth, budget);
}

/** The raw contours of `glyph` (empty for a blank glyph such as the space). */
export function glyphContours(source: GlyphSource, glyph: number): RawContour[] {
  return outline(source, glyph, 0, { points: 0, components: 0 });
}

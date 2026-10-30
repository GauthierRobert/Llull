/**
 * TrueType glyph variations (`gvar`, 03 WRP, TECHNICAL_SPEC §14.14): the tuple variation store of a variable font. Per glyph a list of tuples (a region of the design space and
 * packed x / y deltas for some points, or for all of them) whose deltas, scaled by the tuple scalar at the instance, are added to the point coordinates. Points a tuple does not
 * name are inferred from the named ones of their contour (IUP). The four phantom points that follow the outline carry the advance variation.
 * @invariant bounded for a hostile font: <= 64 axes, <= 4096 shared tuples, every offset checked by `ByteView`, <= 4095 tuples per glyph, point numbers and delta runs counted
 *   against the glyph's point count (+ 4 phantom points), and the work of a font (tuples x points) charged to a shared budget
 * @failure a damaged table, a point number outside the glyph, a run past the data, an axis count different from `fvar` -> WRP_FONT_PARSE
 */

import { type ByteView, parseError } from './reader';
import { regionScalar } from './variation';

const MAX_AXES = 64;
const MAX_SHARED_TUPLES = 4096;
/** Tuples x points a single glyph may cost, and the cap on a whole font (shared with the CFF operator budget). */
const MAX_GLYPH_WORK = 2_000_000;
const PHANTOM_POINTS = 4;

/** The coordinates of the points of a glyph the deltas are for. A composite glyph's points are its component offsets. */
export interface GlyphPoints {
  readonly xs: readonly number[];
  readonly ys: readonly number[];
  /** Contour end points (simple glyphs), absent for a composite. */
  readonly ends: readonly number[] | null;
}

interface PointDeltas {
  /** One delta per point, then the four phantom points. */
  readonly dx: number[];
  readonly dy: number[];
}

export interface GlyphVariations {
  /** The deltas of `glyph` at `coords`, or null when the glyph has no variation data or every tuple has scalar 0. @failure -> WRP_FONT_PARSE */
  readonly deltas: (glyph: number, coords: readonly number[], points: GlyphPoints, budget?: { remaining: number }) => PointDeltas | null;
}

interface Tuple {
  readonly peak: readonly number[];
  readonly start: readonly number[] | null;
  readonly end: readonly number[] | null;
  readonly size: number;
  readonly privatePoints: boolean;
  readonly shared: number;
}

const f2dot14 = (view: ByteView, at: number): number => view.i16(at) / 16384;

/** Packed point numbers at `at`: the point list (null = all points) and the offset after it. */
function packedPoints(view: ByteView, at: number, pointCount: number): { points: number[] | null; next: number } {
  let count = view.u8(at++);
  if (count >= 0x80) count = ((count & 0x7f) << 8) | view.u8(at++);
  if (count === 0) return { points: null, next: at };
  if (count > pointCount) throw parseError(`gvar: ${count} point numbers for a glyph of ${pointCount} points`);
  const points: number[] = [];
  let previous = 0;
  while (points.length < count) {
    const control = view.u8(at++);
    const run = (control & 0x7f) + 1;
    const words = (control & 0x80) !== 0;
    if (points.length + run > count) throw parseError('gvar: a point-number run goes past the point count');
    for (let k = 0; k < run; k++) {
      previous += words ? view.u16(at) : view.u8(at);
      at += words ? 2 : 1;
      if (previous >= pointCount) throw parseError(`gvar: point number ${previous} is outside the ${pointCount} points of the glyph`);
      points.push(previous);
    }
  }
  return { points, next: at };
}

/** `count` packed deltas at `at` and the offset after them. */
function packedDeltas(view: ByteView, at: number, count: number): { deltas: number[]; next: number } {
  const deltas: number[] = [];
  while (deltas.length < count) {
    const control = view.u8(at++);
    const run = (control & 0x3f) + 1;
    if (deltas.length + run > count) throw parseError('gvar: a delta run goes past the delta count');
    if ((control & 0x80) !== 0) for (let k = 0; k < run; k++) deltas.push(0);
    else if ((control & 0x40) !== 0) for (let k = 0; k < run; k++, at += 2) deltas.push(view.i16(at));
    else for (let k = 0; k < run; k++, at += 1) deltas.push(view.i8(at));
  }
  return { deltas, next: at };
}

/** The scalar of a tuple at `coords` (a tuple without an intermediate region spans from 0 to its peak). */
function tupleScalar(tuple: Tuple, shared: readonly (readonly number[])[], coords: readonly number[]): number {
  const peak = tuple.shared >= 0 ? (shared[tuple.shared] as readonly number[]) : tuple.peak;
  const region = peak.map((p, axis): readonly [number, number, number] => {
    const start = tuple.start === null ? Math.min(0, p) : (tuple.start[axis] as number);
    const end = tuple.end === null ? Math.max(0, p) : (tuple.end[axis] as number);
    return [start, p, end];
  });
  return regionScalar(region, coords);
}

/** Interpolation of the deltas of untouched points of one axis between the touched points `a` and `b` of a contour (OpenType 'Inferred deltas'). */
function inferDelta(coordinate: number, a: { x: number; d: number }, b: { x: number; d: number }): number {
  const [low, high] = a.x <= b.x ? [a, b] : [b, a];
  if (low.x === high.x) return low.d === high.d ? low.d : 0;
  if (coordinate <= low.x) return low.d;
  if (coordinate >= high.x) return high.d;
  return low.d + ((coordinate - low.x) / (high.x - low.x)) * (high.d - low.d);
}

/** The deltas of one axis with the untouched points of every contour inferred (IUP). */
function inferUntouched(
  values: readonly number[],
  deltas: readonly number[],
  touched: readonly boolean[],
  ends: readonly number[],
): number[] {
  const out = [...deltas];
  let first = 0;
  for (const last of ends) {
    const indices = Array.from({ length: last - first + 1 }, (_, k) => first + k).filter((k) => touched[k] === true);
    if (indices.length === 1) {
      const only = indices[0] as number;
      for (let k = first; k <= last; k++) out[k] = deltas[only] as number;
    } else if (indices.length > 1) {
      for (let t = 0; t < indices.length; t++) {
        const a = indices[t] as number;
        const b = indices[(t + 1) % indices.length] as number;
        const ra = { x: values[a] as number, d: deltas[a] as number };
        const rb = { x: values[b] as number, d: deltas[b] as number };
        for (let k = a + 1 > last ? first : a + 1; k !== b; k = k + 1 > last ? first : k + 1)
          out[k] = inferDelta(values[k] as number, ra, rb);
      }
    }
    first = last + 1;
  }
  return out;
}

/** The `gvar` table of a font with `numGlyphs` glyphs and `axisCount` axes. @failure a damaged header or offset -> WRP_FONT_PARSE */
export function readGvar(view: ByteView, numGlyphs: number, axisCount: number): GlyphVariations {
  if (view.u16(0) !== 1) throw parseError(`gvar: version ${view.u16(0)} is not 1`);
  const gvarAxes = view.u16(4);
  if (gvarAxes !== axisCount) throw parseError(`gvar: ${gvarAxes} axes for the ${axisCount} of fvar`);
  if (axisCount > MAX_AXES) throw parseError(`gvar: ${axisCount} axes exceed ${MAX_AXES}`);
  const sharedCount = view.u16(6);
  if (sharedCount > MAX_SHARED_TUPLES) throw parseError(`gvar: ${sharedCount} shared tuples exceed ${MAX_SHARED_TUPLES}`);
  const sharedAt = view.u32(8);
  const glyphCount = view.u16(12);
  if (glyphCount > numGlyphs) throw parseError(`gvar: ${glyphCount} glyphs for a font of ${numGlyphs}`);
  const long = (view.u16(14) & 1) !== 0;
  const dataAt = view.u32(16);
  const shared = Array.from({ length: sharedCount }, (_, k) =>
    Array.from({ length: axisCount }, (_, a) => f2dot14(view, sharedAt + 2 * (k * axisCount + a))),
  );
  const offsetOf = (glyph: number): number => (long ? view.u32(20 + 4 * glyph) : 2 * view.u16(20 + 2 * glyph));
  return {
    deltas: (glyph, coords, points, budget) => {
      if (glyph >= glyphCount) return null;
      const from = offsetOf(glyph);
      const to = offsetOf(glyph + 1);
      if (to < from) throw parseError(`gvar: the data of glyph ${glyph} ends before it starts`);
      if (to === from) return null;
      const data = view.sub(dataAt + from, to - from, `gvar glyph ${glyph}`);
      const pointCount = points.xs.length + PHANTOM_POINTS;
      const header = data.u16(0);
      const tupleCount = header & 0x0fff;
      const hasShared = (header & 0x8000) !== 0;
      let at = 4;
      const tuples: Tuple[] = [];
      for (let k = 0; k < tupleCount; k++) {
        const size = data.u16(at);
        const index = data.u16(at + 2);
        at += 4;
        let peak: number[] = [];
        if ((index & 0x8000) !== 0) {
          peak = Array.from({ length: axisCount }, (_, a) => f2dot14(data, at + 2 * a));
          at += 2 * axisCount;
        } else if ((index & 0x0fff) >= sharedCount) throw parseError(`gvar: shared tuple ${index & 0x0fff} of ${sharedCount}`);
        let start: number[] | null = null;
        let end: number[] | null = null;
        if ((index & 0x4000) !== 0) {
          start = Array.from({ length: axisCount }, (_, a) => f2dot14(data, at + 2 * a));
          end = Array.from({ length: axisCount }, (_, a) => f2dot14(data, at + 2 * axisCount + 2 * a));
          at += 4 * axisCount;
        }
        tuples.push({
          peak,
          start,
          end,
          size,
          privatePoints: (index & 0x2000) !== 0,
          shared: (index & 0x8000) !== 0 ? -1 : index & 0x0fff,
        });
      }
      let cursor = data.u16(2);
      let sharedPoints: number[] | null = null;
      if (hasShared) {
        const read = packedPoints(data, cursor, pointCount);
        sharedPoints = read.points;
        cursor = read.next;
      }
      const dx = new Array<number>(pointCount).fill(0);
      const dy = new Array<number>(pointCount).fill(0);
      let any = false;
      for (const tuple of tuples) {
        const scalar = tupleScalar(tuple, shared, coords);
        const body = cursor;
        cursor += tuple.size;
        if (scalar === 0) continue;
        let named = sharedPoints;
        let position = body;
        if (tuple.privatePoints) {
          const read = packedPoints(data, position, pointCount);
          named = read.points;
          position = read.next;
        }
        const count = named === null ? pointCount : named.length;
        if (budget !== undefined && (budget.remaining -= count + 1) < 0) throw parseError('gvar: more tuple work than a font may cost');
        if (count * tuples.length > MAX_GLYPH_WORK) throw parseError(`gvar: glyph ${glyph} costs more than ${MAX_GLYPH_WORK} delta reads`);
        const xs = packedDeltas(data, position, count);
        const ys = packedDeltas(data, xs.next, count);
        let tx = new Array<number>(pointCount).fill(0);
        let ty = new Array<number>(pointCount).fill(0);
        const touched = new Array<boolean>(pointCount).fill(named === null);
        if (named === null) {
          tx = xs.deltas;
          ty = ys.deltas;
        } else
          named.forEach((point, k) => {
            tx[point] = xs.deltas[k] as number;
            ty[point] = ys.deltas[k] as number;
            touched[point] = true;
          });
        if (named !== null && points.ends !== null) {
          const inner = points.xs.length;
          const ends = points.ends;
          tx = [...inferUntouched(points.xs, tx.slice(0, inner), touched.slice(0, inner), ends), ...tx.slice(inner)];
          ty = [...inferUntouched(points.ys, ty.slice(0, inner), touched.slice(0, inner), ends), ...ty.slice(inner)];
        }
        for (let k = 0; k < pointCount; k++) {
          dx[k] = (dx[k] as number) + scalar * (tx[k] as number);
          dy[k] = (dy[k] as number) + scalar * (ty[k] as number);
        }
        any = true;
      }
      return any ? { dx, dy } : null;
    },
  };
}

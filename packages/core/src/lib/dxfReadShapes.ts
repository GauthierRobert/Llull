/**
 * Readers of the DXF entities that need more than a point or two: SPLINE (fit points, or the NURBS sampled), HATCH boundary loops and
 * pattern, and the `LLULL` extended data `export_dxf` writes (kind tags that restore rectangles, splines and unhatched regions).
 */

import type { Vec2, Vec3 } from '../model/vectors';
import { positiveSweep, toRadians } from './angle';
import { type DxfRecord, codeNumber } from './dxfRecord';

/** Application name of the extended data written by `export_dxf` (registered in the APPID table). */
export const LLULL_APP = 'LLULL';

export interface LlullXdata {
  /** First 1000 string: `rectangle`, `spline` or `region`. */
  readonly tag: string;
  readonly ints: readonly number[];
  readonly points: readonly Vec3[];
}

/** The `LLULL` extended data of a record, or null when it has none. */
export function llullXdata(record: DxfRecord): LlullXdata | null {
  const start = record.codes.findIndex(([code, value]) => code === 1001 && value === LLULL_APP);
  if (start < 0) return null;
  let tag: string | null = null;
  const ints: number[] = [];
  const points: Vec3[] = [];
  for (let at = start + 1; at < record.codes.length; at++) {
    const [code, value] = record.codes[at] as readonly [number, string];
    if (code === 1001) break;
    if (code === 1000 && tag === null) tag = value;
    else if (code === 1070) ints.push(Number(value));
    else if (code === 1010) points.push([Number(value), Number(record.codes[at + 1]?.[1]), Number(record.codes[at + 2]?.[1])]);
  }
  return tag === null ? null : { tag, ints, points };
}

/** Samples per knot span of a foreign NURBS, and the cap on the sampled points. */
const SAMPLES_PER_SPAN = 8;
const MAX_SPLINE_SAMPLES = 512;
/** Highest degree and most control points of a SPLINE that is sampled (larger ones are skipped as malformed). */
const MAX_SPLINE_DEGREE = 25;
const MAX_SPLINE_CONTROLS = 100000;

/** Point of the (rational) B-spline at `t`, by de Boor on homogeneous coordinates. */
function deBoor(degree: number, knots: readonly number[], controls: readonly Vec3[], weights: readonly number[], t: number): Vec3 {
  const count = controls.length;
  let [low, high] = [degree, count - 1];
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((knots[middle] as number) <= t) low = middle;
    else high = middle - 1;
  }
  const span = low;
  const work = Array.from({ length: degree + 1 }, (_, j): number[] => {
    const index = span - degree + j;
    const weight = weights[index] ?? 1;
    const control = controls[index] as Vec3;
    return [control[0] * weight, control[1] * weight, control[2] * weight, weight];
  });
  for (let level = 1; level <= degree; level++) {
    for (let j = degree; j >= level; j--) {
      const index = span - degree + j;
      const low = knots[index] as number;
      const denominator = (knots[index + degree - level + 1] as number) - low;
      const alpha = denominator === 0 ? 0 : (t - low) / denominator;
      const previous = work[j - 1] as number[];
      const current = work[j] as number[];
      work[j] = current.map((value, axis) => (1 - alpha) * (previous[axis] as number) + alpha * value);
    }
  }
  const [x, y, z, w] = work[degree] as [number, number, number, number];
  return [x / w, y / w, z / w];
}

export interface SplineRead {
  readonly points: readonly Vec3[];
  readonly closed: boolean;
  /** True when the points are the exact points of the llull spline (extended data) or fit points; false for a sampled NURBS. */
  readonly exact: boolean;
}

function codePoints(record: DxfRecord, base: number): Vec3[] {
  const points: Array<[number, number, number]> = [];
  for (const [code, value] of record.codes) {
    if (code === base) points.push([Number(value), 0, 0]);
    const last = points[points.length - 1];
    if (last && code === base + 10) last[1] = Number(value);
    if (last && code === base + 20) last[2] = Number(value);
  }
  return points;
}

/**
 * The points a SPLINE becomes as a model spline: the `LLULL` points (exact), else its fit points, else its NURBS sampled.
 * @failure fewer than 2 points / inconsistent knots -> null
 */
export function readSpline(record: DxfRecord): SplineRead | null {
  const flags = codeNumber(record, 70, 0);
  const xdata = llullXdata(record);
  if (xdata?.tag === 'spline' && xdata.points.length >= 2) return { points: xdata.points, closed: xdata.ints[0] === 1, exact: true };
  const closed = (flags & 1) === 1;
  const fit = codePoints(record, 11);
  if (fit.length >= 2) return { points: fit, closed, exact: true };
  const degree = codeNumber(record, 71, 3);
  const knots = record.codes.filter(([code]) => code === 40).map(([, value]) => Number(value));
  const weights = record.codes.filter(([code]) => code === 41).map(([, value]) => Number(value));
  const controls = codePoints(record, 10);
  const valid =
    Number.isInteger(degree) &&
    degree >= 1 &&
    degree <= MAX_SPLINE_DEGREE &&
    controls.length > degree &&
    controls.length <= MAX_SPLINE_CONTROLS &&
    knots.length === controls.length + degree + 1;
  if (!valid || [...knots, ...weights].some((value) => !Number.isFinite(value))) return null;
  const [low, high] = [knots[degree] as number, knots[controls.length] as number];
  if (!(high > low)) return null;
  const spans = new Set(knots.slice(degree, controls.length + 1)).size - 1;
  const samples = Math.min(MAX_SPLINE_SAMPLES, Math.max(2, spans * SAMPLES_PER_SPAN));
  const points = Array.from({ length: samples + 1 }, (_, i) =>
    deBoor(degree, knots, controls, weights, low + ((high - low) * i) / samples),
  );
  return { points: closed ? points.slice(0, -1) : points, closed, exact: false };
}

export interface HatchRead {
  readonly loops: readonly Vec2[][];
  readonly solid: boolean;
  /** Pattern line angle (radians) and distance between lines, for `lines` / `cross`. */
  readonly angle: number;
  readonly spacing: number;
  readonly cross: boolean;
}

/** Points of an arc from `start` to `end` (radians) about (cx, cy), counter-clockwise or clockwise, first and last included. */
function arcEdge(cx: number, cy: number, radius: number, start: number, end: number, ccw: boolean): Vec2[] {
  const sweep = ccw ? positiveSweep(end - start) : -positiveSweep(start - end);
  const segments = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 24)));
  return Array.from({ length: segments + 1 }, (_, i): Vec2 => {
    const angle = start + (sweep * i) / segments;
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
  });
}

/** Interior points of the bulge arc from `a` to `b` (bulge = tan(sweep / 4), positive counter-clockwise). */
function bulgePoints(a: Vec2, b: Vec2, bulge: number): Vec2[] {
  const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (bulge === 0 || chord === 0 || !Number.isFinite(bulge)) return [];
  const sweep = 4 * Math.atan(bulge);
  const radius = chord / (2 * Math.sin(Math.abs(sweep) / 2));
  const sagitta = radius * Math.cos(sweep / 2);
  const side = bulge > 0 ? 1 : -1;
  const center: Vec2 = [
    (a[0] + b[0]) / 2 - (side * (b[1] - a[1]) * sagitta) / chord,
    (a[1] + b[1]) / 2 + (side * (b[0] - a[0]) * sagitta) / chord,
  ];
  const start = Math.atan2(a[1] - center[1], a[0] - center[0]);
  const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 24)));
  return Array.from({ length: steps - 1 }, (_, k): Vec2 => {
    const angle = start + (sweep * (k + 1)) / steps;
    return [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)];
  });
}

/** Forward-only reader over a record's codes. */
function cursor(record: DxfRecord): { next(code: number): number; peek(): number } {
  let at = 0;
  return {
    next(code) {
      while (at < record.codes.length && (record.codes[at] as readonly [number, string])[0] !== code) at += 1;
      return at < record.codes.length ? Number((record.codes[at++] as readonly [number, string])[1]) : Number.NaN;
    },
    peek: () => record.codes[at]?.[0] ?? -1,
  };
}

type Reader = ReturnType<typeof cursor>;

const MAX_HATCH_ITEMS = 100000;
/** Boundary paths of one HATCH at most (each can become an entity). */
const MAX_HATCH_PATHS = 5000;

/** Joints of an edge chain closer than this (relative to the loop's reach) are one point. */
const JOINT_TOLERANCE = 1e-9;

function polylinePath(read: Reader): Vec2[] | null {
  const bulged = read.next(72) === 1;
  read.next(73);
  const count = read.next(93);
  if (!(count >= 2 && count <= MAX_HATCH_ITEMS)) return null;
  const vertices: Array<{ at: Vec2; bulge: number }> = [];
  for (let i = 0; i < count; i++) {
    const at: Vec2 = [read.next(10), read.next(20)];
    vertices.push({ at, bulge: bulged && read.peek() === 42 ? read.next(42) : 0 });
  }
  return vertices.flatMap(({ at, bulge }, i) => [at, ...bulgePoints(at, (vertices[(i + 1) % count] as { at: Vec2 }).at, bulge)]);
}

function edgePath(read: Reader): Vec2[] | null {
  const edges = read.next(93);
  if (!(edges >= 1 && edges <= MAX_HATCH_ITEMS)) return null;
  const loop: Vec2[] = [];
  for (let i = 0; i < edges; i++) {
    const type = read.next(72);
    if (type === 1) {
      const [x1, y1, x2, y2] = [read.next(10), read.next(20), read.next(11), read.next(21)];
      loop.push([x1, y1], [x2, y2]);
    } else if (type === 2) {
      const [cx, cy, radius, start, end, ccw] = [read.next(10), read.next(20), read.next(40), read.next(50), read.next(51), read.next(73)];
      loop.push(...arcEdge(cx, cy, radius, toRadians(start), toRadians(end), ccw !== 0));
    } else return null;
  }
  return loop;
}

/** Loops of a HATCH without consecutive duplicate points (edge chains repeat their joints); null for spline / ellipse edges. */
function boundaryLoops(record: DxfRecord): Vec2[][] | null {
  const read = cursor(record);
  const paths = read.next(91);
  if (!(paths >= 1 && paths <= MAX_HATCH_PATHS)) return null;
  const loops: Vec2[][] = [];
  for (let i = 0; i < paths; i++) {
    const flag = read.next(92);
    const raw = (flag & 2) !== 0 ? polylinePath(read) : edgePath(read);
    if (raw === null || raw.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) return null;
    const reach = Math.max(1, ...raw.map(([x, y]) => Math.max(Math.abs(x), Math.abs(y))));
    const same = (p: Vec2, q: Vec2): boolean => Math.hypot(p[0] - q[0], p[1] - q[1]) <= JOINT_TOLERANCE * reach;
    const loop = raw.filter((p, index) => index === 0 || !same(p, raw[index - 1] as Vec2));
    if (loop.length > 1 && same(loop[0] as Vec2, loop[loop.length - 1] as Vec2)) loop.pop();
    if (loop.length < 3) return null;
    if (read.peek() === 97) read.next(97);
    loops.push(loop);
  }
  return loops;
}

/**
 * Boundary loops (OCS xy, as written) and fill of a HATCH. A user-defined pattern (76 = 0) is `52` angle at `41` spacing; a predefined one
 * takes its first pattern line (`53` + `52`, offset 45 / 46 scaled by `41`).
 * @failure no readable boundary (spline / ellipse edges, malformed counts) -> null
 */
export function readHatch(record: DxfRecord): HatchRead | null {
  const loops = boundaryLoops(record);
  if (loops === null) return null;
  const patternStart = record.codes.findIndex(([code]) => code === 75);
  const pattern: DxfRecord = { type: record.type, codes: patternStart < 0 ? [] : record.codes.slice(patternStart) };
  const baseAngle = toRadians(codeNumber(pattern, 52, 0));
  const scale = codeNumber(pattern, 41, 1);
  const lineAngles = pattern.codes.filter(([code]) => code === 53).map(([, value]) => toRadians(Number(value)));
  const solid = codeNumber(record, 70, 0) === 1;
  if (codeNumber(pattern, 76, 1) === 0 || lineAngles.length === 0) {
    return { loops, solid, angle: baseAngle, spacing: scale > 0 ? scale : 1, cross: codeNumber(pattern, 77, 0) === 1 };
  }
  const theta = lineAngles[0] as number;
  const offset = [codeNumber(pattern, 45, 0), codeNumber(pattern, 46, 0)] as const;
  const spacing = Math.abs(-offset[0] * Math.sin(theta) + offset[1] * Math.cos(theta)) * scale;
  const perpendicular = lineAngles.length === 2 && Math.abs(Math.cos((lineAngles[1] as number) - theta)) < 1e-9;
  return { loops, solid, angle: theta + baseAngle, spacing: spacing > 0 ? spacing : 1, cross: perpendicular };
}

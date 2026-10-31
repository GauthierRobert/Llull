/**
 * Not-to-scale layout of a line (plant 05 ISO §5.8, TR-ISO-10): every segment is drawn along its projected axis with a length that grows with the logarithm of the
 * 3D length, clamped so symbols and dimension text fit (`l = clamp(k ln(1 + L / L0), lmin, lmax)`, monotone in L). `k` is the largest that fits the drawing area
 * (bisection); crossings of non-adjacent segments are resolved by lengthening the later one, a bounded number of passes, and what remains is reported so the
 * renderer breaks the farther pipe. The numbers on the sheet come from the 3D model, never from these lengths. Pure, deterministic.
 */

import type { Vec2, Vec3 } from '@core/model/vectors';
import { add3, scale3 } from '@lib/vec3';
import type { IsoGraph, WalkStep } from './isoGraph';
import { depthOf, projectIso, type NorthArrow } from './isoProjection';

const L0 = 200;
export const MIN_DRAWN_MM = 9;
const MAX_DRAWN_MM = 110;
const MAX_K = 120;
const MAX_PASSES = 12;
const OVERFLOW_BELOW = 0.7;

export interface Crossing {
  readonly a: number;
  readonly b: number;
  readonly at: Vec2;
  /** The step drawn broken: the one farther from the viewer. */
  readonly farther: number;
}

export interface IsoLayout {
  /** Start and end of every step on the sheet (x right, y up), mm, after the uniform fit scale. */
  readonly starts: readonly Vec2[];
  readonly ends: readonly Vec2[];
  readonly nodes: ReadonlyMap<string, Vec2>;
  readonly bounds: readonly [number, number, number, number];
  readonly k: number;
  /** Uniform shrink applied to fit the area (1 = none). */
  readonly scale: number;
  /** The line is too large for the area even shrunk: it needs a sheet split. */
  readonly overflow: boolean;
  readonly passes: number;
  readonly crossings: readonly Crossing[];
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** Unit sheet direction of a step: axis classes along their axis, a slope along its horizontal axis, a skew at its projected angle. */
function sheetDirection(step: WalkStep, northArrow: NorthArrow): Vec2 {
  const dir = step.dir;
  const horizontalAxis: Vec3 = Math.abs(dir[0]) >= Math.abs(dir[1]) ? [Math.sign(dir[0]), 0, 0] : [0, Math.sign(dir[1]), 0];
  const snapped: Vec3 =
    step.axis === 'skew' ? dir : step.axis === 'slope' ? horizontalAxis : [Math.round(dir[0]), Math.round(dir[1]), Math.round(dir[2])];
  const [x, y] = projectIso(snapped, northArrow);
  const length = Math.hypot(x, y) || 1;
  return [x / length, y / length];
}

/** Intersection point of two segments (a crossing, or the midpoint of a collinear overlap), or null. */
function meet(p: Vec2, q: Vec2, r: Vec2, s: Vec2): Vec2 | null {
  const d1: Vec2 = [q[0] - p[0], q[1] - p[1]];
  const d2: Vec2 = [s[0] - r[0], s[1] - r[1]];
  const denominator = d1[0] * d2[1] - d1[1] * d2[0];
  const offset: Vec2 = [r[0] - p[0], r[1] - p[1]];
  const scaleOf = Math.hypot(...d1) * Math.hypot(...d2);
  if (Math.abs(denominator) <= 1e-9 * scaleOf) {
    if (Math.abs(offset[0] * d1[1] - offset[1] * d1[0]) > 1e-6 * Math.hypot(...d1)) return null;
    const length = Math.hypot(...d1);
    const unit: Vec2 = [d1[0] / length, d1[1] / length];
    const along = (point: Vec2): number => (point[0] - p[0]) * unit[0] + (point[1] - p[1]) * unit[1];
    const low = Math.max(0, Math.min(along(r), along(s)));
    const high = Math.min(length, Math.max(along(r), along(s)));
    return high - low > 0.5 ? [p[0] + unit[0] * ((low + high) / 2), p[1] + unit[1] * ((low + high) / 2)] : null;
  }
  const t = (offset[0] * d2[1] - offset[1] * d2[0]) / denominator;
  const u = (offset[0] * d1[1] - offset[1] * d1[0]) / denominator;
  const margin = 1e-6;
  return t > margin && t < 1 - margin && u > margin && u < 1 - margin ? [p[0] + d1[0] * t, p[1] + d1[1] * t] : null;
}

export function layoutIso(graph: IsoGraph, northArrow: NorthArrow, area: { readonly width: number; readonly height: number }): IsoLayout {
  const steps = graph.steps;
  const directions = steps.map((step) => sheetDirection(step, northArrow));
  const extra = steps.map(() => 0);
  const place = (k: number): { starts: Vec2[]; ends: Vec2[] } => {
    const starts: Vec2[] = [];
    const ends: Vec2[] = [];
    steps.forEach((step, index) => {
      const start: Vec2 = step.parent >= 0 ? (ends[step.parent] as Vec2) : [0, 0];
      const drawn = clamp(k * Math.log(1 + step.segment.lengthMm / L0), MIN_DRAWN_MM, MAX_DRAWN_MM) + (extra[index] as number);
      const direction = directions[index] as Vec2;
      starts.push(start);
      ends.push([start[0] + direction[0] * drawn, start[1] + direction[1] * drawn]);
    });
    return { starts, ends };
  };
  const extent = (points: readonly Vec2[]): [number, number, number, number] => {
    const xs = points.map((point) => point[0]);
    const ys = points.map((point) => point[1]);
    return xs.length === 0 ? [0, 0, 0, 0] : [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  };
  const fits = (k: number): boolean => {
    const placed = place(k);
    const [x0, y0, x1, y1] = extent([...placed.starts, ...placed.ends]);
    return x1 - x0 <= area.width && y1 - y0 <= area.height;
  };
  let low = 0;
  let high = MAX_K;
  if (fits(high)) low = high;
  else
    for (let pass = 0; pass < 30; pass++) {
      const middle = (low + high) / 2;
      if (fits(middle)) low = middle;
      else high = middle;
    }
  const k = low;
  let placed = place(k);
  const sharesNode = (a: WalkStep, b: WalkStep): boolean =>
    a.entryKey === b.entryKey || a.entryKey === b.exitKey || a.exitKey === b.entryKey || a.exitKey === b.exitKey;
  const findCrossings = (): Crossing[] => {
    const found: Crossing[] = [];
    for (let i = 0; i < steps.length; i++)
      for (let j = i + 1; j < steps.length; j++) {
        const [a, b] = [steps[i] as WalkStep, steps[j] as WalkStep];
        if (sharesNode(a, b)) continue;
        const [p, q, r, s] = [placed.starts[i] as Vec2, placed.ends[i] as Vec2, placed.starts[j] as Vec2, placed.ends[j] as Vec2];
        if (Math.max(p[0], q[0]) < Math.min(r[0], s[0]) - 1e-9 || Math.max(r[0], s[0]) < Math.min(p[0], q[0]) - 1e-9) continue;
        if (Math.max(p[1], q[1]) < Math.min(r[1], s[1]) - 1e-9 || Math.max(r[1], s[1]) < Math.min(p[1], q[1]) - 1e-9) continue;
        const at = meet(p, q, r, s);
        if (at === null) continue;
        const middle = (step: WalkStep): Vec3 =>
          add3(step.start, scale3([step.end[0] - step.start[0], step.end[1] - step.start[1], step.end[2] - step.start[2]], 0.5));
        found.push({ a: i, b: j, at, farther: depthOf(middle(a), northArrow) <= depthOf(middle(b), northArrow) ? i : j });
      }
    return found;
  };
  let crossings = findCrossings();
  let passes = 0;
  while (crossings.length > 0 && passes < MAX_PASSES) {
    const first = crossings[0] as Crossing;
    extra[first.b] = (extra[first.b] as number) + MIN_DRAWN_MM;
    placed = place(k);
    crossings = findCrossings();
    passes += 1;
  }
  const [x0, y0, x1, y1] = extent([...placed.starts, ...placed.ends]);
  const width = x1 - x0;
  const height = y1 - y0;
  const shrink = Math.min(1, width > 0 ? area.width / width : 1, height > 0 ? area.height / height : 1);
  const move = (point: Vec2): Vec2 => [(point[0] - x0) * shrink, (point[1] - y0) * shrink];
  const starts = placed.starts.map(move);
  const ends = placed.ends.map(move);
  const nodes = new Map<string, Vec2>();
  steps.forEach((step, index) => {
    nodes.set(step.entryKey, starts[index] as Vec2);
    nodes.set(step.exitKey, ends[index] as Vec2);
  });
  return {
    starts,
    ends,
    nodes,
    bounds: [0, 0, width * shrink, height * shrink],
    k,
    scale: shrink,
    overflow: shrink < OVERFLOW_BELOW,
    passes,
    crossings: crossings.map((crossing) => ({ ...crossing, at: move(crossing.at) })),
  };
}

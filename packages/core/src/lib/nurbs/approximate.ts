/**
 * Least-squares curve approximation (Piegl & Tiller §9.4.1, eqs 9.63 and 9.68 - 9.69): a clamped B-spline with the fewest poles that stays within a
 * tolerance of ordered points, end points interpolated. The normal equations of the interior poles are banded (width degree) and solved with
 * `solveBanded`.
 */

import type { Vec3 } from '../../model/vectors';
import { distance3 } from '../vec3';
import { basisFunctions, findSpan } from './basis';
import { solveBanded, type SparseRow } from './bandSolve';
import { closestOnCurve } from './closest';
import { evaluateCurve } from './evaluate';
import { compressKnots } from './knotVector';
import type { NurbsCurveData } from './types';

const FOOT_POINT_LIMIT = 2000;

export interface ApproximationOptions {
  readonly tolerance: number;
  readonly degreeMin: number;
  readonly degreeMax: number;
  /** Largest pole count tried. */
  readonly maxPoles: number;
}

export interface Approximation {
  readonly curve: NurbsCurveData;
  /** Largest distance from a point to the curve (foot-point projection). */
  readonly maxDeviation: number;
  /** Largest distance from a point to the curve at its own parameter (an upper bound of `maxDeviation`). */
  readonly parametricDeviation: number;
  readonly rmsDeviation: number;
}

/** Chord-length parameters 0..1; null when all points coincide. */
function chordParameters(points: ReadonlyArray<Vec3>): number[] | null {
  const steps = points.slice(1).map((point, index) => distance3(point, points[index] as Vec3));
  const total = steps.reduce((sum, step) => sum + step, 0);
  if (!(total > 0)) return null;
  const t = [0];
  for (const step of steps) t.push((t[t.length - 1] as number) + step / total);
  t[t.length - 1] = 1;
  return t;
}

/** Knot vector for `poleCount` poles distributing the data parameters (eqs 9.68 - 9.69). */
function distributedKnots(t: ReadonlyArray<number>, degree: number, poleCount: number): number[] {
  const interior: number[] = [];
  const step = t.length / (poleCount - degree);
  for (let j = 1; j <= poleCount - degree - 1; j++) {
    const position = j * step;
    const i = Math.floor(position);
    const alpha = position - i;
    interior.push((1 - alpha) * (t[i - 1] as number) + alpha * (t[i] as number));
  }
  return [...new Array<number>(degree + 1).fill(0), ...interior, ...new Array<number>(degree + 1).fill(1)];
}

/** Least-squares poles for `poleCount` poles, or null when the normal equations are singular. */
function fitPoles(points: ReadonlyArray<Vec3>, t: ReadonlyArray<number>, degree: number, poleCount: number): NurbsCurveData | null {
  const full = distributedKnots(t, degree, poleCount);
  const last = poleCount - 1;
  const first = points[0] as Vec3;
  const end = points[points.length - 1] as Vec3;
  const rows: Array<Map<number, number>> = Array.from({ length: Math.max(0, poleCount - 2) }, () => new Map<number, number>());
  const rhs: number[][] = Array.from({ length: Math.max(0, poleCount - 2) }, () => [0, 0, 0]);
  for (let k = 1; k < points.length - 1; k++) {
    const u = t[k] as number;
    const span = findSpan(poleCount, degree, u, full);
    const basis = basisFunctions(span, u, degree, full);
    const point = points[k] as Vec3;
    const n0 = span - degree === 0 ? (basis[0] as number) : 0;
    const nLast = span === last ? (basis[degree] as number) : 0;
    const residual = [0, 1, 2].map((axis) => (point[axis] as number) - n0 * (first[axis] as number) - nLast * (end[axis] as number));
    for (let a = 0; a <= degree; a++) {
      const column = span - degree + a;
      if (column < 1 || column > last - 1) continue;
      const row = rows[column - 1] as Map<number, number>;
      const target = rhs[column - 1] as number[];
      for (let b = 0; b <= degree; b++) {
        const other = span - degree + b;
        if (other < 1 || other > last - 1) continue;
        row.set(other - 1, (row.get(other - 1) ?? 0) + (basis[a] as number) * (basis[b] as number));
      }
      for (let axis = 0; axis < 3; axis++) target[axis] = (target[axis] as number) + (basis[a] as number) * (residual[axis] as number);
    }
  }
  const sparse: SparseRow[] = rows.map((row) => [...row.entries()]);
  const interior = poleCount > 2 ? solveBanded(sparse, rhs) : [];
  if (interior === null) return null;
  const poles: Vec3[] = [first, ...interior.map((row) => [row[0] as number, row[1] as number, row[2] as number] as const), end];
  const { knots, multiplicities } = compressKnots(full);
  return { degree, poles, knots, multiplicities };
}

/** Distance statistics of `curve` against the ordered `points` sampled at `t`. */
function deviations(curve: NurbsCurveData, points: ReadonlyArray<Vec3>, t: ReadonlyArray<number>): { parametric: number; rms: number } {
  const gaps = points.map((point, k) => distance3(evaluateCurve(curve, t[k] as number), point));
  return { parametric: Math.max(...gaps), rms: Math.sqrt(gaps.reduce((sum, gap) => sum + gap * gap, 0) / gaps.length) };
}

/**
 * The approximation with the fewest poles (lowest degree on ties) whose parametric deviation is within `tolerance`.
 * @failure null when no degree in range reaches the tolerance with at most `maxPoles` poles, or all points coincide
 */
export function approximatePoints(points: ReadonlyArray<Vec3>, options: ApproximationOptions): Approximation | null {
  const t = chordParameters(points);
  if (t === null) return null;
  let best: { curve: NurbsCurveData; parametric: number; rms: number } | null = null;
  for (let degree = options.degreeMin; degree <= options.degreeMax; degree++) {
    const limit = Math.min(options.maxPoles, points.length);
    if (limit < degree + 1) continue;
    const reached = (poleCount: number): { curve: NurbsCurveData; parametric: number; rms: number } | null => {
      const curve = fitPoles(points, t, degree, poleCount);
      if (curve === null) return null;
      const { parametric, rms } = deviations(curve, points, t);
      return parametric <= options.tolerance ? { curve, parametric, rms } : null;
    };
    // pole counts are searched by doubling, then bisected: the error is (almost) monotone in the pole count
    let low = degree + 1;
    let found = reached(low);
    let high = low;
    while (found === null && high < limit) {
      low = high + 1;
      high = Math.min(limit, high * 2);
      found = reached(high);
    }
    if (found === null) continue;
    let bestHere = { poleCount: high, ...found };
    for (let lo = low, hi = high; lo < hi; ) {
      const mid = (lo + hi) >> 1;
      const attempt = reached(mid);
      if (attempt !== null) {
        bestHere = { poleCount: mid, ...attempt };
        hi = mid;
      } else lo = mid + 1;
    }
    if (best === null || bestHere.curve.poles.length < best.curve.poles.length) best = bestHere;
  }
  if (best === null) return null;
  // foot-point projection is exact but costs a sweep of the curve per point: beyond FOOT_POINT_LIMIT the parametric bound stands in
  const distances = points.length > FOOT_POINT_LIMIT ? null : points.map((point) => closestOnCurve(best.curve, point).distance);
  return {
    curve: best.curve,
    maxDeviation: distances === null ? best.parametric : Math.max(...distances),
    parametricDeviation: best.parametric,
    rmsDeviation: distances === null ? best.rms : Math.sqrt(distances.reduce((sum, value) => sum + value * value, 0) / distances.length),
  };
}

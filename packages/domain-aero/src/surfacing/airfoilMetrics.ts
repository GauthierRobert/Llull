/** Section metrics of a planar airfoil curve (upper trailing edge -> leading edge -> lower trailing edge), chord-normalised. */

import type { NurbsCurveData } from '@lib/nurbs/types';
import { curveDerivatives, curveDomain, evaluateCurve } from '@lib/nurbs/evaluate';
import { curvatureAt } from '@lib/nurbs/curvature';
import { integrateCurve } from '@lib/nurbs/integrate';

export interface AirfoilMetrics {
  readonly chord: number;
  /** Leading-edge point (minimum x) in the curve's own coordinates, before chord normalisation. */
  readonly leadingEdge: readonly [number, number];
  readonly tMax: number;
  readonly xTMax: number;
  /** Signed: positive when the mean line lies above the chord line. */
  readonly camberMax: number;
  readonly xCamberMax: number;
  readonly leRadius: number;
  readonly teThickness: number;
  readonly teAngleDeg: number;
  readonly area: number;
  readonly centroid: readonly [number, number];
}

const GOLDEN = (Math.sqrt(5) - 1) / 2;

/** Argument of the minimum of `f` on [a, b] by golden-section search. */
function minimize(f: (t: number) => number, a: number, b: number): number {
  let [lo, hi] = [a, b];
  let [x1, x2] = [hi - GOLDEN * (hi - lo), lo + GOLDEN * (hi - lo)];
  let [f1, f2] = [f(x1), f(x2)];
  for (let i = 0; i < 80; i++) {
    if (f1 < f2) {
      hi = x2;
      [x2, f2] = [x1, f1];
      x1 = hi - GOLDEN * (hi - lo);
      f1 = f(x1);
    } else {
      lo = x1;
      [x1, f1] = [x2, f2];
      x2 = lo + GOLDEN * (hi - lo);
      f2 = f(x2);
    }
  }
  return (lo + hi) / 2;
}

/** Parameter of the leading edge (minimum x) of an airfoil curve. */
function leadingEdgeParameter(curve: NurbsCurveData): number {
  const [first, last] = curveDomain(curve);
  const count = 2000;
  let best = 0;
  for (let i = 1; i <= count; i++)
    if (evaluateCurve(curve, first + ((last - first) * i) / count)[0] < evaluateCurve(curve, first + ((last - first) * best) / count)[0])
      best = i;
  const step = (last - first) / count;
  return minimize((u) => evaluateCurve(curve, u)[0], Math.max(first, first + step * (best - 1)), Math.min(last, first + step * (best + 1)));
}

/** Height of one surface at chordwise coordinate `x`, by bisection on the monotone x(u) over [from, to]. */
function surfaceHeight(curve: NurbsCurveData, from: number, to: number, x: number): number {
  const increasing = evaluateCurve(curve, to)[0] > evaluateCurve(curve, from)[0];
  let [lo, hi] = [from, to];
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const below = evaluateCurve(curve, mid)[0] < x;
    if (below === increasing) lo = mid;
    else hi = mid;
  }
  return evaluateCurve(curve, (lo + hi) / 2)[1];
}

/**
 * Metrics of `curve`, all lengths divided by the chord (leading edge to trailing-edge midpoint along x).
 * @failure leading edge at a curve end (not an airfoil section) or zero chord -> string reason
 */
export function airfoilMetrics(curve: NurbsCurveData): AirfoilMetrics | string {
  const [first, last] = curveDomain(curve);
  const uLe = leadingEdgeParameter(curve);
  if (!(uLe > first + 1e-6 * (last - first) && uLe < last - 1e-6 * (last - first)))
    return 'the leading edge (minimum x) must be inside the curve: the curve must run trailing edge -> leading edge -> trailing edge';
  const start = evaluateCurve(curve, first);
  const end = evaluateCurve(curve, last);
  const le = evaluateCurve(curve, uLe);
  const chord = (start[0] + end[0]) / 2 - le[0];
  if (!(chord > 0)) return 'the section has no chord (trailing edge is not behind the leading edge)';
  const xEnd = Math.min(start[0], end[0]);
  const fractionAt = (index: number, count: number): number => ((1 - Math.cos((Math.PI * index) / count)) / 2) * ((xEnd - le[0]) / chord);
  const heights = (fraction: number): { thickness: number; camber: number } => {
    const x = le[0] + fraction * chord;
    const upper = surfaceHeight(curve, first, uLe, x);
    const lower = surfaceHeight(curve, uLe, last, x);
    return { thickness: upper - lower, camber: (upper + lower) / 2 };
  };
  const scan = 400;
  let [bestT, bestC] = [0, 0];
  let [thickest, mostCambered] = [-Infinity, -Infinity];
  for (let i = 1; i < scan; i++) {
    const { thickness, camber } = heights(fractionAt(i, scan));
    if (thickness > thickest) [thickest, bestT] = [thickness, i];
    if (Math.abs(camber) > mostCambered) [mostCambered, bestC] = [Math.abs(camber), i];
  }
  const refine = (index: number, value: (fraction: number) => number, sign: 1 | -1): number => {
    const lo = fractionAt(Math.max(index - 1, 1), scan);
    const hi = fractionAt(Math.min(index + 1, scan - 1), scan);
    return minimize((f) => -sign * value(f), lo, hi);
  };
  const fT = refine(bestT, (f) => heights(f).thickness, 1);
  const camberSign = heights(fractionAt(bestC, scan)).camber >= 0 ? 1 : -1;
  const fC = refine(bestC, (f) => heights(f).camber * camberSign, 1);
  const leSample = curvatureAt(curve, uLe, null);
  const upperToLe = curveDerivatives(curve, first, 1)[1] as readonly number[];
  const lowerFromTe = curveDerivatives(curve, last, 1)[1] as readonly number[];
  const [ux, uy, lx, ly] = [upperToLe[0] as number, upperToLe[1] as number, -(lowerFromTe[0] as number), -(lowerFromTe[1] as number)];
  const cosTe = (ux * lx + uy * ly) / (Math.hypot(ux, uy) * Math.hypot(lx, ly));
  const [dx, dy] = [start[0] - end[0], start[1] - end[1]];
  const areaSigned =
    (integrateCurve(curve, first, last, (p, d) => p[0] * d[1] - p[1] * d[0]) + (end[0] * start[1] - start[0] * end[1])) / 2;
  const momentX = (integrateCurve(curve, first, last, (p, d) => p[0] * p[0] * d[1]) + dy * (end[0] ** 2 + end[0] * dx + (dx * dx) / 3)) / 2;
  const momentY =
    -(integrateCurve(curve, first, last, (p, d) => p[1] * p[1] * d[0]) + dx * (end[1] ** 2 + end[1] * dy + (dy * dy) / 3)) / 2;
  return {
    chord,
    leadingEdge: [le[0], le[1]],
    tMax: heights(fT).thickness / chord,
    xTMax: fT,
    camberMax: heights(fC).camber / chord,
    xCamberMax: fC,
    leRadius: leSample.curvature > 0 ? 1 / leSample.curvature / chord : Number.POSITIVE_INFINITY,
    teThickness: Math.hypot(dx, dy) / chord,
    teAngleDeg: (Math.acos(Math.max(-1, Math.min(1, cosTe))) * 180) / Math.PI,
    area: Math.abs(areaSigned) / (chord * chord),
    centroid: [(momentX / areaSigned - le[0]) / chord, (momentY / areaSigned - le[1]) / chord],
  };
}

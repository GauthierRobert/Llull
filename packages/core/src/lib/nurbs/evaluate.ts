/** Point and derivative evaluation of a NURBS curve (rational quotient rule, Piegl & Tiller A3.1 / A4.2). */

import type { Vec3 } from '../../model/vectors';
import { basisDerivatives, findSpan } from './basis';
import { expandKnots } from './knotVector';
import type { NurbsCurveData } from './types';

const toVec3 = (row: ReadonlyArray<number>): Vec3 => [row[0] as number, row[1] as number, row[2] as number];

const fullKnotCache = new WeakMap<NurbsCurveData, number[]>();

/** Full knot vector of `curve`, memoised per curve object (curves are immutable). */
const fullKnots = (curve: NurbsCurveData): number[] => {
  const cached = fullKnotCache.get(curve);
  if (cached !== undefined) return cached;
  const full = expandKnots(curve.knots, curve.multiplicities);
  fullKnotCache.set(curve, full);
  return full;
};

/** Parameter interval [first, last] of the curve. */
export function curveDomain(curve: NurbsCurveData): readonly [number, number] {
  return [curve.knots[0] as number, curve.knots[curve.knots.length - 1] as number];
}

/** Poles with the weight as a 4th component (homogeneous form); weight 1 when the curve is not rational. */
export function homogeneousPoles(curve: NurbsCurveData): number[][] {
  return curve.poles.map((pole, index) => {
    const weight = curve.weights?.[index] ?? 1;
    return [pole[0] * weight, pole[1] * weight, pole[2] * weight, weight];
  });
}

/** Evaluates `curve` and its derivatives up to `order` at `u` (clamped to the domain): `[C, C', C'', ...]`. */
export function curveDerivatives(curve: NurbsCurveData, u: number, order: number): Vec3[] {
  const [first, last] = curveDomain(curve);
  const t = Math.min(last, Math.max(first, u));
  const full = fullKnots(curve);
  const { degree } = curve;
  const span = findSpan(curve.poles.length, degree, t, full);
  const basis = basisDerivatives(span, t, degree, order, full);
  const poles = curve.weights === undefined ? null : homogeneousPoles(curve);
  const raw: number[][] = [];
  for (let k = 0; k <= order; k++) {
    const sum = [0, 0, 0, 0];
    for (let j = 0; j <= degree; j++) {
      const factor = (basis[k] as number[])[j] as number;
      const index = span - degree + j;
      if (poles === null) {
        const pole = curve.poles[index] as Vec3;
        for (let c = 0; c < 3; c++) sum[c] = (sum[c] as number) + factor * (pole[c] as number);
        sum[3] = (sum[3] as number) + factor;
      } else {
        const pole = poles[index] as number[];
        for (let c = 0; c < 4; c++) sum[c] = (sum[c] as number) + factor * (pole[c] as number);
      }
    }
    raw.push(sum);
  }
  if (poles === null) return raw.map(toVec3);
  const w0 = (raw[0] as number[])[3] as number;
  const derivatives: number[][] = [];
  for (let k = 0; k <= order; k++) {
    const value = [(raw[k] as number[])[0] as number, (raw[k] as number[])[1] as number, (raw[k] as number[])[2] as number];
    let binomial = 1;
    for (let i = 1; i <= k; i++) {
      binomial = (binomial * (k - i + 1)) / i;
      const wi = (raw[i] as number[])[3] as number;
      const previous = derivatives[k - i] as number[];
      for (let c = 0; c < 3; c++) value[c] = (value[c] as number) - binomial * wi * (previous[c] as number);
    }
    derivatives.push(value.map((component) => component / w0));
  }
  return derivatives.map(toVec3);
}

/** Point on the curve at `u`. */
export function evaluateCurve(curve: NurbsCurveData, u: number): Vec3 {
  return curveDerivatives(curve, u, 0)[0] as Vec3;
}

/** `count` (>= 2) points at equal parameter steps from the first to the last knot. */
export function sampleCurve(curve: NurbsCurveData, count: number): Vec3[] {
  const [first, last] = curveDomain(curve);
  return Array.from({ length: count }, (_, index) => evaluateCurve(curve, first + ((last - first) * index) / (count - 1)));
}

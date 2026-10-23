/** Cutting curves at parameters or arc-length fractions (loft coupling): sub-curves are exact, corners are the knots where the tangent jumps. */

import type { Vec3 } from '../../model/vectors';
import { dot3, len3 } from '../vec3';
import { curveLength } from './curvature';
import { curveDerivatives, curveDomain } from './evaluate';
import { extractSubSurface } from './surfaceEdit';
import type { NurbsCurveData } from './types';

/** The part of `curve` between the parameters `from` < `to` as its own curve (exact: knot insertion and slicing). */
function subCurve(curve: NurbsCurveData, from: number, to: number): NurbsCurveData | string {
  const strip = extractSubSurface(
    {
      degreeU: curve.degree,
      degreeV: 1,
      poles: curve.poles.map((pole) => [pole, pole]),
      ...(curve.weights === undefined ? {} : { weights: curve.weights.map((weight) => [weight, weight]) }),
      knotsU: curve.knots,
      multiplicitiesU: curve.multiplicities,
      knotsV: [0, 1],
      multiplicitiesV: [2, 2],
    },
    [from, to],
    [0, 1],
  );
  if (typeof strip === 'string') return strip;
  return {
    degree: strip.degreeU,
    poles: strip.poles.map((row) => row[0] as Vec3),
    ...(strip.weights === undefined ? {} : { weights: strip.weights.map((row) => row[0] as number) }),
    knots: strip.knotsU,
    multiplicities: strip.multiplicitiesU,
  };
}

/** The pieces of `curve` between consecutive cut parameters (ascending, inside the domain; the domain ends are added). */
export function splitCurve(curve: NurbsCurveData, cuts: readonly number[]): NurbsCurveData[] | string {
  const [first, last] = curveDomain(curve);
  const edges = [first, ...cuts.filter((cut) => cut > first + 1e-12 * (last - first) && cut < last - 1e-12 * (last - first)), last];
  const pieces: NurbsCurveData[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const piece = subCurve(curve, edges[i] as number, edges[i + 1] as number);
    if (typeof piece === 'string') return piece;
    pieces.push(piece);
  }
  return pieces;
}

/** Parameter at which `curve` has covered the fraction `f` (0..1) of its length. */
export function parameterAtLengthFraction(curve: NurbsCurveData, f: number): number {
  const [first, last] = curveDomain(curve);
  if (f <= 0) return first;
  if (f >= 1) return last;
  const target = f * curveLength(curve, first, last);
  let [lo, hi] = [first, last];
  for (let step = 0; step < 60; step++) {
    const mid = (lo + hi) / 2;
    if (curveLength(curve, first, mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Arc-length fractions (0..1, ascending, ends excluded) of the interior knots where the tangent direction jumps by more than `angle` radians. */
export function cornerFractions(curve: NurbsCurveData, angle = 1e-3): number[] {
  const [first, last] = curveDomain(curve);
  const total = curveLength(curve, first, last);
  const fractions: number[] = [];
  const nudge = 1e-9 * (last - first);
  for (const knot of curve.knots.slice(1, -1)) {
    const before = curveDerivatives(curve, knot - nudge, 1)[1] as Vec3;
    const after = curveDerivatives(curve, knot + nudge, 1)[1] as Vec3;
    const cosine = dot3(before, after) / Math.max(len3(before) * len3(after), 1e-300);
    if (Math.acos(Math.min(1, Math.max(-1, cosine))) > angle) fractions.push(curveLength(curve, first, knot) / total);
  }
  return fractions;
}

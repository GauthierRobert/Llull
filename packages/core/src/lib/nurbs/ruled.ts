/**
 * Ruled surfaces between two curves (SWG M6): the two curves are made compatible and become the two pole rows of a patch of degree 1 across.
 * Pairing is by curve parameter, or by arc length (both curves refitted at equal arc-length fractions, deviation reported).
 */

import type { Vec3 } from '../../model/vectors';
import { dot3, len3, normalize3, sub3, cross3 } from '../vec3';
import { arcLengthSamples } from './arcSample';
import { closestOnCurve } from './closest';
import { interpolatePoints } from './interpolate';
import { compatibleCurves } from './surfaceFit';
import { surfaceDerivatives, surfaceDomain } from './surface';
import { surfaceSample } from './surfaceCurvature';
import type { NurbsSurfaceData } from './surfaceTypes';
import type { NurbsCurveData } from './types';

const liftWeights = (curve: NurbsCurveData): NurbsCurveData => ({ ...curve, weights: curve.poles.map(() => 1) });

/**
 * The patch whose v = 0 / v = 1 isolines are `a` and `b` (made compatible: common degree and knots, shapes unchanged).
 * @failure incompatible curves -> string reason
 */
export function ruledPatch(a: NurbsCurveData, b: NurbsCurveData): NurbsSurfaceData | string {
  const rational = a.weights !== undefined || b.weights !== undefined;
  const pair = compatibleCurves(rational ? [a, b].map((c) => (c.weights === undefined ? liftWeights(c) : c)) : [a, b]);
  if (typeof pair === 'string') return pair;
  const [first, second] = pair as [NurbsCurveData, NurbsCurveData];
  return {
    degreeU: first.degree,
    degreeV: 1,
    poles: first.poles.map((pole, i) => [pole, second.poles[i] as Vec3]),
    ...(first.weights === undefined
      ? {}
      : { weights: first.weights.map((w, i) => [w, (second.weights as ReadonlyArray<number>)[i] as number]) }),
    knotsU: first.knots,
    multiplicitiesU: first.multiplicities,
    knotsV: [0, 1],
    multiplicitiesV: [2, 2],
  };
}

/** Station counts tried in turn when refitting a curve by arc length. */
const ARC_LENGTH_LADDER = [32, 64, 128, 256];

/** `curve` refitted through `count + 1` equal arc-length points (cubic, uniform parameters), and its largest distance from the original at the midpoints. */
export function arcLengthFit(curve: NurbsCurveData, count: number): { fit: NurbsCurveData; deviation: number } | string {
  const { points } = arcLengthSamples(curve, count);
  const fitted = interpolatePoints(points, { degree: 3, parameterization: 'uniform' });
  if ('code' in fitted) return fitted.message;
  const middles = arcLengthSamples(curve, 2 * count).points.filter((_, k) => k % 2 === 1);
  const deviation = Math.max(...middles.map((p) => closestOnCurve(fitted.curve, p).distance));
  return { fit: fitted.curve, deviation };
}

/**
 * Both curves refitted at equal arc-length fractions so the ruling at parameter u joins the points at the same fraction of each length.
 * @failure a degenerate curve (zero length) -> reason; tolerance not reached with 256 stations -> code SWG_FIT_TOLERANCE
 */
export function arcLengthPair(
  a: NurbsCurveData,
  b: NurbsCurveData,
  tolerance: number,
): { a: NurbsCurveData; b: NurbsCurveData; deviation: number } | { code: 'SWG_FIT_TOLERANCE' | 'SWG_RULED_CURVES'; message: string } {
  let last = Number.POSITIVE_INFINITY;
  for (const count of ARC_LENGTH_LADDER) {
    const [fa, fb] = [arcLengthFit(a, count), arcLengthFit(b, count)];
    if (typeof fa === 'string' || typeof fb === 'string')
      return { code: 'SWG_RULED_CURVES', message: `arc-length refit failed: ${typeof fa === 'string' ? fa : fb}` };
    last = Math.max(fa.deviation, fb.deviation);
    if (last <= tolerance) return { a: fa.fit, b: fb.fit, deviation: last };
  }
  return {
    code: 'SWG_FIT_TOLERANCE',
    message: `the arc-length refit deviates ${last.toExponential(2)} (limit ${tolerance.toExponential(2)}) with ${ARC_LENGTH_LADDER[ARC_LENGTH_LADDER.length - 1]} stations`,
  };
}

const GAUSS: ReadonlyArray<readonly [number, number]> = [
  [-0.906179845938664, 0.2369268850561891],
  [-0.5384693101056831, 0.4786286704993665],
  [0, 0.5688888888888889],
  [0.5384693101056831, 0.4786286704993665],
  [0.906179845938664, 0.2369268850561891],
];

/** Pieces each knot span is split into per direction before the 5-point rule. */
const AREA_PIECES = 4;

/** Surface area: composite Gauss-Legendre of |S_u x S_v| over every knot span (split into 4 pieces per direction). */
export function surfaceArea(surface: NurbsSurfaceData): number {
  const breaks = (knots: ReadonlyArray<number>): Array<readonly [number, number]> =>
    knots.slice(1).flatMap((hi, k) =>
      Array.from({ length: AREA_PIECES }, (_, piece): readonly [number, number] => {
        const lo = knots[k] as number;
        return [lo + ((hi - lo) * piece) / AREA_PIECES, lo + ((hi - lo) * (piece + 1)) / AREA_PIECES];
      }),
    );
  let total = 0;
  for (const [u0, u1] of breaks(surface.knotsU))
    for (const [v0, v1] of breaks(surface.knotsV))
      for (const [xu, wu] of GAUSS)
        for (const [xv, wv] of GAUSS) {
          const u = (u0 + u1) / 2 + ((u1 - u0) / 2) * xu;
          const v = (v0 + v1) / 2 + ((v1 - v0) / 2) * xv;
          const d = surfaceDerivatives(surface, u, v, 1);
          const [su, sv] = [(d[1] as Vec3[])[0] as Vec3, (d[0] as Vec3[])[1] as Vec3];
          total += wu * wv * ((u1 - u0) / 2) * ((v1 - v0) / 2) * len3(cross3(su, sv));
        }
  return total;
}

/** Largest |Gaussian curvature| over an interior `samples` x `samples` grid (degenerate points skipped). */
export function maxAbsGaussian(surface: NurbsSurfaceData, samples = 25): number {
  const [[u0, u1], [v0, v1]] = surfaceDomain(surface);
  let worst = 0;
  for (let i = 0; i < samples; i++)
    for (let j = 0; j < samples; j++) {
      const sample = surfaceSample(surface, u0 + ((u1 - u0) * (i + 0.5)) / samples, v0 + ((v1 - v0) * (j + 0.5)) / samples);
      if (!sample.degenerate) worst = Math.max(worst, Math.abs(sample.gaussian));
    }
  return worst;
}

/** Diagonal of the bounding box of the poles (the size of the sheet, document units). */
export function sheetDiagonal(surface: NurbsSurfaceData): number {
  const poles = surface.poles.flat();
  const extent = [0, 1, 2].map((axis) => {
    const values = poles.map((pole) => pole[axis] as number);
    return Math.max(...values) - Math.min(...values);
  });
  return Math.hypot(...extent);
}

/** Largest angle (radians) between the rulings at neighbouring samples along u: how much the rulings twist from one to the next. */
export function rulingTwistMax(surface: NurbsSurfaceData, samples = 64): number {
  const [[u0, u1], [v0, v1]] = surfaceDomain(surface);
  const ruling = (u: number): Vec3 => {
    const a = (surfaceDerivatives(surface, u, v0, 0)[0] as Vec3[])[0] as Vec3;
    const b = (surfaceDerivatives(surface, u, v1, 0)[0] as Vec3[])[0] as Vec3;
    return normalize3(sub3(b, a));
  };
  let worst = 0;
  let previous = ruling(u0);
  for (let k = 1; k <= samples; k++) {
    const next = ruling(u0 + ((u1 - u0) * k) / samples);
    worst = Math.max(worst, Math.acos(Math.min(1, Math.max(-1, dot3(previous, next)))));
    previous = next;
  }
  return worst;
}

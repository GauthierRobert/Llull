/** Numerical integration along a NURBS curve: composite Gauss-Legendre split at every knot (exact for the polynomial pieces it resolves). */

import type { Vec3 } from '../../model/vectors';
import { curveDerivatives, curveDomain } from './evaluate';
import type { NurbsCurveData } from './types';

const GAUSS_NODES: ReadonlyArray<readonly [number, number]> = [
  [-0.906179845938664, 0.2369268850561891],
  [-0.5384693101056831, 0.4786286704993665],
  [0, 0.5688888888888889],
  [0.5384693101056831, 0.4786286704993665],
  [0.906179845938664, 0.2369268850561891],
];

/** Pieces each knot span is split into before the 5-point rule is applied. */
const PIECES_PER_SPAN = 6;

/**
 * Integral of `integrand(point, derivative)` over the curve parameter between `from` and `to` (clamped to the domain; the sign follows the
 * direction of the bounds).
 */
export function integrateCurve(
  curve: NurbsCurveData,
  from: number,
  to: number,
  integrand: (point: Vec3, derivative: Vec3) => number,
): number {
  const [first, last] = curveDomain(curve);
  const a = Math.max(first, Math.min(from, to));
  const b = Math.min(last, Math.max(from, to));
  const breaks = [a, ...curve.knots.filter((knot) => knot > a && knot < b), b];
  let total = 0;
  for (let i = 0; i + 1 < breaks.length; i++) {
    const lo = breaks[i] as number;
    const hi = breaks[i + 1] as number;
    for (let piece = 0; piece < PIECES_PER_SPAN; piece++) {
      const start = lo + ((hi - lo) * piece) / PIECES_PER_SPAN;
      const end = lo + ((hi - lo) * (piece + 1)) / PIECES_PER_SPAN;
      const half = (end - start) / 2;
      const middle = (end + start) / 2;
      for (const [node, weight] of GAUSS_NODES) {
        const [point, derivative] = curveDerivatives(curve, middle + half * node, 1) as [Vec3, Vec3];
        total += weight * half * integrand(point, derivative);
      }
    }
  }
  return from <= to ? total : -total;
}

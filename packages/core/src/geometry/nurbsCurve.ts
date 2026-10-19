/** Entity-aware helpers of NURBS curves: display polyline, local bounds, uniform scaling. */

import type { Vec3 } from '../model/vectors';
import { curveDerivatives } from '../lib/nurbs/evaluate';
import type { NurbsCurveData } from '../lib/nurbs/types';

/** Most points a display polyline of one curve may hold. */
const MAX_DISPLAY_POINTS = 2_000;

/**
 * Polyline through the curve (local frame) for display and bounds: the same count of points in every knot span (2..16 by the pole count),
 * so spans with a corner (a repeated interior knot) are resolved exactly.
 */
export function curveDisplayPoints(curve: NurbsCurveData): Vec3[] {
  const spans = curve.knots.length - 1;
  const perSpan = Math.max(2, Math.min(16, Math.floor(MAX_DISPLAY_POINTS / spans)));
  const points: Vec3[] = [];
  for (let span = 0; span < spans; span++) {
    const from = curve.knots[span] as number;
    const to = curve.knots[span + 1] as number;
    for (let step = span === 0 ? 0 : 1; step <= perSpan; step++) {
      const u = step === perSpan ? to : from + ((to - from) * step) / perSpan;
      points.push(curveDerivatives(curve, u, 0)[0] as Vec3);
    }
  }
  return points;
}

/** Axis-aligned box of the poles; a NURBS curve (positive weights) lies inside its pole hull, so this is a conservative local AABB. */
export function poleExtent(curve: NurbsCurveData): { min: Vec3; max: Vec3 } {
  const axis = (index: 0 | 1 | 2): readonly [number, number] => {
    const values = curve.poles.map((pole) => pole[index]);
    return [Math.min(...values), Math.max(...values)];
  };
  const [x, y, z] = [axis(0), axis(1), axis(2)];
  return { min: [x[0], y[0], z[0]], max: [x[1], y[1], z[1]] };
}

/** `curve` scaled by `factor` about its local origin (poles scale; knots and weights are unchanged). */
export function scaleCurve(curve: NurbsCurveData, factor: number): NurbsCurveData {
  return { ...curve, poles: curve.poles.map(([x, y, z]) => [x * factor, y * factor, z * factor] as const) };
}

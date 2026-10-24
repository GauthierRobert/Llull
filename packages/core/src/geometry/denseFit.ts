/**
 * A cubic through a subset of densely sampled points of a curve (03 WRP, curves built on a face from kernel evaluations): the smallest uniform subset whose cubic stays within the
 * tolerance of every dense sample. One batched kernel evaluation feeds it; no per-point round trip.
 */

import type { Vec3 } from '../model/vectors';
import { evaluateCurve } from '../lib/nurbs/evaluate';
import { interpolatePoints } from '../lib/nurbs/interpolate';
import type { NurbsCurveData } from '../lib/nurbs/types';

const START_POINTS = 16;

/**
 * @param dense samples at uniform parameters s = k / (dense.length - 1)
 * @failure no subset reaches the tolerance, or the curve has zero length -> `{ error }`
 */
export function fitDenseSamples(
  dense: readonly Vec3[],
  tolerance: number,
): { curve: NurbsCurveData; deviation: number } | { error: string } {
  const last = dense.length - 1;
  for (let n = START_POINTS; n <= last; n *= 2) {
    if (last % n !== 0) continue;
    const stride = last / n;
    const points = Array.from({ length: n + 1 }, (_, k) => dense[k * stride] as Vec3);
    const fitted = interpolatePoints(points, { degree: 3, parameterization: 'uniform' });
    if ('code' in fitted) return { error: 'a curve of zero length cannot be fitted' };
    let deviation = 0;
    for (const [k, exact] of dense.entries()) {
      const got = evaluateCurve(fitted.curve, k / last);
      deviation = Math.max(deviation, Math.hypot(got[0] - exact[0], got[1] - exact[1], got[2] - exact[2]));
    }
    if (deviation <= tolerance) return { curve: fitted.curve, deviation };
  }
  return { error: 'a curve could not be fitted within the fit tolerance' };
}

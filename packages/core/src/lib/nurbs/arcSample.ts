/** Equal arc-length samples of a curve: the same geometric edge gives the same points whatever its parametrisation (for sewing sheets). */

import type { Vec3 } from '../../model/vectors';
import { len3 } from '../vec3';
import { curveLength } from './curvature';
import { curveDerivatives, evaluateCurve } from './evaluate';
import type { NurbsCurveData } from './types';

/**
 * `count + 1` points (and their curve parameters) at arc lengths 0, L / count, ... L along `curve` (Newton on the arc length within the knot span, bracketed), and the length L.
 * @invariant the points depend on the geometry of the curve only, to about 1e-12 of its length
 */
export function arcLengthSamples(curve: NurbsCurveData, count: number): { points: Vec3[]; parameters: number[]; length: number } {
  const knots = curve.knots;
  const cumulative = [0];
  for (let k = 0; k + 1 < knots.length; k++)
    cumulative.push((cumulative[k] as number) + curveLength(curve, knots[k] as number, knots[k + 1] as number));
  const length = cumulative[cumulative.length - 1] as number;
  const points: Vec3[] = [];
  const parameters: number[] = [];
  let span = 0;
  for (let i = 0; i <= count; i++) {
    const target = (length * i) / count;
    while (span + 2 < cumulative.length && (cumulative[span + 1] as number) < target) span++;
    const [lo, hi] = [knots[span] as number, knots[span + 1] as number];
    const [start, end] = [cumulative[span] as number, cumulative[span + 1] as number];
    let t = end > start ? lo + ((hi - lo) * (target - start)) / (end - start) : lo;
    let [low, high] = [lo, hi];
    for (let step = 0; step < 12; step++) {
      const error = start + curveLength(curve, lo, t) - target;
      if (Math.abs(error) <= 1e-13 * Math.max(length, 1e-300)) break;
      if (error > 0) high = t;
      else low = t;
      const speed = len3(curveDerivatives(curve, t, 1)[1] as Vec3);
      const next = speed > 0 ? t - error / speed : (low + high) / 2;
      t = next > low && next < high ? next : (low + high) / 2;
    }
    points.push(evaluateCurve(curve, t));
    parameters.push(t);
  }
  return { points, parameters, length };
}

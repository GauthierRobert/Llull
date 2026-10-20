/** C0 join of curves into one B-spline (the junction knot gets multiplicity = degree): the composite side of an N-sided fill. */

import type { Vec3 } from '../../model/vectors';
import { curveLength } from './curvature';
import { elevateDegree } from './edit';
import { curveDomain } from './evaluate';
import { compressKnots, expandKnots } from './knotVector';
import type { NurbsCurveData } from './types';

/**
 * The curves (non-rational, consecutive ends coincident) as one curve whose parameter runs [0, 1], each piece taking its share of the total
 * length.
 * @failure rational curves or a failing degree elevation -> string reason
 */
export function joinCurves(curves: ReadonlyArray<NurbsCurveData>): NurbsCurveData | string {
  if (curves.length === 1) return curves[0] as NurbsCurveData;
  if (curves.some((curve) => curve.weights !== undefined)) return 'rational curves cannot be joined';
  const degree = Math.max(...curves.map((curve) => curve.degree));
  const raised: NurbsCurveData[] = [];
  for (const curve of curves) {
    const edit = curve.degree < degree ? elevateDegree(curve, degree - curve.degree) : curve;
    if (typeof edit === 'string') return edit;
    raised.push(edit);
  }
  const lengths = raised.map((curve) => curveLength(curve, ...curveDomain(curve)));
  const total = lengths.reduce((sum, length) => sum + length, 0) || 1;
  let full: number[] = [];
  const poles: Vec3[] = [];
  let start = 0;
  raised.forEach((curve, index) => {
    const end = start + (lengths[index] as number) / total;
    const [a, b] = curveDomain(curve);
    const mapped = expandKnots(curve.knots, curve.multiplicities).map((knot) => start + ((knot - a) / (b - a)) * (end - start));
    if (index === 0) {
      full = mapped.slice(0, mapped.length - degree - 1);
      poles.push(...curve.poles);
    } else {
      full = [...full, ...new Array<number>(degree).fill(start), ...mapped.slice(degree + 1, mapped.length - degree - 1)];
      poles.push(...curve.poles.slice(1));
    }
    start = end;
  });
  full = [...full, ...new Array<number>(degree + 1).fill(1)];
  const { knots, multiplicities } = compressKnots(full);
  return { degree, poles, knots, multiplicities };
}

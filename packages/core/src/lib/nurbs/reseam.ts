/**
 * Moving the seam of a closed clamped curve (SWG M5): the start point of a closed section is where loft rulings pair up, so aligning two sections
 * means rotating their starts. The curve is changed exactly (knot insertion to full multiplicity, then a rotation of poles and knots).
 */

import type { Vec3 } from '../../model/vectors';
import { distance3 } from '../vec3';
import { closestOnCurve } from './closest';
import { insertKnot } from './edit';
import { curveDomain } from './evaluate';
import { expandKnots, compressKnots } from './knotVector';
import type { NurbsCurveData } from './types';

/** True when the curve's last pole is its first (a closed curve in the clamped, non-periodic representation). */
export function isClosedCurve(curve: NurbsCurveData): boolean {
  const first = curve.poles[0] as Vec3;
  const last = curve.poles[curve.poles.length - 1] as Vec3;
  const size = Math.max(...curve.poles.map((pole) => distance3(pole, first)), 1e-12);
  const sameWeight =
    curve.weights === undefined || Math.abs((curve.weights[0] as number) - (curve.weights[curve.weights.length - 1] as number)) < 1e-12;
  return distance3(first, last) <= 1e-9 * size && sameWeight;
}

/**
 * The closed curve starting (and ending) at parameter `u` instead of its own start, the same shape.
 * @invariant poles are rotated, none moved: the new start pole is the curve point C(u); the domain becomes [u, u + length of the old domain]
 * @failure an open curve, or a failing knot insertion -> reason
 */
export function reseamCurve(curve: NurbsCurveData, u: number): NurbsCurveData | string {
  if (!isClosedCurve(curve)) return 'only a closed curve (first pole = last pole) can be re-seamed';
  const [a, b] = curveDomain(curve);
  const tolerance = 1e-12 * (b - a);
  if (u <= a + tolerance || u >= b - tolerance) return curve;
  const degree = curve.degree;
  const have = expandKnots(curve.knots, curve.multiplicities).filter((knot) => Math.abs(knot - u) <= tolerance).length;
  let cut: NurbsCurveData | string = curve;
  if (have < degree)
    cut = insertKnot(curve, have === 0 ? u : (curve.knots.find((knot) => Math.abs(knot - u) <= tolerance) as number), degree - have);
  if (typeof cut === 'string') return cut;
  const full = expandKnots(cut.knots, cut.multiplicities);
  const first = full.findIndex((knot) => Math.abs(knot - u) <= tolerance);
  const cutValue = full[first] as number;
  const split = first - 1;
  const reorder = <T>(items: readonly T[]): T[] => [...items.slice(split), ...items.slice(1, split + 1)];
  const period = b - a;
  const fullNew = [
    ...new Array<number>(degree + 1).fill(cutValue),
    ...full.filter((knot) => knot > cutValue + tolerance && knot < b - tolerance),
    ...new Array<number>(degree).fill(b),
    ...full.filter((knot) => knot > a + tolerance && knot < cutValue - tolerance).map((knot) => knot + period),
    ...new Array<number>(degree + 1).fill(cutValue + period),
  ];
  const { knots, multiplicities } = compressKnots(fullNew);
  return {
    degree,
    poles: reorder(cut.poles),
    ...(cut.weights === undefined ? {} : { weights: reorder(cut.weights) }),
    knots,
    multiplicities,
  };
}

/** Parameter of the point of the closed `curve` nearest `target`. */
export const nearestParameter = (curve: NurbsCurveData, target: Vec3): number => closestOnCurve(curve, target).t;

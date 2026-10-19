/** Knot vector helpers: distinct knots + multiplicities <-> the full non-decreasing vector, clamped-uniform defaults, validation. */

import { MAX_NURBS_DEGREE, type NurbsCurveData } from './types';

/** Full knot vector: each distinct knot repeated by its multiplicity. */
export function expandKnots(knots: ReadonlyArray<number>, multiplicities: ReadonlyArray<number>): number[] {
  return knots.flatMap((knot, index) => Array.from({ length: multiplicities[index] ?? 0 }, () => knot));
}

/** Distinct knots + multiplicities of a non-decreasing full vector (equal values compare exactly). */
export function compressKnots(full: ReadonlyArray<number>): { knots: number[]; multiplicities: number[] } {
  const knots: number[] = [];
  const multiplicities: number[] = [];
  for (const value of full) {
    if (knots.length > 0 && knots[knots.length - 1] === value) {
      multiplicities[multiplicities.length - 1] = (multiplicities[multiplicities.length - 1] as number) + 1;
    } else {
      knots.push(value);
      multiplicities.push(1);
    }
  }
  return { knots, multiplicities };
}

/** Clamped uniform knots on [0, 1] for `poleCount` poles of `degree` (fewer poles than degree + 1 is the caller's error). */
export function clampedUniformKnots(poleCount: number, degree: number): { knots: number[]; multiplicities: number[] } {
  const spans = poleCount - degree;
  const knots = Array.from({ length: spans + 1 }, (_, index) => index / spans);
  const multiplicities = knots.map((_, index) => (index === 0 || index === spans ? degree + 1 : 1));
  return { knots, multiplicities };
}

/**
 * Why `curve` is not a valid clamped NURBS curve, or null. Reports the first failing array as `{ path, message }` (`path` is relative to the
 * curve: `degree`, `poles`, `weights.3`, `knots`, `multiplicities`).
 */
export function nurbsViolation(curve: NurbsCurveData): { readonly path: string; readonly message: string } | null {
  const { degree, poles, weights, knots, multiplicities } = curve;
  if (!Number.isInteger(degree) || degree < 1 || degree > MAX_NURBS_DEGREE)
    return { path: 'degree', message: `degree must be an integer in 1..${MAX_NURBS_DEGREE} (got ${degree})` };
  if (poles.length < degree + 1)
    return { path: 'poles', message: `degree ${degree} needs at least ${degree + 1} poles (got ${poles.length})` };
  for (let i = 0; i < poles.length; i++)
    if (!(poles[i] as readonly number[]).every(Number.isFinite)) return { path: `poles.${i}`, message: `pole ${i} is not finite` };
  if (weights !== undefined) {
    if (weights.length !== poles.length)
      return { path: 'weights', message: `weights needs one value per pole (${poles.length}, got ${weights.length})` };
    const bad = weights.findIndex((weight) => !(Number.isFinite(weight) && weight > 0));
    if (bad >= 0) return { path: `weights.${bad}`, message: `weight ${bad} must be finite and > 0 (got ${weights[bad]})` };
  }
  if (knots.length < 2 || knots.length !== multiplicities.length)
    return { path: 'knots', message: 'knots (distinct, >= 2) and multiplicities need the same length' };
  if (!knots.every(Number.isFinite) || knots.some((knot, index) => index > 0 && !(knot > (knots[index - 1] as number))))
    return { path: 'knots', message: 'distinct knots must be finite and strictly increasing' };
  const last = knots.length - 1;
  for (let i = 0; i <= last; i++) {
    const multiplicity = multiplicities[i] as number;
    const limit = i === 0 || i === last ? degree + 1 : degree;
    if (!Number.isInteger(multiplicity) || multiplicity < 1 || multiplicity > limit)
      return { path: `multiplicities.${i}`, message: `multiplicity ${i} must be an integer in 1..${limit} (got ${multiplicity})` };
  }
  if ((multiplicities[0] as number) !== degree + 1 || (multiplicities[last] as number) !== degree + 1)
    return {
      path: 'multiplicities',
      message: `a clamped curve needs end multiplicities ${degree + 1} (got ${multiplicities[0]} and ${multiplicities[last]})`,
    };
  const total = multiplicities.reduce((sum, multiplicity) => sum + multiplicity, 0);
  if (total !== poles.length + degree + 1)
    return { path: 'multiplicities', message: `multiplicities sum to ${total} but poles + degree + 1 = ${poles.length + degree + 1}` };
  return null;
}

/** Saved-document checks for NURBS curve data (entity `nurbs_curve`, loft `sections`). */

import { isRecord } from '../../lib/isRecord';
import { isFiniteNumber } from '../../lib/isFiniteNumber';
import { isVec3 } from '../../lib/vec3';
import { nurbsViolation } from '../../lib/nurbs/knotVector';
import type { NurbsCurveData } from '../../lib/nurbs/types';
import { MAX_SPLINE_CONTROL_POINTS } from '../limits';
import { hasClosingEdge, sectionChain } from '../../geometry/sectionChain';

const numberArray = (value: unknown): value is number[] => Array.isArray(value) && value.every(isFiniteNumber);

/** First structural problem of a stored NURBS curve (`label` names it in the message), or null when it is a valid clamped curve. */
export function nurbsCurveProblem(value: unknown, label: string): string | null {
  if (!isRecord(value)) return `${label} must be an object`;
  const { degree, poles, weights, knots, multiplicities } = value;
  if (!isFiniteNumber(degree)) return `${label}.degree must be a finite number`;
  if (!Array.isArray(poles) || poles.length > MAX_SPLINE_CONTROL_POINTS || !poles.every(isVec3))
    return `${label}.poles must be a list of at most ${MAX_SPLINE_CONTROL_POINTS} [x, y, z] points`;
  if (weights !== undefined && !numberArray(weights)) return `${label}.weights must be a list of finite numbers`;
  if (!numberArray(knots) || !numberArray(multiplicities))
    return `${label}.knots and ${label}.multiplicities must be lists of finite numbers`;
  const curve: NurbsCurveData = { degree, poles, ...(weights === undefined ? {} : { weights }), knots, multiplicities };
  const violation = nurbsViolation(curve);
  return violation === null ? null : `${label}.${violation.path}: ${violation.message}`;
}

/** Problem of a loft's stored sections as a set (degree 1..3, non-rational, equal Bézier span count and closing edge - what `loft_sections` guarantees), or null. */
export function exactSectionsProblem(curves: ReadonlyArray<NurbsCurveData>): string | null {
  const chains = curves.map(sectionChain);
  const bad = chains.findIndex((chain) => chain === null);
  if (bad >= 0) return `sections.${bad} must be a non-rational curve of degree 1..3`;
  const first = chains[0] as NonNullable<(typeof chains)[number]>;
  const mismatch = curves.findIndex(
    (curve, i) =>
      (chains[i] as typeof first).length !== first.length || hasClosingEdge(curve) !== hasClosingEdge(curves[0] as NurbsCurveData),
  );
  return mismatch > 0 ? `sections.${mismatch} must have the same Bézier span count and closing edge as sections.0` : null;
}

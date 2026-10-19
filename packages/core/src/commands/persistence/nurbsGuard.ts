/** Saved-document checks for NURBS curve data (entity `nurbs_curve`, loft `sections`). */

import { isRecord } from '../../lib/isRecord';
import { isFiniteNumber } from '../../lib/isFiniteNumber';
import { isVec3 } from '../../lib/vec3';
import { nurbsViolation } from '../../lib/nurbs/knotVector';
import type { NurbsCurveData } from '../../lib/nurbs/types';
import { MAX_SPLINE_CONTROL_POINTS } from '../limits';

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

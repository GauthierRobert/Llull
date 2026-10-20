/** Saved-document checks for NURBS curve and surface data (entities `nurbs_curve`, `nurbs_surface`, loft `sections`). */

import { isRecord } from '../../lib/isRecord';
import { isFiniteNumber } from '../../lib/isFiniteNumber';
import { isVec3 } from '../../lib/vec3';
import { nurbsViolation } from '../../lib/nurbs/knotVector';
import type { NurbsCurveData } from '../../lib/nurbs/types';
import { MAX_SURFACE_POLES, surfaceViolation, type NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';
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

const MAX_TRIM_VERTICES = 4096;
const MAX_TRIM_LOOPS = 64;

/** [min, max] of a stored knot list, or null when it is not a list of numbers. */
const knotRange = (knots: unknown): [number, number] | null =>
  Array.isArray(knots) && knots.length >= 2 && knots.every(isFiniteNumber) ? [knots[0] as number, knots[knots.length - 1] as number] : null;

/**
 * First structural problem of the stored trim loops of a sheet (`trims` of `nurbs_surface`; `surface` gives the parameter domain the points
 * must lie in), or null when absent or valid: at most 64 loops of 3..4096 points, an even count (the area rule decimates by two).
 */
export function surfaceTrimsProblem(value: unknown, surface: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > MAX_TRIM_LOOPS) return `trims must be a list of at most ${MAX_TRIM_LOOPS} loops`;
  const [u, v] = isRecord(surface) ? [knotRange(surface['knotsU']), knotRange(surface['knotsV'])] : [null, null];
  const slack = 1e-9;
  for (const [index, loop] of value.entries()) {
    if (!isRecord(loop) || typeof loop['outer'] !== 'boolean') return `trims.${index} must be { outer, polygon }`;
    const polygon = loop['polygon'];
    const valid =
      Array.isArray(polygon) &&
      polygon.length >= 4 &&
      polygon.length <= MAX_TRIM_VERTICES &&
      polygon.length % 2 === 0 &&
      polygon.every((p) => Array.isArray(p) && p.length === 2 && p.every(isFiniteNumber));
    if (!valid) return `trims.${index}.polygon must be an even number (4..${MAX_TRIM_VERTICES}) of [u, v] points`;
    if (u !== null && v !== null) {
      const outside = (polygon as number[][]).some(
        (p) =>
          (p[0] as number) < u[0] - slack ||
          (p[0] as number) > u[1] + slack ||
          (p[1] as number) < v[0] - slack ||
          (p[1] as number) > v[1] + slack,
      );
      if (outside) return `trims.${index}.polygon has points outside the parameter domain of the surface`;
    }
  }
  return null;
}

/** First structural problem of a stored NURBS surface (`label` names it in the message), or null when it is a valid clamped patch. */
export function nurbsSurfaceProblem(value: unknown, label: string): string | null {
  if (!isRecord(value)) return `${label} must be an object`;
  const { degreeU, degreeV, poles, weights, knotsU, multiplicitiesU, knotsV, multiplicitiesV } = value;
  if (!isFiniteNumber(degreeU) || !isFiniteNumber(degreeV)) return `${label}.degreeU and ${label}.degreeV must be finite numbers`;
  const grid =
    (cell: (item: unknown) => boolean) =>
    (list: unknown): boolean =>
      Array.isArray(list) &&
      list.length <= MAX_SURFACE_POLES &&
      list.every((row) => Array.isArray(row) && row.length <= MAX_SURFACE_POLES && row.every(cell));
  if (!grid(isVec3)(poles)) return `${label}.poles must be a grid of [x, y, z] points (at most ${MAX_SURFACE_POLES} per direction)`;
  if (weights !== undefined && !grid(isFiniteNumber)(weights)) return `${label}.weights must be a grid of finite numbers`;
  if (![knotsU, multiplicitiesU, knotsV, multiplicitiesV].every(numberArray))
    return `${label} knots and multiplicities (u and v) must be lists of finite numbers`;
  const surface = {
    degreeU,
    degreeV,
    poles,
    ...(weights === undefined ? {} : { weights }),
    knotsU,
    multiplicitiesU,
    knotsV,
    multiplicitiesV,
  } as NurbsSurfaceData;
  const violation = surfaceViolation(surface);
  return violation === null ? null : `${label}.${violation.path}: ${violation.message}`;
}

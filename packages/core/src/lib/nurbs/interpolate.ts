/** Global curve interpolation through points (Piegl & Tiller A9.1 with knot averaging and optional end derivatives, §9.2). */

import type { Vec3 } from '../../model/vectors';
import { distance3, len3, scale3 } from '../vec3';
import { basisDerivatives, basisFunctions, findSpan } from './basis';
import { solveBanded, type SparseRow } from './bandSolve';
import { compressKnots } from './knotVector';
import type { NurbsCurveData } from './types';
import { MAX_NURBS_DEGREE } from './types';
import { evaluateCurve } from './evaluate';

type Parameterization = 'chord' | 'centripetal' | 'uniform';

export type InterpolationFailure =
  | { readonly code: 'SRF_POINTS_INSUFFICIENT'; readonly message: string }
  | { readonly code: 'SRF_POINTS_COINCIDENT'; readonly message: string; readonly index: number }
  | { readonly code: 'SRF_NURBS_INVALID'; readonly message: string };

export interface InterpolationOptions {
  readonly degree: number;
  readonly parameterization: Parameterization;
  /** Direction of the curve at the first point (any length; scaled to the polyline length per unit parameter). */
  readonly startTangent?: Vec3 | undefined;
  readonly endTangent?: Vec3 | undefined;
  /** The end tangents are derivatives with respect to the parameter on [0, 1] as given (default: only their direction counts, the length is the polyline's). */
  readonly exactTangents?: boolean | undefined;
}

/** Parameter values t_0 = 0 .. t_n = 1 (chord, centripetal = chord^1/2, or uniform) and the polyline length. */
function parameters(points: ReadonlyArray<Vec3>, parameterization: Parameterization): { t: number[]; length: number } {
  const exponent = parameterization === 'centripetal' ? 0.5 : 1;
  const steps = points.slice(1).map((point, index) => distance3(point, points[index] as Vec3));
  const length = steps.reduce((sum, step) => sum + step, 0);
  if (parameterization === 'uniform') return { t: points.map((_, index) => index / (points.length - 1)), length };
  const weights = steps.map((step) => step ** exponent);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const t = [0];
  weights.forEach((weight) => t.push((t[t.length - 1] as number) + weight / total));
  t[t.length - 1] = 1;
  return { t, length };
}

/**
 * Clamped knot vector by averaging (eq. 9.8; with end derivatives the window starts one earlier / ends one later so the unknown count
 * matches). Interior knots only; returned as a full vector.
 */
function averagedKnots(t: ReadonlyArray<number>, degree: number, startDerivative: boolean, endDerivative: boolean): number[] {
  const n = t.length - 1;
  const begin = startDerivative ? 0 : 1;
  const count = n - degree + (startDerivative ? 1 : 0) + (endDerivative ? 1 : 0);
  const interior: number[] = [];
  for (let j = begin; j < begin + count; j++) {
    let sum = 0;
    for (let i = j; i < j + degree; i++) sum += t[i] as number;
    interior.push(sum / degree);
  }
  return [...new Array<number>(degree + 1).fill(0), ...interior, ...new Array<number>(degree + 1).fill(1)];
}

/**
 * Cubic (or any degree) NURBS curve passing through every point, parameterised on [0, 1].
 * @failure fewer than degree + 1 points (counting each end tangent as one more condition), coincident consecutive points, tangents with
 *   degree 1, singular system
 */
export function interpolatePoints(
  points: ReadonlyArray<Vec3>,
  options: InterpolationOptions,
): { curve: NurbsCurveData; residual: number } | InterpolationFailure {
  const { degree, parameterization } = options;
  if (!Number.isInteger(degree) || degree < 1 || degree > MAX_NURBS_DEGREE)
    return { code: 'SRF_NURBS_INVALID', message: `degree must be an integer in 1..${MAX_NURBS_DEGREE} (got ${degree})` };
  const startTangent = options.startTangent;
  const endTangent = options.endTangent;
  const tangentCount = (startTangent === undefined ? 0 : 1) + (endTangent === undefined ? 0 : 1);
  if (tangentCount > 0 && degree < 2) return { code: 'SRF_NURBS_INVALID', message: 'end tangents need degree >= 2' };
  const unknowns = points.length + tangentCount;
  if (points.length < 2 || unknowns < degree + 1)
    return {
      code: 'SRF_POINTS_INSUFFICIENT',
      message: `degree ${degree} needs at least ${degree + 1 - tangentCount} points with ${tangentCount} end tangent(s) (got ${points.length})`,
    };
  const extent = Math.max(
    ...[0, 1, 2].map((axis) => Math.max(...points.map((p) => p[axis] as number)) - Math.min(...points.map((p) => p[axis] as number))),
  );
  const coincident = points.findIndex(
    (point, index) => index > 0 && distance3(point, points[index - 1] as Vec3) <= 1e-9 * Math.max(extent, 1e-300),
  );
  if (coincident > 0)
    return { code: 'SRF_POINTS_COINCIDENT', message: `points ${coincident - 1} and ${coincident} coincide`, index: coincident };
  const { t, length } = parameters(points, parameterization);
  const full = averagedKnots(t, degree, startTangent !== undefined, endTangent !== undefined);
  const rows: SparseRow[] = [];
  const rhs: number[][] = [];
  const unitScale = (tangent: Vec3): Vec3 => (options.exactTangents === true ? tangent : scale3(tangent, length / (len3(tangent) || 1)));
  const derivativeRow = (u: number, tangent: Vec3): void => {
    const span = findSpan(unknowns, degree, u, full);
    const ders = basisDerivatives(span, u, degree, 1, full);
    rows.push((ders[1] as number[]).map((value, j) => [span - degree + j, value] as const));
    rhs.push([...unitScale(tangent)]);
  };
  if (startTangent !== undefined) derivativeRow(0, startTangent);
  points.forEach((point, k) => {
    const u = t[k] as number;
    const span = findSpan(unknowns, degree, u, full);
    rows.push(basisFunctions(span, u, degree, full).map((value, j) => [span - degree + j, value] as const));
    rhs.push([...point]);
  });
  if (endTangent !== undefined) derivativeRow(1, endTangent);
  const solved = solveBanded(rows, rhs);
  if (solved === null) return { code: 'SRF_NURBS_INVALID', message: 'the interpolation system is singular (check the points)' };
  const { knots, multiplicities } = compressKnots(full);
  const curve: NurbsCurveData = {
    degree,
    poles: solved.map((row) => [row[0] as number, row[1] as number, row[2] as number] as const),
    knots,
    multiplicities,
  };
  const residual = Math.max(...points.map((point, k) => distance3(evaluateCurve(curve, t[k] as number), point)));
  return { curve, residual };
}

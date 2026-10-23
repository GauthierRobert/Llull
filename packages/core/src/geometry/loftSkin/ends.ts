/** End conditions of a loft: per-pole derivative directions for a normal / fixed direction / neighbouring face, and the angle actually achieved. */

import type { Vec3 } from '../../model/vectors';
import { add3, cross3, dot3, len3, normalize3, scale3, sub3 } from '../../lib/vec3';
import { closestOnSurface, surfaceProbe } from '../../lib/nurbs/closest';
import { curveDerivatives, evaluateCurve } from '../../lib/nurbs/evaluate';
import { expandKnots } from '../../lib/nurbs/knotVector';
import type { EndData } from '../../lib/nurbs/skinEnds';
import { surfaceDerivatives, surfaceDomain } from '../../lib/nurbs/surface';
import { normalCurvature, surfaceSample } from '../../lib/nurbs/surfaceCurvature';
import type { NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';
import type { NurbsCurveData } from '../../lib/nurbs/types';
import type { EndRequest, LoftIssue } from './types';

/** Geometry of one end of the loft the request refers to. */
export interface EndContext {
  /** Unit normal of the end section's plane, pointing along the direction of travel (into the loft at the start, out of it at the end). */
  readonly normal: Vec3;
  readonly centroid: Vec3;
  /** Unit direction of travel across the end (first -> second section at the start, second last -> last at the end). */
  readonly travel: Vec3;
  readonly faceTolerance: number;
}

/** Greville abscissae of the poles of `curve`: the parameter each pole acts at. */
function grevilleParameters(curve: NurbsCurveData): number[] {
  const full = expandKnots(curve.knots, curve.multiplicities);
  const p = curve.degree;
  return curve.poles.map((_, i) => (p === 0 ? (full[i] as number) : full.slice(i + 1, i + p + 1).reduce((s, k) => s + k, 0) / p));
}

/**
 * Derivative directions of the surface across `curve` for `request`.
 * @failure a zero direction or magnitude <= 0 -> SWG_LOFT_END_CONDITION_INVALID; a face that the section does not lie on -> SWG_LOFT_FACE_NOT_ADJACENT
 */
export function endData(request: Exclude<EndRequest, { type: 'point' }>, curve: NurbsCurveData, context: EndContext): EndData | LoftIssue {
  const invalid = (message: string): LoftIssue => ({ code: 'SWG_LOFT_END_CONDITION_INVALID', message });
  if (!(request.magnitude > 0) || !Number.isFinite(request.magnitude)) return invalid(`magnitude must be > 0 (got ${request.magnitude})`);
  const g = grevilleParameters(curve);
  if (request.type === 'direction') {
    if (len3(request.direction) < 1e-9) return invalid('the direction must be a non-zero vector');
    const direction = normalize3(request.direction);
    return { directions: curve.poles.map(() => direction), magnitude: request.magnitude };
  }
  if (request.type === 'normal') {
    const draft = ((request.draftDeg ?? 0) * Math.PI) / 180;
    const directions = g.map((u): Vec3 => {
      if (draft === 0) return context.normal;
      const radial = sub3(evaluateCurve(curve, u), context.centroid);
      const inPlane = sub3(radial, scale3(context.normal, dot3(radial, context.normal)));
      const toward = len3(inPlane) > 1e-12 ? scale3(inPlane, -1 / len3(inPlane)) : ([0, 0, 0] as Vec3);
      return add3(scale3(context.normal, Math.cos(draft)), scale3(toward, Math.sin(draft)));
    });
    return { directions, magnitude: request.magnitude };
  }
  const probe = surfaceProbe(request.surface);
  const directions: Vec3[] = [];
  const normals: Vec3[] = [];
  const curvatures: number[] = [];
  for (const u of g) {
    const [point, tangent] = curveDerivatives(curve, u, 1) as [Vec3, Vec3];
    const hit = closestOnSurface(request.surface, point, probe);
    if (hit.distance > context.faceTolerance)
      return {
        code: 'SWG_LOFT_FACE_NOT_ADJACENT',
        message: `the end section is ${hit.distance.toExponential(2)} from the reference face (tolerance ${context.faceTolerance.toExponential(2)})`,
      };
    const sample = surfaceSample(request.surface, hit.u, hit.v);
    if (sample.degenerate) return invalid('the reference face is singular at the end section');
    const across = cross3(sample.normal, normalize3(tangent));
    if (len3(across) < 1e-9) return invalid('the end section runs along the face normal');
    const direction = scale3(normalize3(across), dot3(across, context.travel) >= 0 ? 1 : -1);
    directions.push(direction);
    normals.push(sample.normal);
    const det = sample.e * sample.g - sample.f * sample.f;
    const a = (dot3(direction, sample.su) * sample.g - dot3(direction, sample.sv) * sample.f) / det;
    const b = (dot3(direction, sample.sv) * sample.e - dot3(direction, sample.su) * sample.f) / det;
    curvatures.push(normalCurvature(sample, a, b));
  }
  return { directions, magnitude: request.magnitude, ...(request.curvature ? { curvature: { values: curvatures, normals } } : {}) };
}

const angleBetween = (a: Vec3, b: Vec3): number => Math.acos(Math.min(1, Math.max(-1, dot3(a, b) / Math.max(len3(a) * len3(b), 1e-300))));

/**
 * Largest angle (radians) over 33 samples across the end `which` of `surface` between the skin and what the request asked: the v derivative
 * against the normal / fixed direction (against the draft angle when one was given), or the skin normal against the face normal.
 */
export function achievedAngle(
  surface: NurbsSurfaceData,
  which: 'start' | 'end',
  request: Exclude<EndRequest, { type: 'point' }>,
  context: EndContext,
): number {
  const [[u0, u1], [v0, v1]] = surfaceDomain(surface);
  const v = which === 'start' ? v0 : v1;
  const probe = request.type === 'face' ? surfaceProbe(request.surface) : null;
  let worst = 0;
  for (let k = 0; k <= 32; k++) {
    const u = u0 + ((u1 - u0) * k) / 32;
    const d = surfaceDerivatives(surface, u, v, 1);
    const [su, sv] = [(d[1] as Vec3[])[0] as Vec3, (d[0] as Vec3[])[1] as Vec3];
    if (request.type === 'face') {
      const here = (d[0] as Vec3[])[0] as Vec3;
      const hit = closestOnSurface(request.surface, here, probe as ReturnType<typeof surfaceProbe>);
      const normal = surfaceSample(request.surface, hit.u, hit.v).normal;
      const angle = angleBetween(cross3(su, sv), normal);
      worst = Math.max(worst, Math.min(angle, Math.PI - angle));
    } else if (request.type === 'direction') worst = Math.max(worst, angleBetween(sv, request.direction));
    else {
      const angle = angleBetween(sv, context.normal);
      worst = Math.max(worst, request.draftDeg === undefined ? angle : Math.abs(angle - Math.abs((request.draftDeg * Math.PI) / 180)));
    }
  }
  return worst;
}

/** create_nurbs_curve, interpolate_curve, create_conic: the three ways to make a `nurbs_curve`. */

import type { Vec3 } from '../../model/types';
import { MAX_NURBS_DEGREE, type NurbsCurveData } from '../../lib/nurbs/types';
import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { clampedUniformKnots, compressKnots, nurbsViolation } from '../../lib/nurbs/knotVector';
import { interpolatePoints } from '../../lib/nurbs/interpolate';
import { conicCurve, isCollinear, rhoFromShoulder, tangentApex } from '../../lib/nurbs/conic';
import { len3 } from '../../lib/vec3';
import { MAX_CURVE_POINTS, commitCurve, curveStyleFields, refuseSrf } from './shared';

/**
 * @affects creates 1 nurbs_curve entity
 * @invariant clamped, non-periodic; Σ multiplicities = poles + degree + 1; weights > 0
 * @failure degree outside 1..25, too few poles, bad knots / multiplicities / weights -> SRF_NURBS_INVALID, no-op
 */
export const createNurbsCurve = defineCommand({
  name: 'create_nurbs_curve',
  description:
    'Create a 3D NURBS curve (clamped B-spline, optionally rational) from its control polygon. `degree` 1..25 (3 = cubic), `poles` the control ' +
    'points (at least degree + 1, at most 10000). Omit `knots` for a clamped uniform knot vector on [0, 1]. To give them, either pass the FULL ' +
    'knot vector in `knots` (non-decreasing, length poles + degree + 1, e.g. [0,0,0,0,1,1,1,1] for a cubic Bezier) or pass the distinct knots in ' +
    '`knots` with their `multiplicities` (end multiplicities degree + 1, interior at most degree). `weights` (one > 0 per pole) make it rational: ' +
    'a quadratic with weights [1, w, 1] is a conic arc. The curve does not pass through the poles (use interpolate_curve for that). ' +
    'Next: inspect_nurbs, analyze_curve_curvature, edit_nurbs.',
  params: z.object({
    degree: z.number().describe('Polynomial degree, an integer 1..25 (1 = polyline, 2 = quadratic, 3 = cubic).'),
    poles: z
      .array(vec3('Control point [x, y, z] in document units, relative to `position`.'))
      .describe('Control points, at least degree + 1.'),
    weights: z
      .array(z.number())
      .describe('Optional rational weights, one finite number > 0 per pole. Omit for a non-rational curve.')
      .optional(),
    knots: z
      .array(z.number())
      .describe(
        'Optional knots: the full non-decreasing vector (length poles + degree + 1) when `multiplicities` is omitted, else the DISTINCT strictly increasing knots. Omit for clamped uniform.',
      )
      .optional(),
    multiplicities: z
      .array(z.number())
      .describe('Optional multiplicity of each distinct knot (first and last degree + 1, others 1..degree). Use with distinct `knots`.')
      .optional(),
    ...curveStyleFields(),
  }),
  run: (doc, params): CommandResult => {
    const { degree, poles, weights, knots, multiplicities } = params;
    const refuse = (path: string, message: string): CommandResult =>
      refuseSrf(doc, 'create_nurbs_curve', 'SRF_NURBS_INVALID', message, [], [`params.${path}`]);
    if (poles.length > MAX_CURVE_POINTS) return refuse('poles', `at most ${MAX_CURVE_POINTS} poles (got ${poles.length})`);
    if (!Number.isInteger(degree) || degree < 1 || degree > MAX_NURBS_DEGREE)
      return refuse('degree', `degree must be an integer in 1..${MAX_NURBS_DEGREE} (got ${degree})`);
    if (poles.length < degree + 1) return refuse('poles', `degree ${degree} needs at least ${degree + 1} poles (got ${poles.length})`);
    let layout: { knots: number[]; multiplicities: number[] };
    if (knots === undefined) layout = clampedUniformKnots(poles.length, degree);
    else if (multiplicities !== undefined) layout = { knots, multiplicities };
    else layout = compressKnots(knots);
    const curve: NurbsCurveData = { degree, poles, ...(weights === undefined ? {} : { weights }), ...layout };
    const violation = nurbsViolation(curve);
    if (violation !== null) return refuse(violation.path, violation.message);
    return commitCurve(
      doc,
      curve,
      params,
      (id) =>
        `create_nurbs_curve: created ${weights === undefined ? 'non-rational' : 'rational'} degree-${degree} curve "${id}" with ${poles.length} poles and ${layout.knots.length} distinct knots.`,
    );
  },
});

/**
 * @affects creates 1 nurbs_curve entity passing through every point
 * @invariant interpolates each point at its parameter (residual reported, ~1e-15); parameters in [0, 1]
 * @failure fewer than degree + 1 points -> SRF_POINTS_INSUFFICIENT; coincident consecutive points -> SRF_POINTS_COINCIDENT; bad degree / tangent -> SRF_NURBS_INVALID
 */
export const interpolateCurve = defineCommand({
  name: 'interpolate_curve',
  description:
    'Create a 3D NURBS curve that passes exactly through every given point (global interpolation, knots by averaging). Typical use: an airfoil ' +
    'or hull section, a spine or a rail from measured points. `parameterization` sets how the points are spread along the curve: "chord" ' +
    '(default, chord-length), "centripetal" (best against overshoot at sharp turns) or "uniform". `degree` default 3 (needs at least degree + 1 ' +
    'points). Optional `startTangent` / `endTangent` fix the direction at the ends (direction only, any length; degree >= 2). Consecutive points ' +
    'must be distinct. Returns the curve id and the interpolation residual (should be ~1e-15 in document units).',
  params: z.object({
    points: z.array(vec3('Point [x, y, z] in document units, relative to `position`.')).describe('2..10000 ordered through-points.'),
    degree: z.number().describe('Degree 1..25, default 3.').optional(),
    parameterization: z.enum(['chord', 'centripetal', 'uniform']).describe('Parameter spacing of the points. Default "chord".').optional(),
    startTangent: vec3('Optional direction [x, y, z] of the curve at the first point (any non-zero length).').optional(),
    endTangent: vec3('Optional direction [x, y, z] of the curve at the last point (any non-zero length).').optional(),
    ...curveStyleFields(),
  }),
  run: (doc, params): CommandResult => {
    const { points, degree = 3, parameterization = 'chord', startTangent, endTangent } = params;
    if (points.length > MAX_CURVE_POINTS)
      return refuseSrf(
        doc,
        'interpolate_curve',
        'SRF_POINTS_INSUFFICIENT',
        `at most ${MAX_CURVE_POINTS} points (got ${points.length})`,
        [],
        ['params.points'],
      );
    if ((startTangent !== undefined && len3(startTangent) === 0) || (endTangent !== undefined && len3(endTangent) === 0))
      return refuseSrf(doc, 'interpolate_curve', 'SRF_NURBS_INVALID', 'a tangent must be non-zero', [], ['params.startTangent']);
    const result = interpolatePoints(points, { degree, parameterization, startTangent, endTangent });
    if ('code' in result) {
      const path = 'index' in result ? `params.points.${result.index}` : 'params.points';
      return refuseSrf(doc, 'interpolate_curve', result.code, result.message, [], [path]);
    }
    return commitCurve(
      doc,
      result.curve,
      params,
      (id) =>
        `interpolate_curve: created degree-${degree} curve "${id}" through ${points.length} points (${parameterization}, ${result.curve.poles.length} poles, max residual ${result.residual.toExponential(2)}).`,
    );
  },
});

/**
 * @affects creates 1 rational quadratic nurbs_curve (a conic arc)
 * @invariant apex weight w = rho / (1 - rho); rho < 1/2 ellipse, = 1/2 parabola, > 1/2 hyperbola
 * @failure rho outside (0, 1) -> SRF_CONIC_RHO_RANGE; collinear start / apex / end -> SRF_CONIC_COLLINEAR; conflicting inputs -> SRF_PARAM_INVALID
 */
export const createConic = defineCommand({
  name: 'create_conic',
  description:
    'Create a conic arc (ellipse, parabola or hyperbola segment) as a rational quadratic NURBS from `start` to `end` (Liming rho-conic, used ' +
    'for fuselage master lines). Give the corner where the end tangents meet as `apex`, or the two end directions `startTangent` + `endTangent` ' +
    '(coplanar with the chord; the apex is their intersection). Fullness: `rho` in (0, 1) is the fraction of the way from the chord midpoint ' +
    'to the apex that the curve reaches (0.5 = parabola; below an ellipse; above a hyperbola), or give the `shoulder` point the curve must ' +
    'pass through (on the midpoint-apex line). Quarter circle: start [1,0,0], apex [1,1,0], end [0,1,0], rho = sqrt(2) - 1 = 0.41421356.',
  params: z.object({
    start: vec3('Start point [x, y, z] in document units.'),
    end: vec3('End point [x, y, z] in document units.'),
    apex: vec3('Intersection [x, y, z] of the end tangent lines. Give this or both tangents.').optional(),
    startTangent: vec3('Direction [x, y, z] at `start` (with endTangent instead of apex).').optional(),
    endTangent: vec3('Direction [x, y, z] at `end` (with startTangent instead of apex).').optional(),
    rho: z.number().describe('Shoulder parameter in (0, 1); weight of the apex = rho / (1 - rho). Give this or `shoulder`.').optional(),
    shoulder: vec3(
      'A point [x, y, z] on the line from the chord midpoint to the apex that the curve passes through. Give this or `rho`.',
    ).optional(),
    ...curveStyleFields(),
  }),
  run: (doc, params): CommandResult => {
    const { start, end, startTangent, endTangent, shoulder } = params;
    const fail = (code: string, message: string, path: string): CommandResult =>
      refuseSrf(doc, 'create_conic', code, message, [], [`params.${path}`]);
    if ((params.apex === undefined) === (startTangent === undefined || endTangent === undefined))
      return fail('SRF_PARAM_INVALID', 'give either apex, or both startTangent and endTangent', 'apex');
    if ((params.rho === undefined) === (shoulder === undefined))
      return fail('SRF_PARAM_INVALID', 'give exactly one of rho and shoulder', 'rho');
    let apex: Vec3 | null = params.apex ?? null;
    if (apex === null && startTangent !== undefined && endTangent !== undefined) {
      apex = tangentApex(start, startTangent, end, endTangent);
      if (apex === null) return fail('SRF_CONIC_COLLINEAR', 'the end tangents do not meet (parallel or skew)', 'startTangent');
    }
    if (apex === null || isCollinear(start, apex, end)) return fail('SRF_CONIC_COLLINEAR', 'start, apex and end are collinear', 'apex');
    const rho = params.rho ?? (shoulder === undefined ? null : rhoFromShoulder(start, apex, end, shoulder));
    if (rho === null) return fail('SRF_PARAM_INVALID', 'shoulder is not on the line from the chord midpoint to the apex', 'shoulder');
    if (!(rho > 0 && rho < 1)) return fail('SRF_CONIC_RHO_RANGE', `rho must be in (0, 1) (got ${rho})`, 'rho');
    const kind = rho < 0.5 - 1e-12 ? 'elliptic' : rho > 0.5 + 1e-12 ? 'hyperbolic' : 'parabolic';
    return commitCurve(
      doc,
      conicCurve(start, apex, end, rho),
      params,
      (id) => `create_conic: created ${kind} conic arc "${id}" (rho ${rho}, apex weight ${rho / (1 - rho)}).`,
    );
  },
});

/** flow_along_curve — lay a straight solid along a curve, keeping its length (01 DEF M3, FR-DEF-14, Rhino Flow / CATIA Wrap Curve). */

import type { Vec3 } from '../../model/types';
import { buildFlowLaw } from '../../geometry/deform/flow';
import { resolveFrame } from '../../geometry/deform/frame';
import { cross3, dot3, len3, normalize3, scale3, sub3 } from '../../lib/vec3';
import { defineCommand, vec3, z } from '../schema';
import type { CommandResult } from '../types';
import { worldCurveOf } from '../solids/loftSectionCurves';
import { bodyParams, outputParam, targetIds } from './schema';
import type { DeformPlan } from './request';
import { runDeform } from './run';
import { type Refusal, defaultTolerance, resolveTargetFrame } from './target';

/**
 * @affects replaces the entity by a mesh entity whose brep recipe is a deform node with a flow law (a table of frames along the target curve)
 * @invariant the point (x, y, z) goes to P(s) + x N(s) + y B(s) with s the arc length along the body axis from its start (scaled to the curve length with stretch);
 *   rotation-minimising frames unless fixed_up; on a circular arc this is bend_body; det J = ratio (1 - kappa_N x - kappa_B y), so the body folds where its
 *   half width reaches the radius of curvature; kernel-optional: exact warp on the native kernel, mesh path otherwise
 * @failure unknown / non-curve targetId -> DEF_CURVE_NOT_FOUND; a curve of zero length, or an up vector parallel to its tangent -> DEF_CURVE_INVALID; body wider than the curvature radius -> DEF_FOLDOVER
 */
export const flowAlongCurve = defineCommand({
  name: 'flow_along_curve',
  annotations: { readsMeshTriangles: true },
  description:
    'Lay a straight 3D solid or mesh along a NURBS curve: the body axis (frame z, default the longest bounding-box direction, starting at the body start) ' +
    'is mapped onto the curve by arc length, the cross-section follows the curve frame (N and B perpendicular to the tangent), so a straight bar becomes a bar ' +
    'running along the curve with its length kept (stretch true scales it to the curve length instead). The frame x and y of the body become the curve normal and ' +
    'binormal; orientation "minimal" (default) uses the twist-free rotation-minimising frame, "fixed_up" keeps the normal toward the up vector (world z by default). ' +
    'On a circular arc this equals bend_body. Beyond the end of a shorter curve the body continues straight. Use it for hoses, rails, handrails and trim along a path. ' +
    'targetId is a nurbs_curve entity (create_nurbs_curve, interpolate_curve, add_helix, ...). The result replaces the entity as a mesh entity that keeps the construction ' +
    '(brep recipe). Refuses a missing or non-curve targetId (DEF_CURVE_NOT_FOUND), a zero-length curve or an up vector parallel to the tangent (DEF_CURVE_INVALID), and a body ' +
    'wider than the radius of curvature on the inside of the path (DEF_FOLDOVER, with the sampled min det J). Then call analyze_deformation and check_deformation.',
  params: z.object({
    ...bodyParams,
    targetId: z
      .string()
      .describe('Id of the nurbs_curve entity the body flows along (describe_scene lists ids). The body axis starts at the curve start.'),
    stretch: z
      .boolean()
      .describe(
        'true: scale the body length to the curve length (arc length ratio = curve length / body length). Default false: the length is kept.',
      )
      .optional(),
    orientation: z
      .enum(['minimal', 'fixed_up'])
      .describe('Frame along the curve: "minimal" (default, rotation-minimising, no twist) or "fixed_up" (normal toward the up vector).')
      .optional(),
    up: vec3(
      'Up vector for orientation "fixed_up", unitless; must not be parallel to the curve tangent anywhere. Default [0, 0, 1].',
    ).optional(),
    frame: z
      .object({
        origin: vec3(
          'A point of the body axis, world document units. Default: the centre of the face where the body starts along the axis.',
        ).optional(),
        axis: vec3(
          'Direction of the body axis (the straight base), unitless (normalised). Default: the longest bounding-box direction.',
        ).optional(),
        reference: vec3(
          'Direction that becomes the curve normal, unitless; must not be parallel to axis. Default: the next longest direction.',
        ).optional(),
      })
      .describe('Body frame; every field defaults from the body bounds and the defaults used are reported in data.frame.')
      .optional(),
    output: outputParam.optional(),
  }),
  run: (doc, { id, ids, keepSource, targetId, stretch = false, orientation = 'minimal', up, frame, output }, ctx): CommandResult =>
    runDeform(doc, ctx, {
      command: 'flow_along_curve',
      ids: targetIds(id, ids),
      keepSource,
      verb: 'flowed along a curve',
      output,
      plan: (target): DeformPlan | Refusal => {
        const entity = doc.entities[targetId];
        if (entity?.kind !== 'nurbs_curve')
          return {
            code: 'DEF_CURVE_NOT_FOUND',
            message: entity === undefined ? `curve '${targetId}' not found` : `'${targetId}' is a ${entity.kind}, not a nurbs_curve`,
            paths: ['params.targetId'],
          };
        const resolved = resolveTargetFrame(target, frame, 'start');
        if ('code' in resolved) return resolved;
        const local = resolveFrame(resolved.frame);
        if (local === null) return { code: 'DEF_FRAME_DEGENERATE', message: 'the frame is degenerate', paths: ['params.frame'] };
        const { extent } = resolved;
        const tolerance = output?.tolerance ?? defaultTolerance(target.diagonal);
        const lateral = Math.max(...[extent.min[0], extent.max[0], extent.min[1], extent.max[1]].map(Math.abs));
        const curve = worldCurveOf(entity);
        const law = buildFlowLaw(curve, {
          z0: extent.min[2],
          baseLength: extent.max[2] - extent.min[2],
          stretch,
          orientation,
          up,
          tolerance,
          lateral,
          initialNormal: firstNormal(local.x, curve),
        });
        if (typeof law === 'string')
          return {
            code: 'DEF_CURVE_INVALID',
            message:
              law === 'UP_PARALLEL'
                ? 'the up vector is parallel to the curve tangent somewhere: choose another up vector or orientation "minimal"'
                : `curve '${targetId}' has zero length or a zero tangent`,
            paths: [law === 'UP_PARALLEL' ? 'params.up' : 'params.targetId'],
          };
        return { law, frame: resolved.frame, extent, defaulted: resolved.defaulted };
      },
    }),
});

/** The first normal of a rotation-minimising frame: the body x direction projected perpendicular to the curve tangent at its start (else any perpendicular). */
function firstNormal(x: Vec3, curve: Parameters<typeof worldCurveOf>[0]['curve']): Vec3 {
  const first = curve.poles[0] as Vec3;
  const second = curve.poles.find((pole) => len3(sub3(pole, first)) > 0) ?? ([first[0] + 1, first[1], first[2]] as Vec3);
  const tangent = normalize3(sub3(second, first));
  const across = sub3(x, scale3(tangent, dot3(x, tangent)));
  if (len3(across) > 1e-9) return normalize3(across);
  return normalize3(cross3(tangent, Math.abs(tangent[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
}

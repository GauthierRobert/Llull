/** deform_by_point — push the surface of a solid out or in around a point with a smooth falloff (01 DEF M3, FR-DEF-16, SOLIDWORKS Deform Point / CATIA Bump). */

import type { Vec3 } from '../../model/types';
import { foldLimit, maxSlope } from '../../geometry/deform/pointPush';
import { len3, normalize3 } from '../../lib/vec3';
import { defineCommand, vec3, z } from '../schema';
import type { CommandResult } from '../types';
import { bodyParams, outputParam, targetIds } from './schema';
import type { DeformPlan } from './request';
import { runDeform } from './run';
import { type Refusal, resolveTargetFrame } from './target';

/**
 * @affects replaces the entity by a mesh entity whose brep recipe is a deform node with a point law
 * @invariant the displacement is distance x direction at point and zero at and beyond radius; det J = 1 + distance (direction . grad falloff), so the push
 *   folds the body from |distance| >= radius / max|falloff'| (smooth_c2: 25 sqrt(5) radius / 96 = 0.5823 radius); a push along the normal of a face that the support sphere
 *   cuts in a full disk changes the volume by distance x pi x radius^2 / 4; kernel-optional: exact warp on the native kernel, mesh path otherwise
 * @failure distance 0 -> DEF_NO_EFFECT; radius <= 0 -> DEF_REGION_INVALID; direction 0 -> DEF_FRAME_DEGENERATE; the support sphere misses the body -> DEF_REGION_MISSES_BODY; |distance| at or above the limit -> DEF_FOLDOVER
 */
export const deformByPoint = defineCommand({
  name: 'deform_by_point',
  annotations: { readsMeshTriangles: true },
  description:
    'Push the material of a 3D solid or mesh around a point: every point within radius of `point` moves along `direction` by distance x falloff(r), where r = ' +
    '(distance from `point`) / radius and the falloff is 1 at the point and 0 at and beyond radius (smooth_c2 = (1 - r^2)^3, curvature-continuous, the default; cubic = 1 - 3r^2 + 2r^3). ' +
    'Use it for local bumps, dents and fit adjustments. distance is signed (document units, positive moves along direction), radius is the support (document units); ' +
    'the push is a smooth space map, so a bump on a face rises and the material around it follows. The push folds the body once |distance| reaches ' +
    'radius / max|falloff slope| (smooth_c2: 0.5823 x radius; cubic: 0.6667 x radius): the call is then refused with the limit (DEF_FOLDOVER). ' +
    'Pushing along the normal of a flat face whose full disk of radius lies on the face changes the volume by distance x pi x radius^2 / 4. ' +
    'The result replaces the entity as a mesh entity that keeps the construction (brep recipe). Refuses distance 0 (DEF_NO_EFFECT), a non-positive radius (DEF_REGION_INVALID), ' +
    'a zero direction (DEF_FRAME_DEGENERATE) and a point whose support sphere misses the body (DEF_REGION_MISSES_BODY). Then call analyze_deformation and check_deformation.',
  params: z.object({
    ...bodyParams,
    point: vec3('Centre of the push, a world point in document units (the displacement is largest here).'),
    direction: vec3('Direction of the push, unitless; any non-zero vector (normalised). For a bump on a face use its outward normal.'),
    distance: z
      .number()
      .describe(
        'Displacement at the centre along direction, document units; negative pushes the other way. Must be below the fold limit (see the description).',
      ),
    radius: z
      .number()
      .describe('Radius of the support sphere, document units, > 0: nothing moves at or beyond this distance from the point.'),
    falloff: z
      .enum(['smooth_c2', 'cubic'])
      .describe('Profile of the push: "smooth_c2" (default, (1 - r^2)^3, C2 at the support boundary) or "cubic" (1 - 3r^2 + 2r^3, C1).')
      .optional(),
    output: outputParam.optional(),
  }),
  run: (doc, { id, ids, keepSource, point, direction, distance, radius, falloff = 'smooth_c2', output }, ctx): CommandResult =>
    runDeform(doc, ctx, {
      command: 'deform_by_point',
      ids: targetIds(id, ids),
      keepSource,
      verb: 'pushed',
      output,
      plan: (target): DeformPlan | Refusal => {
        if (distance === 0) return { code: 'DEF_NO_EFFECT', message: 'distance is 0', paths: ['params.distance'] };
        if (!(radius > 0)) return { code: 'DEF_REGION_INVALID', message: `radius ${radius} must be > 0`, paths: ['params.radius'] };
        if (len3(direction) === 0)
          return { code: 'DEF_FRAME_DEGENERATE', message: 'direction is the zero vector', paths: ['params.direction'] };
        const resolved = resolveTargetFrame(target, { origin: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0] }, 'centre');
        if ('code' in resolved) return resolved;
        const { extent } = resolved;
        const reaches = ([0, 1, 2] as const).every((a) => point[a] - radius < extent.max[a] && point[a] + radius > extent.min[a]);
        if (!reaches)
          return {
            code: 'DEF_REGION_MISSES_BODY',
            message: `the support sphere (centre [${point.join(', ')}], radius ${radius}) does not meet the body`,
            paths: ['params.point'],
          };
        const law = { kind: 'point' as const, center: point as Vec3, direction: normalize3(direction), distance, radius, falloff };
        const limit = foldLimit(law);
        if (Math.abs(distance) >= limit)
          return {
            code: 'DEF_FOLDOVER',
            message: `|distance| ${Math.abs(distance)} must stay below ${limit.toPrecision(7)} (radius / ${maxSlope(law).toPrecision(5)}): the push would fold the body (min det J ${(1 - (Math.abs(distance) * maxSlope(law)) / radius).toPrecision(5)})`,
            paths: ['params.distance'],
          };
        return { law, frame: resolved.frame, extent, defaulted: [] };
      },
    }),
});

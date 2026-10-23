/** twist_body — rotate the cross-sections of a solid progressively about an axis (01 DEF M1, FR-DEF-02). */

import { defineCommand, z } from '../schema';
import type { CommandResult } from '../types';
import { frameParam, idParam, outputParam, regionParam } from './schema';
import { type DeformPlan, runDeform } from './run';
import { type Refusal, resolveRegion, resolveTargetFrame } from './target';

/**
 * @affects replaces the entity by a mesh entity whose brep recipe is a deform node with a twist law
 * @invariant det J = 1: volume unchanged, every cross-section keeps its shape and is rotated by angle × ramp(z); kernel-optional: mesh path
 *   on Manifold and without a kernel (the native kernel builds only affine maps today and takes the mesh path in "auto")
 * @failure unknown id / unsupported kind -> DEF_ENTITY_NOT_FOUND / DEF_TARGET_UNSUPPORTED; angle 0 -> DEF_NO_EFFECT; bad frame / region -> DEF_FRAME_DEGENERATE / DEF_REGION_INVALID / DEF_REGION_MISSES_BODY
 */
export const twistBody = defineCommand({
  name: 'twist_body',
  annotations: { readsMeshTriangles: true },
  description:
    'Twist a 3D solid or mesh about an axis: each cross-section perpendicular to the axis is rotated by angleDeg times a ramp that goes from 0 at region.start ' +
    'to 1 at region.end (past the end the body keeps the full rotation). Volume is unchanged. Use it for twisted bars, drill flutes, blades, balusters. ' +
    'angleDeg is in degrees (positive = counter-clockwise looking down the axis toward the origin). The frame, region and tolerance default from the body ' +
    '(axis = longest direction, region = the whole body, falloff "smooth"); the defaults used are reported in data.frame. ' +
    'The result replaces the entity as a mesh entity that keeps the construction (brep recipe); the mesh is refined until the chordal deviation is within output.tolerance. ' +
    'Refuses angle 0 (DEF_NO_EFFECT) and regions that miss the body (DEF_REGION_MISSES_BODY). Then call analyze_deformation and check_deformation.',
  params: z.object({
    id: idParam,
    angleDeg: z.number().describe('Total rotation reached at region.end, degrees; any non-zero value (360 and more are allowed).'),
    frame: frameParam.optional(),
    region: regionParam.optional(),
    output: outputParam.optional(),
  }),
  run: (doc, { id, angleDeg, frame, region, output }, ctx): CommandResult =>
    runDeform(doc, ctx, {
      command: 'twist_body',
      id,
      verb: 'twisted',
      output,
      plan: (target): DeformPlan | Refusal => {
        if (angleDeg === 0) return { code: 'DEF_NO_EFFECT', message: 'angleDeg is 0', paths: ['params.angleDeg'] };
        const resolved = resolveTargetFrame(target, frame, 'centre');
        if ('code' in resolved) return resolved;
        const span = resolveRegion(resolved.extent, region);
        if ('code' in span) return span;
        return {
          law: { kind: 'twist', angleRad: (angleDeg * Math.PI) / 180 },
          frame: resolved.frame,
          region: span,
          extent: resolved.extent,
          defaulted: resolved.defaulted,
        };
      },
    }),
});

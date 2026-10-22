/** taper_body — scale the cross-sections of a solid progressively along an axis (01 DEF M1, FR-DEF-03). */

import { defineCommand, z } from '../schema';
import type { CommandResult } from '../types';
import { frameParam, idParam, outputParam, regionParam } from './schema';
import { type DeformPlan, runDeform } from './run';
import { type Refusal, resolveRegion, resolveTargetFrame } from './target';

/**
 * @affects replaces the entity by a mesh entity whose brep recipe is a deform node with a taper law
 * @invariant det J = s(z)² (s(z) when flat): sections stay similar; a cylinder tapered linearly is a cone frustum; kernel-optional (mesh path today)
 * @failure unknown id / unsupported kind -> DEF_ENTITY_NOT_FOUND / DEF_TARGET_UNSUPPORTED; scaleEnd <= 0 -> DEF_TAPER_DEGENERATE; scaleEnd 1 -> DEF_NO_EFFECT; bad frame / region -> DEF_FRAME_DEGENERATE / DEF_REGION_INVALID / DEF_REGION_MISSES_BODY
 */
export const taperBody = defineCommand({
  name: 'taper_body',
  description:
    'Taper a 3D solid or mesh along an axis: each cross-section is scaled about the axis by 1 + (scaleEnd - 1) times a ramp that goes from 0 at region.start ' +
    'to 1 at region.end; past the end the body keeps scale scaleEnd. scaleEnd is unitless and > 0 (0.5 halves the end section, 2 doubles it). ' +
    'With flat true only the frame x direction is scaled (a wedge-like taper). Use it for tapered handles, pins, nozzles, columns. ' +
    'The frame, region and tolerance default from the body (axis = longest direction, region = the whole body, falloff "smooth"); the defaults used are reported in data.frame. ' +
    'The result replaces the entity as a mesh entity that keeps the construction (brep recipe). ' +
    'Refuses scaleEnd <= 0 (DEF_TAPER_DEGENERATE) and scaleEnd 1 (DEF_NO_EFFECT). Then call analyze_deformation and check_deformation.',
  params: z.object({
    id: idParam,
    scaleEnd: z.number().describe('Section scale reached at region.end, unitless, > 0 (1 = no change).'),
    flat: z.boolean().describe('true: scale only along the frame x direction (flat taper); default false scales x and y.').optional(),
    frame: frameParam.optional(),
    region: regionParam.optional(),
    output: outputParam.optional(),
  }),
  run: (doc, { id, scaleEnd, flat, frame, region, output }, ctx): CommandResult =>
    runDeform(doc, ctx, {
      command: 'taper_body',
      id,
      verb: 'tapered',
      output,
      plan: (target): DeformPlan | Refusal => {
        if (!(scaleEnd > 0))
          return { code: 'DEF_TAPER_DEGENERATE', message: `scaleEnd ${scaleEnd} must be > 0`, paths: ['params.scaleEnd'] };
        if (scaleEnd === 1) return { code: 'DEF_NO_EFFECT', message: 'scaleEnd is 1', paths: ['params.scaleEnd'] };
        const resolved = resolveTargetFrame(target, frame, 'centre');
        if ('code' in resolved) return resolved;
        const span = resolveRegion(resolved.extent, region);
        if ('code' in span) return span;
        return {
          law: { kind: 'taper', scaleEnd, flat: flat === true },
          frame: resolved.frame,
          region: span,
          extent: resolved.extent,
          defaulted: resolved.defaulted,
        };
      },
    }),
});

/** stretch_body — lengthen (or shorten) a region of a solid along an axis (01 DEF M1, FR-DEF-04). */

import { defineCommand, vec3, z } from '../schema';
import type { CommandResult } from '../types';
import { bodyParams, infiniteParam, outputParam, targetIds } from './schema';
import type { DeformPlan } from './request';
import { runDeform } from './run';
import { type Refusal, resolveRegion, resolveTargetFrame } from './target';

/**
 * @affects replaces the entity by a mesh entity whose brep recipe is a deform node (stretch law, or an affine law for preserveVolume)
 * @invariant det J = factor inside the region and 1 outside (the part past the region end is translated); region.infinite: z' = start + factor (z - start) and det J = factor at every height; preserveVolume is the whole-body
 *   affine map diag(1/√f, 1/√f, f) with det 1; kernel-optional: exact on the native kernel (preserveVolume as a GTransform, a region stretch as the exact warp), mesh path on Manifold and without a kernel
 * @failure unknown id / unsupported kind -> DEF_ENTITY_NOT_FOUND / DEF_TARGET_UNSUPPORTED; factor <= 0 -> DEF_STRETCH_FACTOR; factor 1 -> DEF_NO_EFFECT; preserveVolume with a region -> DEF_PRESERVE_VOLUME_REGION
 */
export const stretchBody = defineCommand({
  name: 'stretch_body',
  annotations: { readsMeshTriangles: true },
  description:
    'Stretch a 3D solid or mesh along an axis: inside the region the length is multiplied by factor (unitless, > 0; 1.5 lengthens by half, 0.5 halves); ' +
    'the part past region.end is translated rigidly, the part before region.start is unchanged, so features outside the region keep their shape. ' +
    'Volume grows by (factor - 1) times the volume inside the region. With preserveVolume true the whole body is stretched along the axis and shrunk ' +
    'across it by 1/sqrt(factor) so its volume is unchanged (no region allowed). The frame and region default from the body (axis = longest direction, region = the whole body). ' +
    'region.start and region.end are document units from the frame origin, which defaults to the body centre (so a 100-long body spans -50..50 by default). ' +
    'The result replaces the entity as a mesh entity that keeps the construction (brep recipe). ' +
    'With region.infinite true the stretch is a uniform scale of the whole body along the axis about region.start (z -> start + factor (z - start), no rigid part, region.end is not used). ' +
    'Refuses factor <= 0 (DEF_STRETCH_FACTOR) and factor 1 (DEF_NO_EFFECT). Then call analyze_deformation and check_deformation.',
  params: z.object({
    ...bodyParams,
    factor: z.number().describe('Length multiplier inside the region, unitless, > 0 (1 = no change).'),
    preserveVolume: z
      .boolean()
      .describe(
        'true: stretch the whole body along the axis by factor and scale it across by 1/sqrt(factor) (volume unchanged); not allowed with region.',
      )
      .optional(),
    frame: z
      .object({
        origin: vec3('Frame origin, a world point in document units. Default: the body bounding-box centre.').optional(),
        axis: vec3('Stretch direction, unitless (normalised). Default: the longest bounding-box direction.').optional(),
        reference: vec3(
          'Direction giving the frame x axis, unitless; must not be parallel to axis. Default: the next longest direction.',
        ).optional(),
      })
      .describe('Stretch frame; every field defaults from the body bounds and the defaults used are reported in data.frame.')
      .optional(),
    region: z
      .object({
        start: z
          .number()
          .describe('Region start along the axis, document units from the frame origin. Default: where the body starts.')
          .optional(),
        end: z
          .number()
          .describe('Region end along the axis, document units from the frame origin; must exceed start. Default: where the body ends.')
          .optional(),
        infinite: infiniteParam(
          'region.start is the fixed point (z -> start + factor (z - start) for every z); region.end is not used by the map but must still exceed start.',
        ),
      })
      .describe(
        'Part of the body along the axis that is stretched (a step: full stretch inside, none outside). Default: the whole body. With infinite true the whole axis is stretched about start.',
      )
      .optional(),
    output: outputParam.optional(),
  }),
  run: (doc, { id, ids, keepSource, factor, preserveVolume, frame, region, output }, ctx): CommandResult =>
    runDeform(doc, ctx, {
      command: 'stretch_body',
      ids: targetIds(id, ids),
      keepSource,
      verb: 'stretched',
      output,
      plan: (target): DeformPlan | Refusal => {
        if (!(factor > 0)) return { code: 'DEF_STRETCH_FACTOR', message: `factor ${factor} must be > 0`, paths: ['params.factor'] };
        if (factor === 1) return { code: 'DEF_NO_EFFECT', message: 'factor is 1', paths: ['params.factor'] };
        if (preserveVolume === true && region !== undefined)
          return { code: 'DEF_PRESERVE_VOLUME_REGION', message: 'preserveVolume stretches the whole body', paths: ['params.region'] };
        const resolved = resolveTargetFrame(target, frame, 'centre');
        if ('code' in resolved) return resolved;
        if (preserveVolume === true) {
          const across = 1 / Math.sqrt(factor);
          return {
            law: {
              kind: 'affine',
              matrix: [
                [across, 0, 0],
                [0, across, 0],
                [0, 0, factor],
              ],
              translation: [0, 0, 0],
            },
            frame: resolved.frame,
            extent: resolved.extent,
            defaulted: resolved.defaulted,
          };
        }
        const span = resolveRegion(resolved.extent, region, 'none');
        if ('code' in span) return span;
        return {
          law: { kind: 'stretch', factor },
          frame: resolved.frame,
          region: { ...span, falloff: 'none' },
          extent: resolved.extent,
          defaulted: resolved.defaulted,
        };
      },
    }),
});

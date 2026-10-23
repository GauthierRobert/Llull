/** scale_nonuniform — per-axis scale of a solid, exact on the native kernel (01 DEF M1, FR-DEF-01). */

import type { Vec3 } from '../../model/types';
import { dot3, normalize3 } from '../../lib/vec3';
import { defineCommand, vec3, z } from '../schema';
import type { CommandResult } from '../types';
import { outputParam, idParam } from './schema';
import { type DeformPlan, runDeform } from './run';
import { type Refusal, resolveTargetFrame } from './target';

const IDENTITY: Vec3 = [1, 1, 1];

const WORLD_AXES: readonly Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/** The first world axis that is not parallel to `axis` (the frame x direction when no reference is given). */
function defaultReference(axis: Vec3): Vec3 {
  const unit = normalize3(axis);
  return WORLD_AXES.find((candidate) => Math.abs(dot3(candidate, unit)) < 0.99) ?? [1, 0, 0];
}

/**
 * @affects replaces the entity by a mesh entity whose brep recipe is a deform node with an affine law
 * @invariant volume × |sx sy sz|; a negative product mirrors the body and keeps the faces outward; kernel-optional: the native kernel builds it
 *   exactly (no approximation), Manifold and the no-kernel path scale the triangles
 * @failure unknown id / 2D / curve / sheet / instance -> DEF_ENTITY_NOT_FOUND / DEF_TARGET_UNSUPPORTED; a factor 0 -> DEF_SCALE_SINGULAR; all factors 1 -> DEF_NO_EFFECT
 */
export const scaleNonuniform = defineCommand({
  name: 'scale_nonuniform',
  annotations: { readsMeshTriangles: true },
  description:
    'Scale a 3D solid or mesh by a different factor on each axis (a sphere becomes an ellipsoid, a cylinder an elliptic cylinder). ' +
    'factors are unitless multipliers along the frame x, y, z axes (default: world x, y, z) about center (default: the body bounding-box centre). ' +
    'A negative factor mirrors the body about that axis plane (a true mirror: the faces stay outward). Volume is multiplied by |sx sy sz|. ' +
    'Exact on the native kernel (no approximation: curved faces become B-splines); on the mesh kernel or without a kernel the triangles are scaled. ' +
    'The entity is replaced by a mesh entity that keeps the construction (brep recipe). Refuses a zero factor (DEF_SCALE_SINGULAR) and factors all equal to 1 (DEF_NO_EFFECT). ' +
    'For one factor on all axes use scale_entity. Then call analyze_deformation and check_deformation.',
  params: z.object({
    id: idParam,
    factors: vec3('Scale factors [sx, sy, sz], unitless, along the frame x, y, z axes. Negative mirrors that axis; 0 is refused.'),
    center: vec3('Fixed point of the scale, a world point in document units. Default: the body bounding-box centre.').optional(),
    frame: z
      .object({
        axis: vec3('Direction of the frame z axis, unitless (normalised). Default [0, 0, 1].').optional(),
        reference: vec3(
          'Direction giving the frame x axis, unitless; must not be parallel to axis. Default: the first world axis not parallel to axis ([1, 0, 0] for the default axis).',
        ).optional(),
      })
      .describe('Axes the factors act along; default the world axes.')
      .optional(),
    output: outputParam.optional(),
  }),
  run: (doc, { id, factors, center, frame, output }, ctx): CommandResult =>
    runDeform(doc, ctx, {
      command: 'scale_nonuniform',
      id,
      verb: 'scaled',
      output,
      plan: (target): DeformPlan | Refusal => {
        const singular = factors.findIndex((factor) => factor === 0);
        if (singular >= 0)
          return {
            code: 'DEF_SCALE_SINGULAR',
            message: `factor ${singular} is 0: the body would collapse`,
            paths: [`params.factors.${singular}`],
          };
        if (factors.every((factor, axis) => factor === IDENTITY[axis]))
          return { code: 'DEF_NO_EFFECT', message: 'all factors are 1', paths: ['params.factors'] };
        const resolved = resolveTargetFrame(
          target,
          { origin: center, axis: frame?.axis ?? [0, 0, 1], reference: frame?.reference ?? defaultReference(frame?.axis ?? [0, 0, 1]) },
          'centre',
        );
        if ('code' in resolved) return resolved;
        const [sx, sy, sz] = factors;
        return {
          law: {
            kind: 'affine',
            matrix: [
              [sx, 0, 0],
              [0, sy, 0],
              [0, 0, sz],
            ],
            translation: [0, 0, 0],
          },
          frame: resolved.frame,
          extent: resolved.extent,
          defaulted: resolved.defaulted.filter((name) => name === 'origin'),
        };
      },
    }),
});

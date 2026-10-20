/** Per-edge fillet laws (SC-F3): the parameter schema of one edge entry, radius-law checks and the chord <-> radius conversion. */

import type { EdgeRadius, Vec3 } from '../../model/types';
import { dot3 } from '../../lib/vec3';
import { vec3, z } from '../schema';

export const FILLET_MODES = ['radius', 'chord'] as const;
export type FilletMode = (typeof FILLET_MODES)[number];

export const edgeLawSchema = z
  .object({
    index: z
      .number()
      .int()
      .nonnegative()
      .describe('0-based unique-edge index (inspect_topology). Give exactly one of index or near.')
      .optional(),
    near: vec3(
      'A point [x, y, z] on or near the edge (the roundable edge nearest to it is taken). Give exactly one of index or near.',
    ).optional(),
    size: z.number().describe('Radius at the START of the edge (document units, > 0); in mode "chord" the chord length instead.'),
    sizeEnd: z
      .number()
      .describe(
        'Optional radius at the END of the edge (> 0); the radius varies linearly from size to sizeEnd. Omit for a constant radius.',
      )
      .optional(),
    sizes: z
      .array(
        z.object({
          t: z.number().describe('Position along the edge, strictly inside (0, 1), increasing.'),
          size: z.number().describe('Radius at t (> 0).'),
        }),
      )
      .describe('Optional interior control points the radius passes through (variable-radius law); needs a kernel that reads radius laws.')
      .optional(),
  })
  .describe('One edge with its own radius law.');

export type EdgeLawInput = z.infer<typeof edgeLawSchema>;

/** Why `law` is not a usable radius law (sizes must be > 0 and finite; interior t strictly increasing inside (0, 1)), or null. */
export function lawProblem(law: EdgeRadius): string | null {
  const positive = (value: number): boolean => Number.isFinite(value) && value > 0;
  if (!positive(law.size)) return `size must be > 0 (got ${law.size})`;
  if (law.sizeEnd !== undefined && !positive(law.sizeEnd)) return `sizeEnd must be > 0 (got ${law.sizeEnd})`;
  let previous = 0;
  for (const point of law.sizes ?? []) {
    if (!(point.t > previous) || !(point.t < 1)) return 'sizes need t strictly increasing inside (0, 1)';
    if (!positive(point.size)) return `sizes size must be > 0 (got ${point.size})`;
    previous = point.t;
  }
  return null;
}

/** `law` without the edge selector fields. */
export function lawOf(input: EdgeLawInput): EdgeRadius {
  return {
    size: input.size,
    ...(input.sizeEnd === undefined ? {} : { sizeEnd: input.sizeEnd }),
    ...(input.sizes === undefined || input.sizes.length === 0 ? {} : { sizes: input.sizes }),
  };
}

/** Angle (radians) between the two face planes of an edge, measured in the wedge the fillet sits in: pi - acos(n1 . n2) of the outward unit normals. */
export function wedgeAngle(normalA: Vec3, normalB: Vec3): number {
  const cosine = Math.max(-1, Math.min(1, dot3(normalA, normalB)));
  return Math.PI - Math.acos(cosine);
}

/**
 * Fillet radius whose tangent points are `chord` apart on two planar faces meeting at `wedge`: the tangent points lie r / tan(wedge / 2) from
 * the edge, so chord = 2 r cos(wedge / 2) and r = chord / (2 cos(wedge / 2)).
 * @failure wedge outside (0, pi) -> NaN
 */
export function chordToRadius(chord: number, wedge: number): number {
  return wedge > 0 && wedge < Math.PI ? chord / (2 * Math.cos(wedge / 2)) : Number.NaN;
}

/** `law` with every size multiplied by `factor` (chord -> radius conversion keeps the law's shape). */
export function scaleLaw(law: EdgeRadius, factor: number): EdgeRadius {
  return {
    size: law.size * factor,
    ...(law.sizeEnd === undefined ? {} : { sizeEnd: law.sizeEnd * factor }),
    ...(law.sizes === undefined ? {} : { sizes: law.sizes.map((point) => ({ t: point.t, size: point.size * factor })) }),
  };
}

export const sameLaw = (a: EdgeRadius, b: EdgeRadius): boolean => JSON.stringify(a) === JSON.stringify(b);

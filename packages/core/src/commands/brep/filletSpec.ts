/** Per-edge fillet laws (SC-F3, BLD M1): the parameter schema of one edge entry and the chord <-> radius conversion. */

import type { EdgeRadius, Vec3 } from '../../model/types';
import { dot3 } from '../../lib/vec3';
import { DEFAULT_LAW_SAMPLES, MAX_LAW_SAMPLES, MIN_LAW_SAMPLES } from '../../geometry/blend/law';
import { vec3, z } from '../schema';

const INTERPOLATIONS = ['smooth', 'linear'] as const;

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
      'A point [x, y, z] in document units on or near the edge (the roundable edge nearest to it is taken). Give exactly one of index or near.',
    ).optional(),
    size: z
      .number()
      .describe(
        'Radius at the START of the edge (document units, > 0); in mode "chord" the chord length instead. Give it unless law is given.',
      )
      .optional(),
    sizeEnd: z
      .number()
      .describe(
        'Optional radius at the END of the edge (> 0, document units); the radius goes from size to sizeEnd (kernel smooth transition, flattened at both ends; interpolation "linear" makes it straight). Omit for a constant radius.',
      )
      .optional(),
    sizes: z
      .array(
        z.object({
          t: z
            .number()
            .describe('Relative position along the picked edge (0 = its start, 1 = its end), strictly inside (0, 1), increasing.'),
          size: z.number().describe('Radius at t (> 0), document units.'),
        }),
      )
      .describe('Optional interior control points the radius passes through (variable-radius law); needs a kernel that reads radius laws.')
      .optional(),
    size2: z
      .number()
      .describe(
        'Asymmetric blend: the leg on the face NOT named by side1Near / side1Name (document units, > 0); size is then the leg on side 1. Needs a straight edge between two planar faces (BLD_PROFILE_FAILED otherwise); the section is the elliptic quarter of the circle unless profile says otherwise.',
      )
      .optional(),
    side1Near: vec3('With size2: a point [x, y, z] in document units on the face that carries size (side 1).').optional(),
    side1Name: z.string().min(1).describe('With size2: persistent face name of side 1 (alternative to side1Near).').optional(),
    interpolation: z
      .enum(INTERPOLATIONS)
      .describe(
        'How the radius runs between the control points: "smooth" (default: one smooth curve through them, the kernel interpolation) or "linear" (straight transitions between consecutive points).',
      )
      .optional(),
    law: z
      .object({
        expression: z
          .string()
          .min(1)
          .describe(
            'Radius as an expression of t in [0, 1] (document units), e.g. "1 + 0.5*cos(2*pi*t)". Only t, pi, tau and the built-in functions are allowed; it must be > 0 at every sample.',
          ),
        samples: z
          .number()
          .int()
          .describe(
            `Number of uniform samples of t in [0, 1] the kernel receives (${MIN_LAW_SAMPLES}..${MAX_LAW_SAMPLES}). Default ${DEFAULT_LAW_SAMPLES}.`,
          )
          .optional(),
      })
      .describe('Expression law r(t) instead of size / sizeEnd / sizes. On a closed edge (a rim) r(0) must equal r(1) (periodic law).')
      .optional(),
  })
  .describe('One edge with its own radius law.');

export type EdgeLawInput = z.infer<typeof edgeLawSchema>;

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

export const sameLaw = (a: EdgeRadius, b: EdgeRadius): boolean => JSON.stringify(a) === JSON.stringify(b);

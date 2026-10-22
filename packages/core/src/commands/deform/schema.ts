/** Shared schema fragments of the deformation commands (01 DEF §4): frame, region, output. Every property carries an agent-facing description with its unit. */

import { vec3, z } from '../schema';

export const frameParam = z
  .object({
    origin: vec3(
      'Frame origin, a world point in document units. Default: the body bounding-box centre (the bend uses the centre of the face at the start of the body).',
    ).optional(),
    axis: vec3(
      'Deformation axis, any non-zero direction (unitless; normalised). Default: the longest bounding-box direction (a world axis, ties: x before y before z).',
    ).optional(),
    reference: vec3(
      'Direction giving the frame x axis, unitless: its component perpendicular to the axis is used; it must not be parallel to the axis. Default: the next longest bounding-box direction.',
    ).optional(),
  })
  .describe(
    'Deformation frame: local z = axis, x = reference projected perpendicular to the axis, y = z cross x; regions and radii are measured from the origin along it. Every field is optional and defaults from the body bounds; the defaults used are reported in data.frame.defaulted.',
  );

export const regionParam = z
  .object({
    start: z
      .number()
      .describe(
        'Region start along the frame axis, document units from the frame origin (may be negative). Default: where the body starts.',
      )
      .optional(),
    end: z
      .number()
      .describe('Region end along the frame axis, document units from the frame origin; must exceed start. Default: where the body ends.')
      .optional(),
    falloff: z
      .enum(['smooth', 'linear'])
      .describe(
        'How the effect ramps from none at start to full at end: "smooth" (default, 3t^2 - 2t^3, no crease at the region ends) or "linear" (straight ramp; leaves a visible crease at both ends).',
      )
      .optional(),
  })
  .describe(
    'Part of the body along the frame axis where the effect ramps in. Past the end the body follows rigidly (carries the end transform); before the start it is unchanged. Default: the whole body.',
  );

export const outputParam = z
  .object({
    mode: z
      .enum(['auto', 'exact', 'mesh'])
      .describe(
        '"auto" (default): the exact kernel builds the result when it can evaluate this deformation (the native kernel does for affine maps), else the mesh path runs and the summary says so; "exact": refuse (DEF_EXACT_UNAVAILABLE) unless the exact kernel built it; "mesh": force the faceted mesh path.',
      )
      .optional(),
    tolerance: z
      .number()
      .describe(
        'Largest chordal deviation of the mesh path from the true deformed surface, document units, > 0. Default: 1e-5 times the body bounding-box diagonal, clamped to [1e-6, 0.01].',
      )
      .optional(),
    preserveAnalytic: z
      .boolean()
      .describe(
        'Recognise cylinders, cones and planes in an exact result (needs the exact warp of a later milestone; true is refused today).',
      )
      .optional(),
  })
  .describe('How the result is computed: kernel choice and mesh tolerance.');

export const idParam = z
  .string()
  .describe('Id of the 3D solid or mesh entity to deform (describe_scene lists ids). It is replaced by the deformed mesh entity.');

export const NEXT_STEP =
  'Then call analyze_deformation (Jacobian, volume check, fibre lengths) and check_deformation (pass / warn / fail verdict) on the result.';

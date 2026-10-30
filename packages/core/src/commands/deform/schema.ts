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

/** `region.infinite` (01 DEF §17.1): the shared lead, then the wording of the command's own region fields. */
export const infiniteParam = (detail: string): z.ZodOptional<z.ZodBoolean> =>
  z
    .boolean()
    .describe(
      `true: infinite region. The effect holds along the WHOLE axis and keeps going beyond both region ends at the same rate: nothing is rigid, nothing is unchanged, and there is no crease. ${detail} Default false.`,
    )
    .optional();

const RAMP_INFINITE =
  'region.start and region.end only fix the RATE (the full effect per end - start of length). The ramp is linear: falloff "smooth" is refused with DEF_REGION_INVALID.';

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
    infinite: infiniteParam(RAMP_INFINITE),
  })
  .describe(
    'Part of the body along the frame axis where the effect ramps in. Past the end the body follows rigidly (carries the end transform); before the start it is unchanged (with infinite true the effect instead continues along the whole axis at the rate that start and end define). Default: the whole body.',
  );

export const outputParam = z
  .object({
    mode: z
      .enum(['auto', 'exact', 'mesh'])
      .describe(
        '"auto" (default): the exact kernel builds the result when it can evaluate this deformation (the native kernel does for every law: the faces become B-splines fitted within output.tolerance), else the mesh path runs and the summary says so; "exact": refuse (DEF_EXACT_UNAVAILABLE) unless the exact kernel built it; "mesh": force the faceted mesh path.',
      )
      .optional(),
    tolerance: z
      .number()
      .describe(
        'Largest deviation of the result from the true deformed surface, document units, > 0: the chordal deviation of the mesh path, or the fit error of the B-spline faces and edges on the exact path (a smaller value costs control points, not accuracy). Default: 1e-5 times the body bounding-box diagonal, clamped to [1e-6, 0.01].',
      )
      .optional(),
    allowMeshFallback: z
      .boolean()
      .describe(
        'Mode "auto" only: when the exact kernel refuses this deformation (approximation above output.tolerance, kernel failure), true (default) answers with the faceted mesh path and names the refusal in the summary and data.exactRefused; false refuses with that code instead, so an exact body never becomes a mesh. Folds (DEF_FOLDOVER) always refuse.',
      )
      .optional(),
    preserveAnalytic: z
      .boolean()
      .describe(
        'true: after the exact warp, faces that are still a plane, cylinder, cone or sphere within the tolerance (a taper of a cylinder is a cone, a twist about its axis leaves it a cylinder) are stored as analytic faces again, and the data reports how many of each. Needs the exact path (native kernel): mesh mode or a mesh kernel is refused DEF_EXACT_UNAVAILABLE. Default false.',
      )
      .optional(),
  })
  .describe('How the result is computed: kernel choice and mesh tolerance.');

export const idParam = z
  .string()
  .describe(
    'Id of the 3D solid or mesh entity to deform (describe_scene lists ids). It is replaced by the deformed mesh entity (keepSource keeps it).',
  );

export const NEXT_STEP =
  'Then call analyze_deformation (Jacobian, volume check, fibre lengths) and check_deformation (pass / warn / fail verdict) on the result.';

export const idsParam = z
  .array(z.string())
  .min(1)
  .max(100)
  .describe(
    'Ids of several 3D solids or meshes to deform with the same parameters (one feature step; every body gets its own frame and region defaults from its own bounds). Use this or id.',
  )
  .optional();

export const keepSourceParam = z
  .boolean()
  .describe('true: keep the original entity(ies) next to the deformed one(s) instead of replacing them. Default false.')
  .optional();

/** The three body-selection parameters every deformation command shares: id or ids, and keepSource. */
export const bodyParams = { id: idParam.optional(), ids: idsParam, keepSource: keepSourceParam };

/** The distinct target ids of a call (id first, then ids), empty when none was given. */
export function targetIds(id: string | undefined, ids: readonly string[] | undefined): string[] {
  return [...new Set([...(id === undefined ? [] : [id]), ...(ids ?? [])])];
}

/** Stable refusal codes of the deformation commands (01 DEF TECHNICAL §7.1) and their one-line fixes. */

import { tableRejection } from '../noop';

export const DEF_REMEDIATION: Readonly<Record<string, string>> = {
  DEF_ENTITY_NOT_FOUND: 'Run `llull describe_scene` to list entity ids.',
  DEF_TARGET_UNSUPPORTED: '2D shapes: extrude_profile first; instances: explode_instance first; curves and sheets are not deformed yet.',
  DEF_FRAME_DEGENERATE: 'Give a non-zero axis and a reference direction that is not parallel to it.',
  DEF_REGION_INVALID: 'Give region.end greater than region.start, both finite, in document units from the frame origin.',
  DEF_REGION_MISSES_BODY:
    'The region does not meet the body: analyze_deformation or measure_bounding_box show its extent; move the region.',
  DEF_NO_EFFECT: 'The parameters are the identity (angle 0, factor 1): change them or skip the call.',
  DEF_SCALE_SINGULAR: 'Use a small non-zero factor; a zero factor flattens the body.',
  DEF_TAPER_DEGENERATE: 'scaleEnd must be > 0 (a point apex is not a valid solid face): use a small positive value.',
  DEF_STRETCH_FACTOR: 'factor must be > 0.',
  DEF_PRESERVE_VOLUME_REGION: 'preserveVolume deforms the whole body: drop region, or drop preserveVolume.',
  DEF_BEND_UNDERDETERMINED: 'Give exactly two of radius, angleDeg and length (or region).',
  DEF_BEND_OVERDETERMINED: 'Give exactly two of radius, angleDeg and length (or region): remove one.',
  DEF_BEND_RADIUS_TOO_SMALL:
    'The radius must exceed the distance from the neutral fibre to the body on the centre-of-curvature side: raise radius, or move frame.origin toward that side.',
  DEF_FOLDOVER: 'The map folds the body (det J <= 0): reduce the parameter named in the message.',
  DEF_SELF_INTERSECTION: 'The result would overlap itself: reduce the angle or the extent.',
  DEF_EXACT_UNAVAILABLE:
    'Use mode "auto" (or "mesh"), or run with the native kernel and an affine map (scale_nonuniform, stretch with preserveVolume).',
  DEF_KERNEL_REFUSED: 'The kernel could not build the result: run check_model on the source, or try mode "mesh".',
  DEF_BUDGET_EXCEEDED: 'Raise output.tolerance, or narrow the region: the refined mesh would be too large.',
  DEF_TOLERANCE_INVALID: 'output.tolerance must be finite and > 0, in document units.',
  DEF_NOT_DEFORMED: 'The entity was not produced by a deformation command (no deform node in its recipe).',
  DEF_SOURCE_UNAVAILABLE: 'The source of the deformation cannot be rebuilt here: use a host with the geometry kernel.',
};

export const defRejection = tableRejection(DEF_REMEDIATION);

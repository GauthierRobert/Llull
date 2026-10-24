/** Stable refusal codes of the deformation commands (01 DEF TECHNICAL §7.1) and their one-line fixes. */

import { tableRejection } from '../noop';

export const DEF_REMEDIATION: Readonly<Record<string, string>> = {
  DEF_ENTITY_NOT_FOUND: 'Run `llull describe_scene` to list entity ids.',
  DEF_TARGET_UNSUPPORTED: '2D shapes: extrude_profile first; instances: explode_instance first; a trimmed sheet only under an affine map.',
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
  DEF_LATTICE_DEGREE: 'degrees must be three integers from 1 to 8.',
  DEF_LATTICE_INDEX: 'Name each control point by exactly one of index [i, j, k] (0..degree on each axis) or near (a world point).',
  DEF_LATTICE_FIXED_MOVED:
    'Do not move the control points in the fixed layers next to a lattice face the body crosses (or lower fixedLayers, or enlarge the box).',
  DEF_CURVE_NOT_FOUND: 'targetId must be the id of a nurbs_curve entity (describe_scene lists them).',
  DEF_CURVE_INVALID:
    'The curve has zero length or a zero tangent, or the up vector is parallel to its tangent: use another curve, up vector or orientation "minimal".',
  DEF_FLOW_TARGET_INVALID: 'target must be {sheetId} (a nurbs_surface) or {entityId, faceNear} (a face of a solid with an exact B-rep).',
  DEF_FLOW_OUTSIDE_BASE: 'The body reaches beyond the target surface: move targetOrigin, or shorten or narrow the body.',
  DEF_FLOW_OVERLAP: 'The body is longer than a closed turn of the target: shorten it or use a larger target.',
  DEF_TARGET_FACE_NEEDS_KERNEL: 'Run with the native kernel (llull --kernel occt, the desktop default) or use a sheet target.',
  DEF_CURVE_PAIR_INVALID:
    'Each pair needs an existing nurbs_curve initialId (and targetId); constraints must not coincide with different targets; samples 4..200.',
  DEF_MORPH_INCOMPATIBLE:
    'Both entities must be the same kind with the same degrees, knot vectors and pole grid (or mesh connectivity); a topology change needs implicit modelling.',
  DEF_MORPH_PARAMETER: 't must lie in 0..1.',
  DEF_FOLDOVER: 'The map folds the body (det J <= 0): reduce the parameter named in the message.',
  DEF_SELF_INTERSECTION: 'The result would overlap itself: reduce the angle or the extent.',
  DEF_EXACT_UNAVAILABLE:
    'Use mode "auto" (or "mesh"), or run with the native kernel (it builds twist, taper, stretch, bend and the affine maps exactly).',
  DEF_APPROX_TOLERANCE:
    'The exact fit would need more control points than the budget or cannot reach the tolerance: raise output.tolerance, narrow the region, or use mode "mesh".',
  DEF_KERNEL_REFUSED: 'The kernel could not build the result: run check_model on the source, or try mode "mesh".',
  DEF_BUDGET_EXCEEDED: 'Raise output.tolerance, or narrow the region: the refined mesh would be too large.',
  DEF_TOLERANCE_INVALID: 'output.tolerance must be finite and > 0, in document units.',
  DEF_COMPARE_INVALID:
    'Give every field the reference kind needs (see the compareTo description), with positive radii and a non-zero axis.',
  DEF_NOT_DEFORMED: 'The entity was not produced by a deformation command (no deform node in its recipe).',
  DEF_SOURCE_UNAVAILABLE: 'The source of the deformation cannot be rebuilt here: use a host with the geometry kernel.',
};

export const defRejection = tableRejection(DEF_REMEDIATION);

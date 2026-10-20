/** Stable refusal / finding codes of the composites plugin (06 CMP §7.1, AF-11) with their one-line remediation. */

import { tableRejection } from '@core/commands/noop';

const REMEDIATION: Readonly<Record<string, string>> = {
  CMP_PARAM_INVALID: 'give finite values in the documented units and ranges (see the command description)',
  CMP_NOTATION_PARSE:
    'use [a/b/..] with +-a, a_n, (group)_n, a trailing s (symmetric), Ns, T or ~ (unduplicated middle ply); e.g. [0/+-45/90]s',
  CMP_MATERIAL_NOT_POSITIVE_DEFINITE: 'check nu12 and the E1 / E2 order: nu12^2 must be below E1 / E2',
  CMP_MATERIAL_NOT_POSITIVE: 'enter positive moduli, strengths and thickness (MPa, document length units)',
  CMP_MATERIAL_ALLOWABLE_MISSING: 'add Xt, Xc, Yt, Yc and S from a cited source with create_lamina_material (no default exists)',
  CMP_MATERIAL_DENSITY_MISSING: 'give the lamina density (mass per unit^3) with create_lamina_material',
  CMP_MATERIAL_HYGROTHERMAL_MISSING:
    'add alpha1, alpha2 (thermal) and beta1, beta2 (moisture) to the lamina record from a cited source (no default exists)',
  CMP_CSV_PARSE:
    'use the export_ply_table layout: a header row with ply, material, orientation (and optionally sequence, order, rosette), one ply per row',
  CMP_F12_RANGE: 'use -0.5 or a value in [-1, 0] taken from biaxial test data',
  CMP_ROSETTE_DEGENERATE: 'give a non-zero 0-degree axis and normal that are not parallel',
  CMP_FACE_NOT_FOUND: 'pick a point on the intended face (faceNear), within the tolerance of the face',
  CMP_FACE_AMBIGUOUS: 'pick a point in the interior of the intended face, away from edges',
  CMP_FACE_UNSUPPORTED: 'use a box, cylinder, cone, sphere or nurbs_surface tool, or a plane / cylinder / cone face on the OCC kernel',
  CMP_REF_MISSING: 'create the material, rosette, part, zone or ply first, or fix the id / name (`llull describe_scene`)',
  CMP_NAME_TAKEN: 'use a name that is not used yet in this part (or edit the existing item)',
  CMP_ZONE_BOUNDARY_INVALID: 'give a simple (non self-intersecting) polygon of at least 3 vertices inside the part outline',
  CMP_ZONES_NOT_BLENDABLE: 'edit the thinner zone so its stack embeds in the thicker one (same angles in the same order, symmetric halves)',
  CMP_ZONES_EQUAL_THICKNESS_CONFLICT: 'make the equally thick zones identical or change a ply count',
  CMP_COVER_PLIES_DROPPED: 'keep the outer cover plies continuous: use identical outer plies in every zone or lower coverPlies',
  CMP_OUTLINE_NOT_CONVEX: 'use a convex tool face (box, cylinder or cone cap) for zone ramps, or keep the plies whole-face',
  CMP_RAMP_CONFLICT: 'move the zone boundary, lower the ramp ratio (with a reviewer) or reduce the thickness step',
  CMP_LAMINATE_SINGULAR: 'add plies in other directions (a single angle cannot carry shear or transverse load)',
  CMP_NO_PLIES: 'add plies (add_ply or generate_plies_from_zones) at that point first',
  CMP_POINT_OFF_PART: 'give a point on the tool face of the part (within its outline)',
  CMP_WAIVER_NO_FINDING: 'run check_layup and copy the code and ids of a current finding',
  CMP_FLAT_UNSUPPORTED: 'flat patterns need a plane, cylinder, cone, sphere cap or nurbs_surface tool face',
  CMP_DRAPE_LIMIT_MISSING:
    'add lockingAngle (degrees, from a cited drape test) to the lamina record or pass lockingAngle explicitly (no default exists)',
  CMP_PRODUCIBILITY_OVER_LOCK:
    'split the ply with a dart or splice (split_ply), change its orientation or seed, or set drape.allowOverLock with a reviewer',
  CMP_DRAPE_INCOMPLETE: 'change the seed or stepLength, or split the ply with darts so each piece drapes completely',
  CMP_CUT_INVALID: 'give a path inside the part frame that touches the ply; a splice must cross the ply boundary at both ends',
  CMP_CORE_INVALID: 'give a boundary inside the part outline, a core_honeycomb / core_foam material and thickness > 0',
  CMP_AP242_TOOL_MISSING: 'the tool solid of the part must exist in the document (restore it or rebuild the part on a new tool face)',
  CMP_AP242_NAME_CLASH:
    'give the tool solid and the ply solids distinct names (set_entity_name); delete stale ply solids left by an earlier create_ply_solids',
  CMP_AP242_WRITE_FAILED: 'run on the desktop backend or with --kernel occt-native (the XDE writer is needed), then retry',
  CMP_AP242_SELFCHECK_RED: 'report a defect with the part id; do not deliver the file',
  CMP_AP242_NO_COMPOSITE: 'the file carries no llull composite records: export it with export_composite_ap242 (other systems are not read)',
  CMP_AP242_MALFORMED: 'the composite records of the file are damaged or from a newer llull; re-export the file',
  CMP_AP242_SOLIDS_FAILED: 'import the solids separately with import_step_exact and retry with importSolids false',
  CMP_CORE_UNSUPPORTED: 'sandwich cores are not modelled by this analysis; analyse the skins separately or choose a point outside the core',
};

export const refuseCmp = tableRejection(REMEDIATION);

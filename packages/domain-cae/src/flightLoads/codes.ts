/** Codes of the 14 FLL flight-loads lane and their remediation texts. */

import { tableRejection } from '@core/commands/noop';

const FLL_REMEDIATION: Readonly<Record<string, string>> = {
  FEA_ANALYSIS_NOT_FOUND: 'list the analyses with describe_analysis, or create one with create_analysis',
  FEA_TARGET_UNRESOLVED: 'give an existing 3D part of the analysis and at least one point near the intended topology',
  FEA_PART_NOT_IN_ANALYSIS: 'add the entity first with set_part_idealization',
  FEA_LOAD_INVALID: 'check the mounts (a force or a rotorId + direction, a target on a part of the analysis) and the load case name',
  FLL_ANALYSIS_TYPE: 'flight loads and free-body supports are for a static analysis: create_analysis analysisType static',
  FLL_SCENARIO_UNKNOWN: 'define the scenario with define_flight_scenario (list them with inspect_dynamics)',
  FLL_STATE_INVALID: 'pass referencePoint [x, y, z] (document units): the centre of mass the acceleration refers to',
  FLL_RUN_FAILED: 'fix the flight run first: run_flight on the same scenario gives the refusal',
  FLL_INSTANT_UNKNOWN: 'give a time inside the run (0 .. durationS), peak_load or envelope',
  FLL_MOUNT_INVALID: 'a mount is a name + target + either force [x, y, z] or rotorId + direction (unit vector of the thrust in model axes)',
  FLL_SOURCE_AMBIGUOUS: 'pass either scenario (+ at) or state, not both and not neither',
  FLL_RUN_STALE: 'the design changed after the flight run: re-run export_flight_loads for the same scenario, then re-solve',
  FLL_RELIEF_RESIDUAL:
    'balance the load case: the mounts must carry the rigid-body inertia of the part (sum of mount forces = mass x (a - g) ...) or the supports will take the difference',
  FLL_RELIEF_UNASSESSED:
    'use total-distribution forces with target points and no pressure in a free-body case, and give the parts a material with a density',
  FLL_LOAD_CASE_EXISTS: 'choose another loadCase name',
  FLL_INERTIAL_FIELD_TOO_LARGE:
    'a real angular acceleration needs one CalculiX GRAV line per element: coarsen the mesh below about 30 000 elements, or export the instant as an explicit state without angular acceleration',
  FLL_INERTIAL_UNSUPPORTED: 'inertial flight loads are for static CalculiX analyses: use a static analysis or remove the load',
  FLL_SUPPORT_SINGULAR:
    'give three points that are not collinear and far apart (the supports must remove all six rigid-body motions and nothing more)',
  FLL_SUPPORT_CONFLICT:
    'a free-body support is the only support of its analysis: delete the other constraints (delete_analysis_item) first',
  FLL_NOT_MODAL: 'give a modal analysis (create_analysis analysisType modal), solved',
  FLL_MODAL_UNAVAILABLE:
    'solve the modal analysis (fea_mesh, fea_solve) and re-check; a stale case must be re-solved after the set-up change',
  FLL_NO_MODES: 'the model gave no elastic mode: extract more modes or restrain / unrestrain the model as intended',
  FLL_NO_ROTORS: 'add the rotors of the vehicle with add_rotor (and a controller with add_flight_controller for the rpm band)',
  FLL_ROTOR_UNKNOWN: 'list the rotors with inspect_dynamics (data.flight.rotors)',
  FLL_TRIM_FAILED: 'fix the trim condition (trim_flight gives the refusal) or pass operatingRpm',
  FLL_BAND_INVALID: 'give rpmBand as [low, high] with low <= high, in rev/min',
  FLL_THRESHOLD_SOURCE: 'give marginThresholdPct together with marginSource, or neither (the rows are then unknown)',
  FEA_MATERIAL_MISSING: 'assign a material to the part (assign_material): its Poisson ratio and density are read from it',
  FEA_MATERIAL_NO_ELASTIC:
    'give the material E and nu (property models or an elastic_isotropic constitutive set): its Poisson ratio is read from it',
  FLL_PRINT_CASE_TYPE: 'printed idealization is for static, modal or buckling analyses: use one of those or analyse the part as a solid',
  FLL_PRINT_PARAM:
    'correct the print settings: walls and topBottomLayers integers >= 0, lineWidthMm and layerHeightMm > 0, infill density in (0, 1], a non-zero layerAxis, moduli and strengths > 0 in a stress unit',
  FLL_PRINT_COUPON_MISSING:
    'give coupon { E_xy, E_z, uts_xy, uts_z, source } measured on solid (100 % infill) printed coupons pulled in the build plane (xy) and along the build direction (z), with their source: llull ships no typical printed-part values',
  FLL_PRINT_EXPONENT_MISSING:
    'give infillExponent { value, source } (the exponent m of E_core = E_solid density^m, with where it comes from) or { fitDirection } to fit it from the coupons recorded with record_print_coupon: no default exponent is assumed',
  FLL_PRINT_FIT_POINTS:
    'record at least 2 coupons of that pattern and direction at distinct infill densities (record_print_coupon), densities in (0, 1] and moduli > 0',
  FLL_PRINT_COUPON_EXISTS: 'choose another id, or pass replace: true to overwrite the recorded coupon',
  FLL_PRINT_GEOMETRY: 'give a closed 3D solid part: the skin fraction is measured on its triangles',
  FLL_PRINT_STIFFNESS:
    'the coupon moduli are too far apart for the material Poisson ratio (the orthotropic stiffness is not positive definite): check the coupon values and units',
  FLL_PRINT_ORIENTATION:
    'a printed part owns its material axes: remove the thermo-mechanical orientation (set_material_orientation) of that part',
  MESH_ASSET_LOD_ONLY:
    'the host must hand the deck a full-resolution document (withFullResolution); a printed part cannot be built from its display mesh',
  FLL_PRINT_CONSTITUTIVE:
    'a printed part is linear orthotropic: use a material without plastic, hyperelastic or creep sets, or clear the print idealization',
  FLL_SUPPORT_POINTS: 'the three support points must be finite and at least 1e-6 of their spread apart',
};

/** `codedRejection` with the remediation of `code`. */
export const refuseFll = tableRejection(FLL_REMEDIATION);

/** Remediation of a flight-loads check item. */
export const fllRemediation = (code: string): string => FLL_REMEDIATION[code] ?? 'see the command description';

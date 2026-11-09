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
  FLL_SUPPORT_POINTS: 'the three support points must be finite and at least 1e-6 of their spread apart',
};

/** `codedRejection` with the remediation of `code`. */
export const refuseFll = tableRejection(FLL_REMEDIATION);

/** Remediation of a flight-loads check item. */
export const fllRemediation = (code: string): string => FLL_REMEDIATION[code] ?? 'see the command description';

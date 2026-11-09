/** PHY-05 §7.1 stable codes of the nonlinear lane and their remediation texts. */

import { tableRejection } from '@core/commands/noop';

const REMEDIATION: Readonly<Record<string, string>> = {
  NLS_CASE_NOT_NONLINEAR: 'create the case with create_analysis analysisType=nonlinear_static',
  NLS_CONTROL_INVALID:
    'increments must satisfy 0 < minIncrement <= initialIncrement <= maxIncrement <= 1, maxIncrements >= 1; custom controls > 0',
  NLS_CONTROLS_UNSET: 'call set_nonlinear_controls with an explicit nlgeom (true or false) before adding steps',
  NLS_ARC_LENGTH_UNSUPPORTED:
    'CalculiX has no arc-length / Riks procedure: use displacement control (it passes a load peak) or a frame solver for snap-through',
  NLS_LOAD_CASE_UNKNOWN: 'multipliers may only name load cases of the case loads (add_fea_load loadCase): list them with describe_analysis',
  NLS_STEP_NOT_FOUND: 'list the steps with describe_analysis',
  NLS_MATERIAL_MODEL_MISSING:
    'the part material needs a constitutive set: add_material_model + define_constitutive_set, then set_part_constitutive_set',
  NLS_MATERIAL_MODEL_UNSUPPORTED:
    'creep, viscoelastic and rate laws do not belong in a static nonlinear step: choose an elastic / plastic / hyperelastic set',
  NLS_PROBE_REFERENCE_UNKNOWN:
    'a probe load names an existing load (add_fea_load) or constraint (add_fea_constraint), by id or unique name',
  NLS_NOT_CONVERGED:
    'smaller initial increment, check the constraints and the material (a perfectly plastic part collapses at its limit load)',
  NLS_INCREMENT_TOO_SMALL: 'lower minIncrement or switch to displacement control',
  NLS_MAX_INCREMENTS: 'raise maxIncrements of the step',
  NLS_NLGEOM_UNSET: 'call set_nonlinear_controls with nlgeom true or false',
  NLS_NO_STEPS: 'add at least one step with add_analysis_step',
  NLS_MATERIAL_SET_CONFLICT: 'parts sharing a material must use the same constitutive set (the deck has one material block per material)',
  NLS_IMPERFECTION_AMPLITUDE_UNSET:
    'every mode needs an explicit signed amplitude (document length units) and amplitudeSource must name who or which rule set it (no default, AF-31): ask the owner or the company rule',
  NLS_IMPERFECTION_SOURCE_INVALID:
    'fromAnalysisId must be a buckling case with the same parts, meshed and solved (fea_mesh + fea_solve) with at least that many modes, on the same mesh as this case',
  NLS_IMPERFECTION_NOT_FOUND: 'list the imperfections with describe_analysis (nonlinear.imperfectionOrder)',
  NLS_IMPERFECTION_MISSING:
    'a solved buckling case shares parts with this NLGEOM case: add_imperfection with an amplitude from the owner or a company rule (a perfect column does not buckle in a nonlinear run)',
  NLS_FRAME_INVALID:
    'fix the frame input: unique node ids, every node on a member, members of non-zero length with E, A, I > 0, a non-zero reference load, supports that stop rigid-body motion, a known report node',
  NLS_PLATEAU_PARAMS_UNSET:
    'method plateau needs plateau { slopeFraction, window } stated by the engineer (no defaults), or use method peak / auto',
  NLS_CURVE_STALE: 'the set-up changed after the solve: run fea_mesh and fea_solve again before reading curves or limit loads',
  NLS_LIMIT_NOT_REACHED: 'the curve is still rising: extend the controlled displacement (displacement control passes the peak)',
  NLS_INPUT_MISSING: 'nonlinear_analytic_check needs every input of the check: the message names the key and its unit',
  NLS_INPUT_INVALID: 'give finite numbers in the unit of the key suffix (or { value, unit }) inside the domain of the formula',
  NLS_THRESHOLD_UNSET:
    'nlgeom is false and llull has no small-rotation / strain threshold to judge it: ask the owner or the company rule, or set nlgeom true',
  NLS_PERMANENT_SET_THRESHOLD_UNSET:
    'the case unloads to zero but no permanent-set limit is known: ask the owner or the company rule (no default, AF-31) and compare nonlinear_report permanentSet',
  NLS_MATERIAL_MODEL_UNVERIFIED:
    'use a verified, sourced material model and verified E / nu (PHY-02 / 08); every number computed from it is flagged',
  NLS_SNAP_BACK_DETECTED:
    'the probe displacement reverses while the load falls although the controlled displacement grows: trace it with beam_large_deflection (frames) or an arc-length solver',
  FEA_RESULTS_MISSING: 'run fea_mesh and fea_solve on the analysis so the results artifact exists in the store',
  FEA_ANALYSIS_NOT_FOUND: 'list the analyses with describe_analysis (no analysisId), or create one with create_analysis',
  FEA_PART_NOT_IN_ANALYSIS: 'add the entity first with set_part_idealization',
  FEA_TARGET_UNRESOLVED:
    'give an existing 3D entityId and at least one point in facesNear / edgesNear / pointsNear on the intended topology',
};

/** Coded rejection with the remediation registered for `code`. */
export const refuseNls = tableRejection(REMEDIATION);

/** Remediation text of a nonlinear code (for check items). */
export const nlsRemediation = (code: string): string => REMEDIATION[code] ?? 'see the command description';

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
  FEA_ANALYSIS_NOT_FOUND: 'list the analyses with describe_analysis (no analysisId), or create one with create_analysis',
  FEA_PART_NOT_IN_ANALYSIS: 'add the entity first with set_part_idealization',
  FEA_TARGET_UNRESOLVED:
    'give an existing 3D entityId and at least one point in facesNear / edgesNear / pointsNear on the intended topology',
};

/** Coded rejection with the remediation registered for `code`. */
export const refuseNls = tableRejection(REMEDIATION);

/** Remediation text of a nonlinear code (for check items). */
export const nlsRemediation = (code: string): string => REMEDIATION[code] ?? 'see the command description';

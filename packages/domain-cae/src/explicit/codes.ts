/** Stable EXP_* codes (PHY-19 TECHNICAL_SPEC 7.1) with their one-line remediation. */

import { tableRejection } from '@core/commands/noop';

const REMEDIATION: Readonly<Record<string, string>> = {
  FEA_ANALYSIS_NOT_FOUND: 'create the case with create_analysis analysisType=explicit_dynamics',
  EXP_CASE_TYPE: 'use an explicit_dynamics case (create_analysis analysisType=explicit_dynamics)',
  EXP_SOLVER_UNSUPPORTED: 'use solver llull_explicit (the OpenCourant hand-off is not built)',
  EXP_UNITS_UNSUPPORTED: 'set the document unit to mm (N-mm-t-s) or m (N-m-kg-s)',
  EXP_CONTROLS_MISSING: 'run set_explicit_controls first',
  EXP_TIME_INVALID: 'endTime > 0 and 0 < historyInterval <= endTime (seconds)',
  EXP_MASS_SCALING_LIMIT_MISSING: 'give targetTimeStep and maxAddedMassRatio (an owner / company rule)',
  EXP_PARAM_INVALID: 'give finite values in range (see the parameter description)',
  EXP_TARGET_NOT_IN_CASE: 'add the part first with set_part_idealization',
  EXP_RIGID_WALL_INVALID: 'give a non-zero normal and a unique name',
  EXP_RIGID_WALL_NOT_FOUND: 'list the walls with explicit_report',
  EXP_MATERIAL_INCOMPLETE: 'assign a material with density and elastic constants (PHY-02 elastic_isotropic or property models E, nu)',
  EXP_MATERIAL_UNSUPPORTED: 'use elastic_isotropic, optionally with j2_plasticity johnson_cook hardening and rate_johnson_cook',
  EXP_MESH_UNSUPPORTED: 'use mesh structured_hex on unrotated boxes, or mesh fea_mesh with a linear tet mesh (fea_mesh, order 1)',
  EXP_NO_EXCITATION: 'add an initial velocity (set_initial_velocity) or gravity (set_explicit_controls)',
  EXP_RESULTS_MISSING: 'run the explicit_run transport',
  EXP_RESULT_STALE: 'the set-up changed after the run: re-run explicit_run',
  EXP_ARTIFACT_NOT_FOUND: 'run explicit_run on a machine with the artifact store; never hand-write results',
  EXP_SUMMARY_MISMATCH: 'pass the summary exactly as the transport returned it, or omit it; never hand-write results',
  EXP_INPUT_MISSING: 'supply the named input with its unit',
  EXP_CONTACT_INVALID: 'give parts of the case for a (and b except for self), a unique name, friction >= 0 and a penalty scale > 0',
  EXP_CONTACT_NOT_FOUND: 'list the contacts with explicit_report',
  EXP_MATERIAL_NO_CP: 'give the material a specific heat model (define_property_model property cp), or remove its adiabatic heating',
  EXP_CONSTRAINT_UNSUPPORTED:
    'llull_explicit holds fixed / pinned supports (and displacement dofs of 0) on box faces, nodes near points or whole parts of a structured hex mesh, or the mesh node sets of fea_mesh',
  EXP_SHELL_INVALID: 'pick an unrotated box part whose smallest dimension is at most a quarter of the others, points 1 to 5',
};

export const refuseExplicit = tableRejection(REMEDIATION);

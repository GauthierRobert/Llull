/** PHY-11 §7.1 stable codes of the creep lane and their remediation texts. */

import { tableRejection } from '@core/commands/noop';
import { codeRemediation } from '../shared/codes';

const REMEDIATION: Readonly<Record<string, string>> = {
  CRP_CASE_TYPE: 'create_analysis analysisType=creep, then set_creep_step on that case',
  CRP_SOLVER_UNSUPPORTED: 'use solver calculix (the only solver with a creep procedure)',
  CRP_LAW_MISSING:
    'add_material_model a creep_norton law and an elastic model, define_constitutive_set { elastic, creep } with makeDefault, assign the material',
  CRP_LAW_FORM_UNSUPPORTED: 'use a time-hardening creep_norton law (creep_garofalo and strain hardening have no CalculiX card yet)',
  CRP_LAW_TIME_UNIT:
    "give the creep_norton law timeUnit 's' (the CalculiX cards do not convert the time unit of A; convert with creep_closed_form check=convert_norton_a)",
  CRP_LAW_OUT_OF_RANGE: 'change the temperature / load, or supply a law whose validity covers it; llull never extrapolates a creep law',
  CRP_LAW_UNVERIFIED: 'replace the law by a sourced, verified one (basis A, B or S, or company with a stated source)',
  CRP_DURATION_INVALID: 'give duration { value > 0, unit s | min | h | d | yr }',
  CRP_CETOL_INVALID: 'give cetol > 0: the creep strain error allowed per increment (a few times the elastic strain, e.g. 1e-4 .. 1e-3)',
  CRP_STEP_PARAM_INVALID: 'increments must be finite and > 0 with min <= initial <= max <= duration; maxIncrements an integer >= 1',
  CRP_NO_VISCOUS_MATERIAL: 'attach a creep law to a part (see CRP_LAW_MISSING) or use analysisType static',
  CRP_STEP_MISSING: 'set_creep_step on the case first (the hold has no default)',
  CRP_ORTHOTROPIC_V2:
    'use an isotropic elastic model: CalculiX switches to the infinitesimal-strain creep model for orthotropic elasticity',
  CRP_OVERSTRESS_MODEL: 'a plastic model with yield > 0 switches CalculiX to overstress creep: use zero yield for creep below yield',
  CRP_INCREMENT_UNBOUNDED:
    'set maxIncrement in set_creep_step (CETOL cannot bound the increment while the stress is constant: measured, CalculiX 2.21 then stops with a singular matrix)',
  CRP_HOLD_INCOMPLETE: 'smaller initialIncrement, larger maxIncrements, check the solver log (fea_solve)',
  CRP_RESULTS_MISSING: 'run fea_mesh then fea_solve on this case first',
  CRP_INPUT_MISSING: 'give the input named in the message (a number in the unit of its suffix, or { value, unit })',
  CRP_INPUT_INVALID: 'see the creep_closed_form description for the range of each input',
  CRP_WLF_OUT_OF_RANGE: 'WLF holds for T - Tr >= 0 and C2 + (T - Tr) > 0: use an Arrhenius or measured shift below Tr',
  CRP_NOTHING_TO_DELETE: 'the case has no creep step',
};

/** Remediation of a creep code (falls back to the 05 table). */
export const crpRemediation = (code: string): string => REMEDIATION[code] ?? codeRemediation(code);

/** Coded rejection with the remediation registered for `code`. */
export const refuseCrp = tableRejection(REMEDIATION, codeRemediation);

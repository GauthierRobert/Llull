/** Stable FRC_* refusal codes of the fracture / damage-tolerance commands (TECHNICAL_SPEC §7.1) with their one-line remediation. */

import { tableRejection } from '@core/commands/noop';

const REMEDIATION: Readonly<Record<string, string>> = {
  FRC_CRACK_INVALID: 'give lengths > 0 in a length unit with a < W/2 (centre), a < b (edge), a < t and a/c <= 1 (surface)',
  FRC_CRACK_NOT_FOUND: 'define the crack with define_crack',
  FRC_CRACK_IN_USE: 'delete the crack-growth case that uses it first',
  FRC_CASE_NOT_FOUND: 'create the case with create_crack_growth_case',
  FRC_CASE_INVALID: 'check histories (stress kind), aInitial (> 0, < the K-solution limit) and the optional sizes',
  FRC_K_SOLUTION_OUT_OF_RANGE: 'the crack size is outside the validity of the K solution: use another geometry or an FE K',
  FRC_K_SOLUTION_UNCONFIRMED: 'surface-crack K (Newman-Raju) is indicative only; growth integration needs a through crack',
  FRC_MODEL_MISSING:
    'add a growth model (da_dn_paris, da_dn_walker, da_dn_forman, da_dn_nasgro, da_dn_table) and a fracture_toughness model with add_material_model',
  FRC_UNITS_MISMATCH: "use 'm/cycle|MPa*m^0.5' or 'in/cycle|ksi*in^0.5' and K quantities in a stress-intensity unit",
  FRC_SCATTER_FACTOR_UNSET:
    'set_damage_tolerance_factors scatterThreshold / scatterInterval = {value >= 1, source} (ask the owner; no default)',
  FRC_DETECTABLE_SIZE_UNSET: 'give growth.aDetectable (the NDE detectable size, with its source) in create_crack_growth_case',
  FRC_FACTOR_INVALID: 'factors need value >= 1 and a non-empty source; marginalBand >= 0',
  FRC_PARAMS_INVALID: 'follow the command description',
  FRC_NO_STRESS: 'the history has no tensile cycle (max stress > 0 needed)',
};

export const refuseFracture = tableRejection(REMEDIATION);

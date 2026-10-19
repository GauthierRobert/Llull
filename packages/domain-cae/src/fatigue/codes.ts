/** Stable FAT_* refusal codes of the fatigue commands (TECHNICAL_SPEC §7.1) with their one-line remediation. */

import { tableRejection } from '@core/commands/noop';

const REMEDIATION: Readonly<Record<string, string>> = {
  FAT_HISTORY_INVALID:
    'give >= 2 finite values (blocks: max >= min, cycles > 0) and a unit that matches the kind (stress: MPa, ksi, ...; load_factor: "-")',
  FAT_HISTORY_NOT_FOUND: 'list histories with describe_analysis or define_load_history first',
  FAT_HISTORY_EMPTY: 'lower the gate: no reversal is left',
  FAT_HISTORY_MISMATCH: 'resample the mapped histories to one time base (same length)',
  FAT_HISTORY_IN_USE: 'delete or remap the fatigue / crack-growth case that uses the history first',
  FAT_CURVE_MISSING:
    'add an S-N / strain-life model of the material with add_material_model (sn_basquin, sn_power_law, sn_table, en_coffin_manson)',
  FAT_CURVE_UNSUPPORTED: 'use sn_basquin, sn_power_law, sn_table (amplitude) or en_coffin_manson',
  FAT_MEAN_MODEL_UNSUPPORTED: 'strain-life supports meanStress none, morrow, swt and walker; stress-life all models',
  FAT_ALLOWABLE_MISSING: 'set_material_property Ftu / Fty (Goodman, Gerber: Ftu; Soderberg: Fty) with an explicit basis on the record',
  FAT_FACTOR_INVALID: 'scatter >= 1 with a source; modifiers > 0 with a justification; damageLimit > 0; marginalBand >= 0',
  FAT_CASE_NOT_FOUND: 'create the case with create_fatigue_case',
  FAT_CASE_INVALID:
    'check the mapping (existing histories, scale finite), requiredLife (> 0; flights / hours need blocksPerUnit) and the notch',
  FAT_SCATTER_FACTOR_UNSET: 'set_fatigue_factors scatter={value, source} (ask the owner; llull has no default)',
  FAT_RESULTS_MISSING:
    'solve the analysis (fea_mesh, fea_solve), then run the fatigue_field transport (llull fatigue_field caseId=...; needs llull-compute); or use a stress-kind history and no analysisId',
  FAT_RESULTS_STALE: 'the analysis inputs changed since its solve: run fea_solve again, then fatigue_field',
  FAT_FIELD_INVALID: 'run fatigue_field again: the stored field does not match this case input, mesh or node set',
  FAT_NATIVE_MISMATCH: 'report it: the native fatigue field disagrees with the TypeScript reference at a hot spot',
  FAT_PARAMS_INVALID: 'follow the command description (amplitude and strainAmplitude are exclusive; units are stresses)',
  FAT_SOLVER_NO_CONVERGENCE: 'check the strain-life parameters (b, c < 0; epsF, sigmaF > 0)',
};

export const refuseFatigue = tableRejection(REMEDIATION);

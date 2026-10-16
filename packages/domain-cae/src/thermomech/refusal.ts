/** Refusals of the PHY-04 commands: stable code, ids, paths and the remediation texts of TECHNICAL_SPEC §7.1. */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { refuse } from '../shared/refuse';

const REMEDIATION: Readonly<Record<string, string>> = {
  FEA_ANALYSIS_NOT_FOUND: 'list the analyses with describe_analysis (no analysisId), or create one with create_analysis',
  THM_CASE_TYPE: 'use a thermo_static analysis here (create_analysis analysisType thermo_static); heat_* cases use the thermal commands',
  THM_UNITS_MISMATCH: 'give { value, unit } with a temperature unit (degC, K, degF)',
  TMC_REFERENCE_TEMPERATURE_MISSING:
    'set_reference_temperature { analysisId, value, unit } (the stress-free temperature; there is no default)',
  TMC_FIELD_SOURCE_INVALID:
    'reference a solved heat_* analysis, a finite time or "last", a valid expression in x, y, z, or a table artifact hash',
  TMC_FIELD_INVALID: 'fix the expression or the source so every mesh node gets a finite temperature',
  TMC_FIELD_TABLE_UNMATCHED:
    're-export the table so every mesh node has a row within 1e-6 of the model size, or use a thermal_result field',
  TMC_THERMAL_RESULT_STALE: 're-solve the thermal case (fea_solve), then this one',
  TMC_MESH_MISMATCH: 'mesh both cases with the same parts, mesh controls and targets (mapping interpolate is not built)',
  TMC_HUMAN_GATE: 'hand over to the qualified reviewer: a human signature verified by the signing port is required',
  TMC_FIT_INPUTS_CHANGED: 'recompute the fit (fit_at_temperature), then disposition the new row',
  FEA_RESULTS_MISSING: 'run fea_mesh and fea_solve on the analysis so the results artifact exists in the store',
  FEA_RESULTS_STALE: 're-solve the analysis (fea_solve); results of changed inputs are never read',
  FEA_PARAM_INVALID: 'see the parameter descriptions of the command',
};

/** `refuse` with the remediation registered for `code`; document unchanged. */
export function refuseTmc(
  doc: CadDocument,
  command: string,
  code: string,
  message: string,
  ids: readonly string[] = [],
  paths: readonly string[] = [],
): CommandResult {
  return refuse(doc, command, code, message, REMEDIATION[code] ?? 'see the command description', ids, paths);
}

/** Remediation text of a code (for check items). */
export const remediationOf = (code: string): string => REMEDIATION[code] ?? 'see TECHNICAL_SPEC §7.1';

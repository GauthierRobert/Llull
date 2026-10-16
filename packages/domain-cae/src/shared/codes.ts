/** 05 §7.1 / PHY-03 / PHY-04 remediation texts for the codes the set-up commands emit. */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { refuse } from './refuse';

const REMEDIATION: Readonly<Record<string, string>> = {
  FEA_ANALYSIS_NOT_FOUND: 'list the analyses with describe_analysis (no analysisId), or create one with create_analysis',
  FEA_ANALYSIS_TYPE_UNSUPPORTED:
    'use static, heat_steady, heat_transient or thermo_static (modal, buckling and coupled cases are not built)',
  FEA_ANALYSIS_IN_USE: 'delete or re-point the analyses that read this one first',
  FEA_PARAM_NOT_APPLICABLE: 'drop the parameter or choose an analysisType that uses it',
  FEA_UNITS_MISMATCH: 'drop unitSystem (it follows the document unit) or fix the quantity unit',
  FEA_FACTOR_INVALID: 'every factor must be >= 1 and every extra factor needs a non-empty justification',
  FEA_PART_NOT_IN_ANALYSIS: 'add the entity first with set_part_idealization',
  FEA_PART_INVALID: 'pass the id of an existing 3D solid and idealization solid (the only one built)',
  FEA_TARGET_UNRESOLVED:
    'give an existing 3D entityId and at least one point in facesNear / edgesNear / pointsNear on the intended topology',
  FEA_CONSTRAINT_NOT_FOUND: 'list constraints with describe_analysis',
  FEA_CONSTRAINT_INVALID: 'fixed / pinned / symmetry need a target; displacement also needs dofs with finite values',
  FEA_LOAD_NOT_FOUND: 'list loads with describe_analysis',
  FEA_LOAD_INVALID: 'force needs target + vector, pressure needs target + magnitude, gravity needs vector and no target',
  FEA_MESH_CONTROLS_INVALID: 'order must be 1 or 2, sizes > 0, minSize <= globalSize, refinement size <= globalSize',
  FEA_PROBE_NOT_FOUND: 'list probes with describe_analysis',
  FEA_PROBE_INVALID: 'give a finite point [x, y, z] in document units and a supported quantity',
  TMC_REFERENCE_TEMPERATURE_MISSING: 'pass referenceTemperature { value, unit } (the stress-free temperature; there is no default)',
  THM_UNITS_MISMATCH: 'give { value, unit } with a temperature unit (degC, K, degF)',
};

/** `refuse` with the remediation registered for `code`. */
export function refuseCode(
  doc: CadDocument,
  command: string,
  code: string,
  message: string,
  ids: readonly string[] = [],
  paths: readonly string[] = [],
): CommandResult {
  return refuse(doc, command, code, message, REMEDIATION[code] ?? 'see the command description', ids, paths);
}

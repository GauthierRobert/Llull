/** Refusals of compute_margins: stable codes (05 §7.1) with remediation texts. */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { codedRejection } from '@core/commands/noop';
import { feRemediation } from '../shared/feCodes';

const REMEDIATION: Readonly<Record<string, string>> = {
  FEA_MATERIAL_NO_ALLOWABLE:
    'define the strength with define_property_model (property Ftu / Fty, unit MPa or psi, validity covering the case reference temperature), or pass allowable { value, unit }',
  FEA_MARGIN_PARAM_INVALID: 'see the parameter descriptions of compute_margins',
  FEA_RESULTS_STALE: 're-solve the analysis (fea_mesh then fea_solve); margins of changed inputs are never computed',
  FEA_RESULTS_MISSING: 'run fea_mesh and fea_solve on the analysis so the results artifact exists in the store',
};

/** `refuse` with the remediation registered for `code` (this module's table, else the 05 table). */
export function refuseMargins(doc: CadDocument, code: string, message: string, ids: readonly string[] = []): CommandResult {
  return codedRejection(doc, 'compute_margins', code, message, REMEDIATION[code] ?? feRemediation(code), ids);
}

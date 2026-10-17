/** Remediation texts of the 05 §7.1 codes emitted by the record / report / check / deck functions. */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { refuse } from './refuse';

const REMEDIATION: Readonly<Record<string, string>> = {
  FEA_ANALYSIS_NOT_FOUND: 'list the analyses with describe_analysis, or create one with create_analysis',
  FEA_ARTIFACT_NOT_FOUND: 'run the host transport (fea_mesh / fea_solve) on a machine with the artifact store; never hand-write summaries',
  FEA_SUMMARY_MISMATCH: 'pass the summary exactly as the transport returned it; never hand-write summaries',
  FEA_INPUT_STALE: 'the analysis changed after the artifact was built: re-run fea_mesh then fea_solve',
  FEA_MESH_MISMATCH: 'record the mesh the results were computed on (fea_mesh then fea_solve), then record the results',
  FEA_MESH_MISSING: 'run fea_mesh',
  FEA_MESH_STALE: 'run fea_mesh',
  FEA_MESH_INVERTED: 'refine the mesh (set_mesh_controls globalSize / refinements) or change order, then run fea_mesh',
  FEA_RESULTS_MISSING: 'run fea_solve',
  FEA_RESULTS_STALE: 'run fea_mesh then fea_solve',
  FEA_PART_INVALID: 'add the 3D solids to analyse with set_part_idealization',
  FEA_MATERIAL_MISSING: 'assign a material to the part (assign_material) with create_material',
  FEA_MATERIAL_NO_ELASTIC:
    'define an elastic_isotropic constitutive set (add_material_model + define_constitutive_set) or property models E and nu (define_property_model)',
  FEA_MATERIAL_ELASTIC_UNSUPPORTED: 'use an elastic_isotropic constitutive set or the property models E and nu',
  FEA_MATERIAL_UNVERIFIED: 'replace the property with a verified, sourced value',
  FEA_PROPERTY_INVALID: 'correct the value: E > 0 and -1 < nu < 0.5',
  FEA_NO_CONSTRAINTS: 'add a support with add_fea_constraint (fixed / pinned / symmetry / displacement)',
  FEA_NO_LOADS: 'add a load with add_fea_load, or a displacement constraint with a non-zero value',
  FEA_POINT_LOAD_SINGULAR: 'put the load on a face (facesNear) so it is distributed; peak stress at a point load is not meaningful',
  FEA_TARGET_UNRESOLVED: 'move the target points onto the intended topology and re-run fea_mesh',
  FEA_CONSTRAINT_INVALID: 'solid parts have translational dofs only (ux, uy, uz); a symmetry target must be an axis-aligned plane',
  FEA_MESH_TOO_LARGE: 'raise the global mesh size (set_mesh_controls globalSize) or analyse a smaller part',
  FEA_RESULTS_TOO_LARGE: 'mesh more coarsely (set_mesh_controls globalSize) or request fewer load cases / output times',
  FEA_DECK_NAME_COLLISION:
    'rename the entity or target so the sanitised set names differ (letters, digits and underscores only), then run fea_mesh',
  FEA_UNITS_MISMATCH: 'mesh and analysis disagree on the unit system: re-run fea_mesh',
  FEA_ANALYSIS_TYPE_UNSUPPORTED: 'use static, heat_steady, heat_transient or thermo_static',
};

/** Remediation text registered for a 05 code ("see the command description" when unknown). */
export const feRemediation = (code: string): string => REMEDIATION[code] ?? 'see the command description';

/** `refuse` with the remediation registered for `code`. */
export function refuseFe(doc: CadDocument, command: string, code: string, message: string, ids: readonly string[] = []): CommandResult {
  return refuse(doc, command, code, message, feRemediation(code), ids);
}

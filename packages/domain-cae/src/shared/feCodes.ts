/** Remediation texts of the 05 §7.1 codes emitted by the record / report / check / deck functions. */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { codedRejection } from '@core/commands/noop';

const REMEDIATION: Readonly<Record<string, string>> = {
  FEA_ANALYSIS_NOT_FOUND: 'list the analyses with describe_analysis, or create one with create_analysis',
  FEA_ARTIFACT_NOT_FOUND: 'run the host transport (fea_mesh / fea_solve) on a machine with the artifact store; never hand-write summaries',
  FEA_SUMMARY_MISMATCH: 'pass the summary exactly as the transport returned it; never hand-write summaries',
  FEA_INPUT_STALE: 'the analysis changed after the artifact was built: re-run fea_mesh then fea_solve',
  FEA_MESH_MISMATCH: 'record the mesh the results were computed on (fea_mesh then fea_solve), then record the results',
  FEA_MESH_MISSING: 'run fea_mesh',
  FEA_MESH_STALE: 'run fea_mesh',
  FEA_FACETED_GEOMETRY:
    'for stress at holes / fillets / curved faces use the OCC kernel (--kernel occt-native or LLULL_KERNEL=occt-native) so the mesh follows the exact B-rep, then re-run fea_mesh',
  FEA_MESH_INVERTED: 'refine the mesh (set_mesh_controls globalSize / refinements) or change order, then run fea_mesh',
  FEA_RESULTS_MISSING: 'run fea_solve',
  FEA_RESULTS_STALE: 'run fea_mesh then fea_solve',
  FEA_PART_INVALID: 'add the 3D solids to analyse with set_part_idealization',
  FEA_MATERIAL_MISSING: 'assign a material to the part (assign_material) with create_material',
  FEA_MATERIAL_NO_ELASTIC:
    'define an elastic_isotropic constitutive set (add_material_model + define_constitutive_set) or property models E and nu (define_property_model)',
  FEA_MATERIAL_ELASTIC_UNSUPPORTED: 'use an elastic_isotropic constitutive set or the property models E and nu',
  FEA_MATERIAL_UNVERIFIED: 'replace the property with a verified, sourced value',
  FEA_DENSITY_IMPLAUSIBLE:
    're-create the material with densityUnit (e.g. "kg/m^3"): mass, inertia loads and modal frequencies use this density',
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
  FEA_ANALYSIS_TYPE_UNSUPPORTED:
    'use static, modal, buckling, heat_steady, heat_transient, thermo_static or coupled_temperature_displacement',
  FEA_UNDERCONSTRAINED:
    'add supports that remove all six rigid-body motions (a fixed face, or three non-collinear points holding six dofs); modal analyses of a free model report rigid-body modes at 0 Hz',
  FEA_MESH_ADEQUACY:
    'reduce the global mesh size or add a refinement so that at least 2 (better 3-4) elements span the thinnest dimension, then run fea_mesh',
  FEA_LOADS_IGNORED: 'delete the loads, or use a static analysis for the response to them; a modal analysis only needs supports and mass',
  FEA_BUCKLING_LOAD_CASE_IGNORED:
    'keep one load case in a buckling analysis (the first one is the reference) or create one buckling analysis per case',
  FEA_RIGID_BODY_MODES:
    'the lowest modes are rigid-body motions: add supports (or ignore the first modes of a free-free model deliberately)',
  FEA_BUCKLING_NEAR_ZERO:
    'a buckling factor of 0 means a singular model or no load: check the supports and the reference load, then re-solve',
  FEA_BUCKLING_NEGATIVE_FACTOR:
    'a negative factor buckles under the reversed load; for a one-directional load use the lowest positive factor',
  FEA_BUCKLING_NO_POSITIVE: 'reverse the load direction (tension only does not buckle) or check that the load acts on the supported model',
  FEA_BUCKLING_BELOW_APPLIED:
    'the applied load exceeds the linear buckling load: stiffen the part or reduce the load; linear buckling is an upper bound (imperfections lower it), a qualified engineer must review',
};

/** Remediation text registered for a 05 code ("see the command description" when unknown). */
export const feRemediation = (code: string): string => REMEDIATION[code] ?? 'see the command description';

/** `refuse` with the remediation registered for `code`. */
export function refuseFe(doc: CadDocument, command: string, code: string, message: string, ids: readonly string[] = []): CommandResult {
  return codedRejection(doc, command, code, message, feRemediation(code), ids);
}

/** Stable SEL_* codes of the material-selection commands (PHY-12 TECHNICAL_SPEC §7.1) with their one-line remediation. */

import { tableRejection } from '@core/commands/noop';
import type { SelIssue } from './types';

const REMEDIATION: Readonly<Record<string, string>> = {
  SEL_MATERIAL_NOT_FOUND:
    'use get_material or describe_scene to list the material ids of the document (import_material_library adds library records)',
  SEL_MATERIAL_NOT_ASSIGNED: 'assign_material the `from` material first, or fix `from`',
  SEL_ENTITY_NOT_FOUND: 'give the id of a 3D solid entity of the document (describe_scene lists them)',
  SEL_PROPERTY_MISSING: 'set_material_property with a sourced value (llull never imputes a property)',
  SEL_PROPERTY_AMBIGUOUS:
    'mark one of the values preferred (set_material_property replace: true, preferred: true) or pass direction / thickness',
  SEL_STRENGTH_PROPERTY_UNSET: 'pass strengthProperty Fty, Ftu or Fcy (there is no default: yield and ultimate give different rankings)',
  SEL_NO_OBJECTIVE: 'add at least one objective { index } (see `llull describe compare_materials` for the index cases)',
  SEL_WEIGHT_INVALID: 'give every objective a weight >= 0 (at least one > 0), or none to weight them equally',
  SEL_NO_CANDIDATE: 'relax the constraints or add the missing data (set_material_property, import_material_library)',
  SEL_DESIGN_RULE_UNSET: 'name the rule: same_geometry, equal_stiffness_tie / beam / panel or equal_strength_tie / beam / panel',
  SEL_BASIS_MIXED: 'compare like with like (A against A, typical against typical)',
  SEL_VALUE_UNVERIFIED: 'replace the typical / supplier / legacy value with a verified, sourced one (basis A, B, S or company)',
  SEL_DERIVATION_NOTE_MISSING: 'state how the index follows from the loading case (derivationNote)',
  SEL_LAYUP_REQUIRED: 'pass layups { <id>: { laminate: "[0/+-45/90]s" } }; create_lamina_material defines the lamina',
  SEL_ANISOTROPIC: 'check the first-ply failure with analyze_laminate; the index covers in-plane stiffness only',
  SEL_MARGINS_NEED_RESOLVE: 'run data.margins.resolvePlan on a copy (assign_material, fea_mesh, fea_solve, compute_margins)',
  SEL_NO_ANALYSIS: 'create_analysis with these parts and solve it, or drop margins from include',
  SEL_FEA_STALE_AFTER_SUBSTITUTION: 'fea_solve again (fea_mesh first when the mesh is stale too)',
  SEL_PARAMS_INVALID: 'follow the command description (units of the right dimension, bounds, no empty lists)',
};

export const refuseSel = tableRejection(REMEDIATION);

/** A finding with its stable code, severity and fix. */
export function issue(code: string, severity: SelIssue['severity'], message: string, ids: readonly string[] = []): SelIssue {
  return { code, severity, message, ids, remediation: REMEDIATION[code] ?? 'see the command description' };
}

/** Closing sentence of every summary: the numbers are computed, not approved. */
export const REVIEW_SENTENCE = 'computed by llull from the stored values, not an allowable comparison - a qualified engineer must decide';

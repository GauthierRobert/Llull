/** Stable COR_* codes of the corrosion lane (PHY-13 TECHNICAL_SPEC §7.1) with their one-line remediation. */

import { tableRejection } from '@core/commands/noop';

const REMEDIATION: Readonly<Record<string, string>> = {
  COR_ENTITY_NOT_FOUND: 'list the ids with find_entities',
  COR_TOLERANCE_INVALID: 'pass tolerance { value > 0, unit }',
  COR_ENVIRONMENT_UNSET: 'set_service_environment { scheme, environment }: there is no default environment',
  COR_ENVIRONMENT_INVALID:
    'anodic_index takes harsh | normal | controlled; mil_std_889d takes artificial_seawater (list_compatibility_rules shows the tables)',
  COR_MATERIAL_MISSING: 'assign_material to the part, then set_galvanic_group for that material',
  COR_MATERIAL_NOT_FOUND: 'create_material first (list the materials with get_material)',
  COR_GROUP_MISSING: 'set_galvanic_group { material, galvanicGroup, source } (groups: list_compatibility_rules)',
  COR_GROUP_UNKNOWN: 'use a group id of list_compatibility_rules (anodic_groups)',
  COR_GROUP_VALUE_MISSING:
    'the group has no anodic index (graphite): the CFRP rule applies to aluminium; give anodicIndexV with a source otherwise',
  COR_GALVANIC_INCOMPATIBLE: 'isolate the couple (declare_isolation) or change a material; a human decides',
  COR_889_TABLE_MISSING: 'the MIL-STD-889D matrix is not shipped: use scheme anodic_index (screening only) or import a reviewed matrix',
  COR_ISOLATION_TARGET_MISSING: 'give exactly one of pair [idA, idB] (two different ids) or entityId',
  COR_ISOLATION_NOT_FOUND: 'list the isolations in the document slice corrosion.isolations',
  COR_ITEM_NOT_FOUND: 'run check_material_compatibility and pass an item key it reported (galvanic:<a>|<b>)',
  COR_ITEM_NOT_ACCEPTABLE: 'only a warn, fail or unknown item can be accepted or rejected',
  COR_PARAMS_INVALID: 'follow the command description',
  COR_HUMAN_GATE: 'hand the item to the qualified reviewer, who signs the decision in the desktop app; do not retry',
  COR_DOCUMENT_UNIDENTIFIED: 'save the document first so it has a uid',
};

export const refuseCor = tableRejection(REMEDIATION);

/** The unverified-value reason carried by every item that rests on a grade B rule or table value (not suppressible). */
export const UNVERIFIED_REASON =
  'COR_VALUE_UNVERIFIED: the rule values are grade B (secondary sources); verify against the primary standard';

/** Reason every item carries (FR-COR-17). */
export const REVIEW_REASON = 'corrosion protection supports 14 CFR 25.609 compliance: a qualified person reviews every item';

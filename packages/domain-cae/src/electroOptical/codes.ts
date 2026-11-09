/** Stable EOP_* codes of the electro-optical lane (PHY-15 TECHNICAL_SPEC §7.1) with their one-line remediation. */

import { tableRejection } from '@core/commands/noop';

const REMEDIATION: Readonly<Record<string, string>> = {
  EOP_ENTITY_NOT_FOUND: 'list the ids with find_entities',
  EOP_COATING_NOT_FOUND:
    'define_material_record { id, productForm: "coating" } then define_property_model emissivityIr / absorptivitySolar',
  EOP_COATING_NOT_ASSIGNED: 'assign_surface_coating first (or pass coating / alpha and eps)',
  EOP_COATING_AMBIGUOUS: 'the entity has several exposed coatings: pass coating explicitly',
  EOP_COATING_ASSIGNMENT_NOT_FOUND: 'list the assignments in the document slice electroOptical.coatings',
  EOP_FACE_ALREADY_COATED: 'remove_surface_coating first (or keep the existing coating)',
  EOP_BOND_ELEMENT_INVALID: 'give every joint a resistance and a source, every strap a material, length and cross-section (all > 0)',
  EOP_LIMIT_SOURCE_REQUIRED: 'give limit.source.citation: llull has no default bond limit',
  EOP_PATH_NOT_FOUND: 'list the bond paths with check_bonding',
  EOP_SOLAR_FLUX_MISSING: 'give solarFlux { value, unit } with its source: llull has no default solar flux',
  EOP_SURFACE_PROPERTY_MISSING:
    'define_property_model emissivityIr (condition opticalKind) / absorptivitySolar (condition lifeState) on the coating, or pass alpha and eps',
  EOP_PROPERTY_RANGE: 'absorptivity must be in [0, 1] and emissivity in (0, 1]',
  EOP_PARAMS_INVALID: 'follow the command description',
  EOP_NOTHING_TO_DISPOSE: 'only a fail or unknown path can be accepted, rejected or sent back for redesign',
  EOP_BOND_INPUTS_CHANGED: 'the path changed after the check: run check_bonding again',
  EOP_HUMAN_GATE: 'hand the path to the qualified reviewer, who signs the decision in the desktop app; do not retry',
  EOP_DOCUMENT_UNIDENTIFIED: 'save the document first so it has a uid',
};

export const refuseEop = tableRejection(REMEDIATION);

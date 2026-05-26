/**
 * @command create_material
 * @command assign_material
 * @pure
 * @layer core/commands
 * @affects CadDocument.materials (create_material); BaseEntity.materialId (assign_material)
 * @invariant density > 0; metalness ∈ [0,1]; roughness ∈ [0,1]; color matches /^#[0-9a-fA-F]{6}$/
 * @failure blank name / density ≤ 0 / out-of-range PBR / invalid hex → no-op, affected:[]
 * @failure unknown material or unknown entity id → no-op per-entity, summary lists failures
 */

import type { CadDocument, Material } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Validates a CSS hex color string: #rrggbb (6 hex digits). */
function isValidHexColor(s: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(s);
}

// ---------------------------------------------------------------------------
// create_material
// ---------------------------------------------------------------------------

interface CreateMaterialParams {
  /** Human-readable name; also the lookup key in doc.materials. Must be non-empty. */
  name: string;
  /**
   * Density in (mass-unit) per (document-length-unit)³.
   * For a document in mm: g/mm³ (steel ≈ 0.00785, aluminium ≈ 0.0027, PLA ≈ 0.00124).
   * Must be > 0 and finite. Used by mass_properties when a material is assigned.
   */
  density: number;
  /** Diffuse/albedo color as a CSS hex string, e.g. "#b0b0b0". Must match /^#[0-9a-fA-F]{6}$/. */
  color: string;
  /** PBR metalness factor in [0, 1]. 0 = dielectric, 1 = metallic. */
  metalness: number;
  /** PBR roughness factor in [0, 1]. 0 = mirror-smooth, 1 = fully rough. */
  roughness: number;
}

/**
 * @command create_material
 * @pure
 * @layer core/commands
 * @affects adds or replaces CadDocument.materials[name]
 * @invariant existing materials with different names are untouched
 * @failure blank name → no-op; density ≤ 0 or non-finite → no-op;
 *          metalness/roughness outside [0,1] → no-op; invalid hex color → no-op
 */
export const createMaterial: CommandDefinition<CreateMaterialParams> = {
  name: 'create_material',
  description:
    'Define or replace a named material in the document material library. ' +
    'A material carries a physical density (used by mass_properties for mass = volume × density) ' +
    'and PBR visual properties (color, metalness, roughness) used by the 3D viewport renderer. ' +
    'If a material with the same name already exists it is fully replaced. ' +
    'Density units match the document unit system: for a mm document, density is in g/mm³ ' +
    '(steel ≈ 0.00785, aluminium ≈ 0.0027, PLA ≈ 0.00124). ' +
    'Assign the material to entities with assign_material.',
  paramsSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'Human-readable material name used as the lookup key, e.g. "steel", "aluminium_6061". ' +
          'Must be a non-empty string. Case-sensitive. Used with assign_material to reference this material.',
      },
      density: {
        type: 'number',
        description:
          'Density in (mass-unit) per (document-length-unit)³. Must be > 0 and finite. ' +
          'For a document in mm: g/mm³ — steel ≈ 0.00785, aluminium ≈ 0.0027, PLA ≈ 0.00124, ' +
          'titanium ≈ 0.00445, copper ≈ 0.00893. ' +
          'This value is used by mass_properties when the material is assigned to an entity.',
      },
      color: {
        type: 'string',
        description:
          'Diffuse/albedo color as a 6-digit CSS hex string, e.g. "#b0b0b0" for grey steel. ' +
          'Must match the pattern #rrggbb (exactly 6 hex digits after the #). ' +
          'Used by the 3D viewport PBR renderer (VNF4).',
      },
      metalness: {
        type: 'number',
        description:
          'PBR metalness factor in [0, 1]. 0 = fully dielectric (plastic, wood, ceramic), ' +
          '1 = fully metallic (aluminium, steel, copper). Non-metallic coatings are typically 0.',
      },
      roughness: {
        type: 'number',
        description:
          'PBR roughness factor in [0, 1]. 0 = mirror-smooth (polished metal), ' +
          '1 = fully diffuse/matte (rough concrete, unfinished wood). ' +
          'Brushed aluminium ≈ 0.3, matte plastic ≈ 0.7.',
      },
    },
    required: ['name', 'density', 'color', 'metalness', 'roughness'],
  },
  annotations: { idempotent: true },
  run: (doc, { name, density, color, metalness, roughness }): CommandResult => {
    if (typeof name !== 'string' || name.trim() === '') {
      return {
        document: doc,
        summary: 'create_material failed: name must be a non-empty string.',
        affected: [],
      };
    }

    if (typeof density !== 'number' || !isFinite(density) || density <= 0) {
      return {
        document: doc,
        summary: `create_material '${name}' failed: density must be a finite number > 0, got ${String(density)}.`,
        affected: [],
      };
    }

    if (typeof metalness !== 'number' || !isFinite(metalness) || metalness < 0 || metalness > 1) {
      return {
        document: doc,
        summary: `create_material '${name}' failed: metalness must be in [0, 1], got ${String(metalness)}.`,
        affected: [],
      };
    }

    if (typeof roughness !== 'number' || !isFinite(roughness) || roughness < 0 || roughness > 1) {
      return {
        document: doc,
        summary: `create_material '${name}' failed: roughness must be in [0, 1], got ${String(roughness)}.`,
        affected: [],
      };
    }

    if (typeof color !== 'string' || !isValidHexColor(color)) {
      return {
        document: doc,
        summary: `create_material '${name}' failed: color must be a 6-digit hex string like "#b0b0b0", got "${String(color)}".`,
        affected: [],
      };
    }

    const material: Material = { name, density, color, metalness, roughness };
    const newDoc: CadDocument = {
      ...doc,
      materials: { ...doc.materials, [name]: material },
    };

    const action = doc.materials[name] ? 'replaced' : 'created';
    return {
      document: newDoc,
      summary: `create_material '${name}': ${action} (density=${density} g/${doc.units}³, color=${color}, metalness=${metalness}, roughness=${roughness}).`,
      affected: [],
    };
  },
};

// ---------------------------------------------------------------------------
// assign_material
// ---------------------------------------------------------------------------

interface AssignMaterialParams {
  /**
   * Name of the material to assign; must exist in doc.materials
   * (created with create_material).
   */
  materialName: string;
  /**
   * One or more entity ids to assign the material to.
   * At least one id must be provided. Unknown ids are reported in the summary
   * but do not block assignment to the valid ones.
   */
  entityIds: string[];
}

/**
 * @command assign_material
 * @pure
 * @layer core/commands
 * @affects sets BaseEntity.materialId on each target entity
 * @invariant material must exist in doc.materials; unknown entity ids → skip + note in summary
 * @failure unknown material name → no-op, affected:[]; empty entityIds → no-op
 */
export const assignMaterial: CommandDefinition<AssignMaterialParams> = {
  name: 'assign_material',
  description:
    'Assign a named material to one or more entities. ' +
    'The material must already exist in the document (create it first with create_material). ' +
    'Once assigned, mass_properties uses the material\'s density for that entity ' +
    '(mass = volume × material.density), overriding the caller-supplied density param. ' +
    'Multiple entity ids can be assigned in a single call; unknown ids are skipped with a note. ' +
    'Assigning a material is a replayable document edit recorded in featureHistory.',
  paramsSchema: {
    type: 'object',
    properties: {
      materialName: {
        type: 'string',
        description:
          'Name of the material to assign. Must exactly match a material created with create_material ' +
          '(case-sensitive). Example: "steel", "aluminium_6061".',
      },
      entityIds: {
        type: 'array',
        description:
          'List of entity ids to assign the material to. Must contain at least one id. ' +
          'Unknown ids are skipped and reported in the summary; valid ids are updated. ' +
          'To assign to a single entity, pass a one-element array, e.g. ["e-abc123"].',
        items: { type: 'string' },
      },
    },
    required: ['materialName', 'entityIds'],
  },
  annotations: { idempotent: true },
  run: (doc, { materialName, entityIds }): CommandResult => {
    if (typeof materialName !== 'string' || materialName.trim() === '') {
      return {
        document: doc,
        summary: 'assign_material failed: materialName must be a non-empty string.',
        affected: [],
      };
    }

    if (!doc.materials[materialName]) {
      const available = Object.keys(doc.materials);
      const hint =
        available.length > 0
          ? ` Available materials: ${available.join(', ')}.`
          : ' No materials defined yet — call create_material first.';
      return {
        document: doc,
        summary: `assign_material failed: material '${materialName}' not found.${hint}`,
        affected: [],
      };
    }

    if (!Array.isArray(entityIds) || entityIds.length === 0) {
      return {
        document: doc,
        summary: 'assign_material failed: entityIds must be a non-empty array of entity ids.',
        affected: [],
      };
    }

    const assigned: string[] = [];
    const missing: string[] = [];
    let updatedEntities = { ...doc.entities };

    for (const id of entityIds) {
      const entity = doc.entities[id];
      if (!entity) {
        missing.push(id);
        continue;
      }
      updatedEntities = {
        ...updatedEntities,
        [id]: { ...entity, materialId: materialName },
      };
      assigned.push(id);
    }

    if (assigned.length === 0) {
      return {
        document: doc,
        summary: `assign_material '${materialName}': no valid entity ids found — missing: ${missing.join(', ')}.`,
        affected: [],
      };
    }

    const newDoc: CadDocument = { ...doc, entities: updatedEntities };

    const parts: string[] = [
      `assign_material '${materialName}': assigned to ${assigned.length} ${assigned.length === 1 ? 'entity' : 'entities'} (${assigned.join(', ')}).`,
    ];
    if (missing.length > 0) {
      parts.push(`Missing ids skipped: ${missing.join(', ')}.`);
    }

    return {
      document: newDoc,
      summary: parts.join(' '),
      affected: assigned,
    };
  },
};

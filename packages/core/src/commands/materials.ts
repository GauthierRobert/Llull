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
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { isHexColor } from '../lib/isHexColor';
import { noop } from './noop';

/**
 * @command create_material
 * @pure
 * @layer core/commands
 * @affects adds or replaces CadDocument.materials[name]
 * @invariant existing materials with different names are untouched
 * @failure blank name → no-op; density ≤ 0 or non-finite → no-op;
 *          metalness/roughness outside [0,1] → no-op; invalid hex color → no-op
 */
export const createMaterial = defineCommand({
  name: 'create_material',
  description:
    'Define or replace a named material in the document material library. ' +
    'A material carries a physical density (used by mass_properties for mass = volume × density) ' +
    'and PBR visual properties (color, metalness, roughness) used by the 3D viewport renderer. ' +
    'If a material with the same name already exists it is fully replaced. ' +
    'Density units match the document unit system: for a mm document, density is in g/mm³ ' +
    '(steel ≈ 0.00785, aluminium ≈ 0.0027, PLA ≈ 0.00124). ' +
    'Assign the material to entities with assign_material.',
  params: z.object({
    name: z
      .string()
      .describe(
        'Human-readable material name used as the lookup key, e.g. "steel", "aluminium_6061". ' +
          'Must be a non-empty string. Case-sensitive. Used with assign_material to reference this material.',
      ),
    density: z
      .number()
      .describe(
        'Density in (mass-unit) per (document-length-unit)³. Must be > 0 and finite. ' +
          'For a document in mm: g/mm³ — steel ≈ 0.00785, aluminium ≈ 0.0027, PLA ≈ 0.00124, ' +
          'titanium ≈ 0.00445, copper ≈ 0.00893. ' +
          'This value is used by mass_properties when the material is assigned to an entity.',
      ),
    color: z
      .string()
      .describe(
        'Diffuse/albedo color as a 6-digit CSS hex string, e.g. "#b0b0b0" for grey steel. ' +
          'Must match the pattern #rrggbb (exactly 6 hex digits after the #). ' +
          'Used by the 3D viewport PBR renderer.',
      ),
    metalness: z
      .number()
      .describe(
        'PBR metalness factor in [0, 1]. 0 = fully dielectric (plastic, wood, ceramic), ' +
          '1 = fully metallic (aluminium, steel, copper). Non-metallic coatings are typically 0.',
      ),
    roughness: z
      .number()
      .describe(
        'PBR roughness factor in [0, 1]. 0 = mirror-smooth (polished metal), ' +
          '1 = fully diffuse/matte (rough concrete, unfinished wood). ' +
          'Brushed aluminium ≈ 0.3, matte plastic ≈ 0.7.',
      ),
  }),
  annotations: { idempotent: true },
  run: (doc, { name, density, color, metalness, roughness }): CommandResult => {
    if (name.trim() === '') {
      return noop(doc, 'create_material failed: name must be a non-empty string.');
    }

    if (density <= 0) {
      return noop(
        doc,
        `create_material '${name}' failed: density must be a finite number > 0, got ${String(density)}.`,
      );
    }

    for (const [field, value] of [
      ['metalness', metalness],
      ['roughness', roughness],
    ] as const) {
      if (value < 0 || value > 1) {
        return noop(
          doc,
          `create_material '${name}' failed: ${field} must be in [0, 1], got ${String(value)}.`,
        );
      }
    }

    if (!isHexColor(color)) {
      return noop(
        doc,
        `create_material '${name}' failed: color must be a 6-digit hex string like "#b0b0b0", got "${String(color)}".`,
      );
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
});

/**
 * @command assign_material
 * @pure
 * @layer core/commands
 * @affects sets BaseEntity.materialId on each target entity
 * @invariant material must exist in doc.materials; unknown entity ids → skip + note in summary
 * @failure unknown material name → no-op, affected:[]; empty entityIds → no-op
 */
export const assignMaterial = defineCommand({
  name: 'assign_material',
  description:
    'Assign a named material to one or more entities. ' +
    'The material must already exist in the document (create it first with create_material). ' +
    "Once assigned, mass_properties uses the material's density for that entity " +
    '(mass = volume × material.density), overriding the caller-supplied density param. ' +
    'Multiple entity ids can be assigned in a single call; unknown ids are skipped with a note. ' +
    'Assigning a material is a replayable document edit recorded in featureHistory.',
  params: z.object({
    materialName: z
      .string()
      .describe(
        'Name of the material to assign. Must exactly match a material created with create_material ' +
          '(case-sensitive). Example: "steel", "aluminium_6061".',
      ),
    entityIds: z
      .array(z.string())
      .describe(
        'List of entity ids to assign the material to. Must contain at least one id. ' +
          'Unknown ids are skipped and reported in the summary; valid ids are updated. ' +
          'To assign to a single entity, pass a one-element array, e.g. ["e-abc123"].',
      ),
  }),
  annotations: { idempotent: true },
  run: (doc, { materialName, entityIds }): CommandResult => {
    if (materialName.trim() === '') {
      return noop(doc, 'assign_material failed: materialName must be a non-empty string.');
    }

    if (!doc.materials[materialName]) {
      const available = Object.keys(doc.materials);
      const hint =
        available.length > 0
          ? ` Available materials: ${available.join(', ')}.`
          : ' No materials defined yet — call create_material first.';
      return noop(doc, `assign_material failed: material '${materialName}' not found.${hint}`);
    }

    if (entityIds.length === 0) {
      return noop(
        doc,
        'assign_material failed: entityIds must be a non-empty array of entity ids.',
      );
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
      return noop(
        doc,
        `assign_material '${materialName}': no valid entity ids found — missing: ${missing.join(', ')}.`,
      );
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
});

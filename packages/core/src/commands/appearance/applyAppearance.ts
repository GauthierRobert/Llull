/** apply_appearance — copy an offline library appearance onto a material or onto entities as a visual override (RV1 RV-M1). */

import type { Appearance } from '../../model/appearance';
import { APPEARANCE_LIBRARY, libraryAppearance } from '../../model/appearanceLibrary';
import { isCurve3D } from '../../model/curveKinds';
import { isSceneObject } from '../../model/sceneKinds';
import { type Entity, is2D } from '../../model/types';
import { isHexColor } from '../../lib/isHexColor';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed } from '../noop';
import { describeAppearance, syncMaterial } from './appearanceChannels';
import { refuseAppearance } from './refusal';

const COMMAND = 'apply_appearance';

/** True for an entity with a surface to draw: not a light, a camera, a 2D shape or a 3D curve. */
const hasSurface = (entity: Entity): boolean => !isSceneObject(entity) && !is2D(entity) && !isCurve3D(entity);

/**
 * @affects materials[material].appearance (+ color / metalness / roughness), or entities[id].appearance (+ color) for each valid id; affected = changed entity ids
 * @invariant exactly one of material / entityIds; the entity override is visual only (materialId, density and mass are untouched); the copy keeps libraryId
 * @failure unknown library id, unknown material, bad colour, both / neither target, no entity with a surface (light, camera, 2D, curve are skipped) -> no-op with APPEARANCE_* code
 */
export const applyAppearance = defineCommand({
  name: COMMAND,
  description:
    'Apply an appearance from the offline library (ids: ' +
    APPEARANCE_LIBRARY.map((entry) => entry.id).join(', ') +
    "; list_appearances describes them) to a material (every entity using it follows) or to entities as a visual override that beats the material's appearance " +
    '(mass and analysis keep the assigned material). Give exactly one of `material` or `entityIds`. `color` replaces the base colour (meant for "painted"). ' +
    'Replaces the previous appearance of the target; set_material_appearance refines it afterwards. Lights, cameras, 2D shapes and curves carry no surface and are skipped. ' +
    'Refusals carry error.code APPEARANCE_NOT_FOUND, APPEARANCE_MATERIAL_NOT_FOUND, APPEARANCE_TARGET_INVALID, APPEARANCE_PARAM_INVALID.',
  params: z.object({
    appearance: z
      .string()
      .describe(
        'Library id, e.g. "steel", "stainless", "galvanised", "painted", "concrete", "insulation_cladding", "glass", "rubber", "copper", "brass".',
      ),
    material: z
      .string()
      .optional()
      .describe('Material name (create_material) to give this appearance. Give exactly one of material or entityIds.'),
    entityIds: z
      .array(z.string())
      .optional()
      .describe('Entity ids that get the appearance as a visual override. Give exactly one of material or entityIds.'),
    color: z.string().optional().describe('Hex "#rrggbb" that replaces the base colour of the library appearance (e.g. the paint colour).'),
  }),
  run: (doc, params): CommandResult => {
    const entry = libraryAppearance(params.appearance);
    if (entry === undefined)
      return refuseAppearance(
        doc,
        COMMAND,
        'APPEARANCE_NOT_FOUND',
        `no library appearance '${params.appearance}' (known: ${APPEARANCE_LIBRARY.map((e) => e.id).join(', ')})`,
        { path: 'appearance' },
      );
    if (params.color !== undefined && !isHexColor(params.color))
      return refuseAppearance(doc, COMMAND, 'APPEARANCE_PARAM_INVALID', `color must be a "#rrggbb" hex colour, got '${params.color}'`, {
        path: 'color',
      });
    if ((params.material === undefined) === (params.entityIds === undefined) || params.entityIds?.length === 0)
      return refuseAppearance(doc, COMMAND, 'APPEARANCE_TARGET_INVALID', 'give exactly one of material or a non-empty entityIds', {
        path: 'material',
      });
    const appearance: Appearance = {
      ...entry.appearance,
      ...(params.color !== undefined ? { baseColor: { ...entry.appearance.baseColor, value: params.color } } : {}),
      libraryId: entry.id,
    };
    if (params.material !== undefined) {
      const material = Object.hasOwn(doc.materials, params.material) ? doc.materials[params.material] : undefined;
      if (material === undefined)
        return refuseAppearance(doc, COMMAND, 'APPEARANCE_MATERIAL_NOT_FOUND', `no material '${params.material}'`, {
          ids: [params.material],
          path: 'material',
        });
      return changed(
        { ...doc, materials: { ...doc.materials, [params.material]: syncMaterial(material, appearance) } },
        `apply_appearance '${entry.id}' to material '${params.material}': ${describeAppearance(appearance)}.`,
        [],
      );
    }
    const targets = [...new Set(params.entityIds)].filter((id) => Object.hasOwn(doc.entities, id));
    const valid = targets.filter((id) => hasSurface(doc.entities[id] as Entity));
    const skipped = [...new Set(params.entityIds)].filter((id) => !valid.includes(id));
    if (valid.length === 0)
      return refuseAppearance(
        doc,
        COMMAND,
        'APPEARANCE_TARGET_INVALID',
        `no entity with a surface among: ${skipped.join(', ')} (missing, light, camera, 2D or curve)`,
        { ids: skipped, path: 'entityIds' },
      );
    const entities: Record<string, Entity> = { ...doc.entities };
    const color = appearance.baseColor?.value;
    for (const id of valid) entities[id] = { ...(entities[id] as Entity), appearance, ...(color !== undefined ? { color } : {}) };
    return changed(
      { ...doc, entities },
      `apply_appearance '${entry.id}' to ${valid.length} ${valid.length === 1 ? 'entity' : 'entities'} (${valid.join(', ')}): ${describeAppearance(appearance)}.` +
        (skipped.length > 0 ? ` Skipped (missing or without a surface): ${skipped.join(', ')}.` : ''),
      valid,
    );
  },
});

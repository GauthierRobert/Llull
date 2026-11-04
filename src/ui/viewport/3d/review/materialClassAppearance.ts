// Material classes in the viewport (plant 09 VIS-M8f): the pure resolution the renderers share, equal to `render_view`'s precedence
// (core `applyReviewStyle`): a matching profile rule, then the assigned class colour, then the profile default colour, then the entity colour.
// Metalness and roughness come from the assigned class only. Display only; no three.js, no React.

import { findMaterialClass } from '@core/geometry/materialClasses';
import type { DisplayModel, MaterialClass } from '@core/model/display';
import { is3D, type CadDocument, type Entity } from '@core/model/types';
import type { PbrMaterial } from '../useMaterialProps';

/** The class assigned to `entityId` (assign_material_class) when it still exists, else undefined. */
export function assignedClassOf(display: DisplayModel | undefined, entityId: string): MaterialClass | undefined {
  const assigned = display?.materialClassOf;
  if (assigned === undefined || !Object.hasOwn(assigned, entityId)) return undefined;
  const id = assigned[entityId];
  return id === undefined ? undefined : findMaterialClass(display, id);
}

/**
 * Colour an entity is drawn in: `ruleColour` (matching profile rule) > class colour (3D only) > `profileDefault` (3D only) > null (own colour).
 * @invariant `profileDefault` 'entity' or undefined leaves the entity alone
 */
export function resolveTintColour(
  display: DisplayModel | undefined,
  entity: Entity,
  ruleColour: string | null,
  profileDefault: string | undefined,
): string | null {
  if (ruleColour !== null) return ruleColour;
  if (!is3D(entity)) return null;
  const classColour = assignedClassOf(display, entity.id)?.colour ?? null;
  if (classColour !== null) return classColour;
  return profileDefault === undefined || profileDefault === 'entity' ? null : profileDefault;
}

/**
 * The PBR surface of a 3D entity: its document material, with the assigned class's metalness and roughness over it. Undefined when the
 * entity has neither (it keeps the renderer's default look).
 * @invariant the same object as `materials[materialId]` when no class is assigned (stable for memoized renderers)
 */
export function entityPbrMaterial(
  doc: { readonly display?: DisplayModel | undefined; readonly materials: CadDocument['materials'] },
  entity: Entity,
): PbrMaterial | undefined {
  const material = entity.materialId === undefined ? undefined : doc.materials[entity.materialId];
  const cls = is3D(entity) ? assignedClassOf(doc.display, entity.id) : undefined;
  if (cls === undefined) return material;
  const { finish } = material ?? {};
  return {
    color: material?.color ?? entity.color,
    metalness: cls.metalness,
    roughness: cls.roughness,
    ...(finish !== undefined && { finish }),
  };
}

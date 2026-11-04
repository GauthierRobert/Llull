// Material classes in the viewport (plant 09 VIS-M8f): the PBR surface of an entity. The colour chain is core's `resolveEntityColour` (the one
// `render_view` uses), called by `profileTints`. Metalness and roughness come from the assigned class only. No three.js, no React.

import { assignedMaterialClassIn } from '@core/geometry/materialClasses';
import type { DisplayModel } from '@core/model/display';
import { is3D, type CadDocument, type Entity } from '@core/model/types';
import type { PbrMaterial } from '../useMaterialProps';

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
  const cls = is3D(entity) ? assignedMaterialClassIn(doc.display, entity.id) : undefined;
  if (cls === undefined) return material;
  const { finish } = material ?? {};
  return {
    color: material?.color ?? entity.color,
    metalness: cls.metalness,
    roughness: cls.roughness,
    ...(finish !== undefined && { finish }),
  };
}

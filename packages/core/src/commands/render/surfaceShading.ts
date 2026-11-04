/**
 * Surface response of the entities of a render (plant 09 VIS §5.6): the metalness and roughness of each 3D entity's material class, which the
 * reference raster turns into a Blinn-Phong highlight. The class is the explicit assignment (`assign_material_class`), else the default of the
 * entity's kind that an installed plugin names in its entity properties (key `defaultMaterialClass`, e.g. a plant grating), else none.
 * @pure
 * @invariant undefined when no entity has a class, so a document without classes renders exactly as before; an explicit assignment wins; a
 *   default naming an unknown class is ignored; 2D shapes and curves never get a class
 */

import type { CadDocument } from '../../model/types';
import { is3D } from '../../model/types';
import { assignedMaterialClass, findMaterialClass } from '../../geometry/materialClasses';
import type { ExecutionContext } from '../types';
import type { SurfaceShading } from './types';

/** Property key a plugin sets to the id of the material class an entity gets when none is assigned. */
export const DEFAULT_MATERIAL_CLASS_KEY = 'defaultMaterialClass';

/** Shading of every 3D entity of `doc` that has a material class, or undefined when none has. */
export function surfaceShadingOf(doc: CadDocument, ctx: ExecutionContext | undefined): ReadonlyMap<string, SurfaceShading> | undefined {
  const shading = new Map<string, SurfaceShading>();
  for (const id of doc.order) {
    const entity = Object.hasOwn(doc.entities, id) ? doc.entities[id] : undefined;
    if (entity === undefined || !is3D(entity)) continue;
    let materialClass = assignedMaterialClass(doc, id);
    if (materialClass === undefined && ctx?.properties !== undefined) {
      const defaultId = ctx.properties(doc, id)[DEFAULT_MATERIAL_CLASS_KEY];
      if (typeof defaultId === 'string') materialClass = findMaterialClass(doc.display, defaultId);
    }
    if (materialClass !== undefined) shading.set(id, { metalness: materialClass.metalness, roughness: materialClass.roughness });
  }
  return shading.size === 0 ? undefined : shading;
}

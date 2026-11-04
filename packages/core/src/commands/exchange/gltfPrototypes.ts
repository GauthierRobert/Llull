/** Exact shape key of a placed solid: equal keys guarantee bit-identical local triangles (the gpu export tessellates one solid per key). */

import type { Entity } from '../../model/types';
import { NON_GEOMETRY_KEYS, prototypeKeyOf } from '../../geometry/renderPlan';

/**
 * Shape key of a solid with parameters kept at full precision (`prototypeKeyOf` rounds to 6 figures, so it can merge solids whose triangles differ
 * in the last bits); meshes hash their vertex / index data.
 * @invariant same key => same local-frame triangles (position, rotation, colour, layer, name, material and decals never change them)
 */
export function exactShapeKeyOf(entity: Entity): string {
  if (entity.kind === 'mesh') return prototypeKeyOf(entity);
  const shape = Object.entries(entity).filter(([key]) => !NON_GEOMETRY_KEYS.has(key));
  return `${entity.kind}|${JSON.stringify(shape)}`;
}

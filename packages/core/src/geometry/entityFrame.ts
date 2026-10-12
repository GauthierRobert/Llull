/**
 * Entity-local to world placement.
 *
 * @layer geometry
 * @pure
 */

import type { Entity, Vec3 } from '../model/types';
import { applyEulerXYZ } from '../lib/eulerRotation';
import { ORIGIN, add3 } from '../lib/vec3';

/** Entity-local point -> world: Euler XYZ `rotation` about the entity origin, then `position`. */
export function entityLocalToWorld(
  entity: Pick<Entity, 'position' | 'rotation'>,
  local: Vec3,
): Vec3 {
  return add3(applyEulerXYZ(local, ORIGIN, entity.rotation), entity.position);
}

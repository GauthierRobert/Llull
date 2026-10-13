/**
 * Entity-local to world placement.
 *
 * @layer geometry
 * @pure
 */

import type { Entity, Vec2, Vec3 } from '../model/types';
import { applyEulerXYZ } from '../lib/eulerRotation';
import { planPoint } from '../lib/vec2';
import { ORIGIN, add3 } from '../lib/vec3';

/** Entity-local point -> world: Euler XYZ `rotation` about the entity origin, then `position`. */
export function entityLocalToWorld(entity: Pick<Entity, 'position' | 'rotation'>, local: Vec3): Vec3 {
  return add3(applyEulerXYZ(local, ORIGIN, entity.rotation), entity.position);
}

/** Plan (x, y) of an entity-local point: rotated about Z by `rotation[2]`, then translated by `position`. */
export function entityPlanPoint(entity: { readonly position: Vec3; readonly rotation: Vec3 }, [x, y]: Vec2): Vec2 {
  return planPoint(entity.position, entity.rotation[2], [x, y]);
}

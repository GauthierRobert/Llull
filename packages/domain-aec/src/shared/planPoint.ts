/**
 * Entity-local 2D point to world plan coordinates.
 * @layer domain-aec/shared
 * @pure
 */

import type { Vec2, Vec3 } from '@core/model/types';

/** Plan (x, y) of an entity-local point: rotated about Z by `rotation[2]`, then translated by `position`. */
export function entityPlanPoint(
  entity: { readonly position: Vec3; readonly rotation: Vec3 },
  [x, y]: Vec2,
): Vec2 {
  const cos = Math.cos(entity.rotation[2]);
  const sin = Math.sin(entity.rotation[2]);
  return [entity.position[0] + x * cos - y * sin, entity.position[1] + x * sin + y * cos];
}

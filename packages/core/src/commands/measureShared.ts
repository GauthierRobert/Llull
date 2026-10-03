import type { Entity, Vec3 } from '../model/types';
import { entityBounds } from './sceneBounds';

/** Entity centroid: midpoint of its world-space AABB. */
export function centroid(e: Entity): Vec3 {
  const b = entityBounds(e);
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
}

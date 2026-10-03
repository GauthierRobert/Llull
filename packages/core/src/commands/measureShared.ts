import type { Entity, Vec3 } from '../model/types';
import { entityBounds } from './sceneBounds';

export function vec3Distance(a: Vec3, b: Vec3): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Entity centroid: midpoint of its world-space AABB. */
export function centroid(e: Entity): Vec3 {
  const b = entityBounds(e);
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
}

// ---------------------------------------------------------------------------
// 1. measure_distance
// ---------------------------------------------------------------------------

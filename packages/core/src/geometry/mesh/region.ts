/** Spherical working region of a mesh edit: vertices inside move, vertices outside stay fixed (07 MSH `region` / `lockedRegion`). */

import type { Vec3 } from '../../model/vectors';

export interface SphereRegion {
  readonly center: Vec3;
  readonly radius: number;
}

/** True when `p` is inside `region` (always true without a region). */
export function insideRegion(region: SphereRegion | undefined, p: Vec3): boolean {
  if (region === undefined) return true;
  return Math.hypot(p[0] - region.center[0], p[1] - region.center[1], p[2] - region.center[2]) <= region.radius;
}

/**
 * Work-plane placement of 2D geometry.
 *
 * @layer geometry
 * @pure
 */

import type { Vec2, Vec3 } from '../model/vectors';
import { applyEulerXYZ } from '../lib/eulerRotation';
import { ORIGIN, add3 } from '../lib/vec3';

/** World point of work-plane `local` [x, y]: Euler `rotation` about the plane origin, then `position`. */
export function planeToWorld(position: Vec3, rotation: Vec3, local: Vec2): Vec3 {
  return add3(applyEulerXYZ([local[0], local[1], 0], ORIGIN, rotation), position);
}

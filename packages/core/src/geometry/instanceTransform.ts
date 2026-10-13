/** The affine an instance applies to its component's geometry. */

import type { Vec3 } from '../model/vectors';
import { applyEulerXYZ, isZeroRotation } from '../lib/eulerRotation';
import { ORIGIN, add3 } from '../lib/vec3';

/** Maps a component-space point to world: scale, then rotate about the component origin, then translate. */
export function instanceToWorld(scale: Vec3, rotation: Vec3, position: Vec3): (point: Vec3) => Vec3 {
  const hasRotation = !isZeroRotation(rotation);
  return (point) => {
    const scaled: Vec3 = [point[0] * scale[0], point[1] * scale[1], point[2] * scale[2]];
    return add3(hasRotation ? applyEulerXYZ(scaled, ORIGIN, rotation) : scaled, position);
  };
}

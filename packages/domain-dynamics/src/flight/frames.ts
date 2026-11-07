/** Body-frame rotation of the flight laws: unit quaternions [w, x, y, z] taking body-fixed vectors (modelled pose) into the world. */

import type { Quaternion, Vec3 } from '@core/model/vectors';

/** q · v · q* (body-fixed vector at the modelled pose -> world). */
export function rotate(q: Quaternion, v: Vec3): Vec3 {
  const [w, x, y, z] = q;
  // t = 2 (q_v × v); v' = v + w t + q_v × t
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/** q* · v · q (world vector -> body axes at the modelled pose). */
export function rotateInverse(q: Quaternion, v: Vec3): Vec3 {
  return rotate([q[0], -q[1], -q[2], -q[3]], v);
}

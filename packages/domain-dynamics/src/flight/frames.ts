/** Body-frame rotation of the flight laws: unit quaternions [w, x, y, z] taking body-fixed vectors (modelled pose) into the world, and the
 * attitude algebra of the flight controller. */

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

/** Inverse of a unit quaternion. */
export const conjugate = (q: Quaternion): Quaternion => [q[0], -q[1], -q[2], -q[3]];

/** Unit quaternion of the rotation whose matrix has columns b1, b2, b3 (an orthonormal right-handed basis), Shepperd's method. */
export function quaternionFromBasis(b1: Vec3, b2: Vec3, b3: Vec3): Quaternion {
  const [m00, m10, m20] = b1;
  const [m01, m11, m21] = b2;
  const [m02, m12, m22] = b3;
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = 2 * Math.sqrt(trace + 1);
    return [0.25 * s, (m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s];
  }
  if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    return [(m21 - m12) / s, 0.25 * s, (m01 + m10) / s, (m02 + m20) / s];
  }
  if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    return [(m02 - m20) / s, (m01 + m10) / s, 0.25 * s, (m12 + m21) / s];
  }
  const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
  return [(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, 0.25 * s];
}

/** Shortest rotation taking unit vector `from` onto unit vector `to` (a half-turn about an axis normal to `from` when they are opposite). */
export function shortestArc(from: Vec3, to: Vec3): Quaternion {
  const c = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];
  const axis: Vec3 = [from[1] * to[2] - from[2] * to[1], from[2] * to[0] - from[0] * to[2], from[0] * to[1] - from[1] * to[0]];
  if (c < -1 + 1e-12) {
    const normal: Vec3 = Math.abs(from[0]) < 0.9 ? [0, -from[2], from[1]] : [-from[2], 0, from[0]];
    const length = Math.hypot(normal[0], normal[1], normal[2]);
    return [0, normal[0] / length, normal[1] / length, normal[2] / length];
  }
  const w = 1 + c;
  const length = Math.hypot(w, axis[0], axis[1], axis[2]);
  return [w / length, axis[0] / length, axis[1] / length, axis[2] / length];
}

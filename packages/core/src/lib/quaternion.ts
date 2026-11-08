/** Unit-quaternion algebra ([w, x, y, z], MuJoCo's order): shared by the physics adapter and the flight laws. */

import type { Quaternion } from '../model/vectors';

/** Quaternion product a · b. */
export function multiplyQuaternion(a: Quaternion, b: Quaternion): Quaternion {
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

/** a · conj(b): the rotation from orientation b to orientation a. */
export function relativeQuaternion(a: Quaternion, b: Quaternion): Quaternion {
  return multiplyQuaternion(a, [b[0], -b[1], -b[2], -b[3]]);
}

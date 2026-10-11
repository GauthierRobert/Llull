/**
 * Domain-aec 3D vector helpers not in `@lib/vec3` (zero-preserving normalize, midpoint).
 * @layer domain-aec
 * @pure
 */

import type { Vec3 } from '@core/model/types';

/** Unit vector; the zero vector stays zero. */
export const normalize = (a: Vec3): Vec3 => {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
};

export const midpoint = (a: Vec3, b: Vec3): Vec3 => [
  (a[0] + b[0]) / 2,
  (a[1] + b[1]) / 2,
  (a[2] + b[2]) / 2,
];

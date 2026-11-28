/** 3x4 row-major affine transforms (local -> world) for the path-traced scene (RV1 §5b `instances.f64`). @pure */

import type { Vec3 } from '../../../model/vectors';
import { applyEulerXYZ } from '../../../lib/eulerRotation';

/** [r00 r01 r02 tx, r10 r11 r12 ty, r20 r21 r22 tz]. */
export type Affine = readonly [number, number, number, number, number, number, number, number, number, number, number, number];

export const IDENTITY: Affine = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

const ORIGIN: Vec3 = [0, 0, 0];

/** T(position) · R(euler XYZ, as `applyEulerXYZ`) · S(scale). */
export function placement(position: Vec3, rotation: Vec3, scale: Vec3 = [1, 1, 1]): Affine {
  const x = applyEulerXYZ([scale[0], 0, 0], ORIGIN, rotation);
  const y = applyEulerXYZ([0, scale[1], 0], ORIGIN, rotation);
  const z = applyEulerXYZ([0, 0, scale[2]], ORIGIN, rotation);
  return [x[0], y[0], z[0], position[0], x[1], y[1], z[1], position[1], x[2], y[2], z[2], position[2]];
}

/** a · b (b applies first). */
export function compose(a: Affine, b: Affine): Affine {
  const out: number[] = [];
  for (let row = 0; row < 3; row += 1) {
    const r = row * 4;
    const [a0, a1, a2, a3] = [a[r], a[r + 1], a[r + 2], a[r + 3]] as [number, number, number, number];
    for (let col = 0; col < 4; col += 1) {
      const value = a0 * (b[col] as number) + a1 * (b[4 + col] as number) + a2 * (b[8 + col] as number);
      out.push(col === 3 ? value + a3 : value);
    }
  }
  return out as unknown as Affine;
}

export function transformPoint(m: Affine, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
  ];
}

/**
 * Axis-direction rotations in the repo's Euler convention (three.js intrinsic 'XYZ': M = Rx·Ry·Rz,
 * see `eulerRotation.ts`). Matrices are row-major 3x3 as 9-tuples.
 *
 * @layer lib
 * @pure
 */

import type { Vec3 } from '../model/vectors';
import { clamp } from './clamp';
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

const EPSILON = 1e-9;

/** Unit vector of `v`, or `null` when `v` is not 3 finite numbers or has (near-)zero length. */
export function unitAxisOrNull(v: unknown): Vec3 | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const [x, y, z] = v as unknown[];
  if (![x, y, z].every((c) => typeof c === 'number' && Number.isFinite(c))) return null;
  const [a, b, c] = [x as number, y as number, z as number];
  const length = Math.hypot(a, b, c);
  return length > EPSILON ? [a / length, b / length, c / length] : null;
}

/** Matrix product a · b. */
export function mulMat3(a: Mat3, b: Mat3): Mat3 {
  const at = (r: number, c: number): number =>
    (a[r * 3] ?? 0) * (b[c] ?? 0) + (a[r * 3 + 1] ?? 0) * (b[3 + c] ?? 0) + (a[r * 3 + 2] ?? 0) * (b[6 + c] ?? 0);
  return [at(0, 0), at(0, 1), at(0, 2), at(1, 0), at(1, 1), at(1, 2), at(2, 0), at(2, 1), at(2, 2)];
}

/** Rotate `v` by `m`. */
export function applyMat3(m: Mat3, v: Vec3): [number, number, number] {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

/** Rotation by `angle` radians about the unit vector `u` (Rodrigues). */
export function matFromAxisAngle(u: Vec3, angle: number): Mat3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  const [x, y, z] = u;
  return [
    t * x * x + c,
    t * x * y - s * z,
    t * x * z + s * y,
    t * x * y + s * z,
    t * y * y + c,
    t * y * z - s * x,
    t * x * z - s * y,
    t * y * z + s * x,
    t * z * z + c,
  ];
}

/** Matrix of an Euler XYZ rotation (M = Rx·Ry·Rz). */
export function matFromEulerXYZ(euler: Vec3): Mat3 {
  const [rx, ry, rz] = euler;
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(rx), Math.sin(rx), Math.cos(ry), Math.sin(ry), Math.cos(rz), Math.sin(rz)];
  return [
    cy * cz,
    -cy * sz,
    sy,
    cx * sz + sx * sy * cz,
    cx * cz - sx * sy * sz,
    -sx * cy,
    sx * sz - cx * sy * cz,
    sx * cz + cx * sy * sz,
    cx * cy,
  ];
}

/** Euler XYZ angles of a rotation matrix (inverse of `matFromEulerXYZ`; gimbal lock sets rz = 0). */
export function eulerFromMat(m: Mat3): [number, number, number] {
  const ry = Math.asin(clamp(m[2], -1, 1));
  if (Math.abs(m[2]) < 0.9999999) return [Math.atan2(-m[5], m[8]), ry, Math.atan2(-m[1], m[0])];
  return [Math.atan2(m[7], m[4]), ry, 0];
}

/** Rotation taking local +Z onto the unit vector `axis` by the shortest arc. */
function alignZ(axis: Vec3): Mat3 {
  const [ax, ay, az] = axis;
  if (az < -1 + EPSILON) return matFromAxisAngle([1, 0, 0], Math.PI);
  const k = 1 / (1 + az);
  return [1 - ax * ax * k, -ax * ay * k, ax, -ax * ay * k, 1 - ay * ay * k, ay, -ax, -ay, 1 - (ax * ax + ay * ay) * k];
}

/** Rotation matrix sending local +Z to `axis` (any non-zero direction) after spinning `spin` rad about +Z. */
export function matFromAxis(axis: Vec3, spin = 0): Mat3 {
  const align = alignZ(axis);
  return spin === 0 ? align : mulMat3(align, matFromAxisAngle([0, 0, 1], spin));
}

/**
 * Euler XYZ angles (radians) of the rotation sending local +Z to `axis` (normalized here), after
 * spinning `spin` radians about local +Z first. `null` for a zero or malformed axis.
 */
export function eulerFromAxis(axis: unknown, spin = 0): [number, number, number] | null {
  const u = unitAxisOrNull(axis);
  return u ? eulerFromMat(matFromAxis(u, spin)) : null;
}

/** 4x4 column-major matrices for import_gltf: node transforms (matrix or T / R / S), composition, point transform and T / Euler XYZ / S decomposition. */

import type { Vec3 } from '../../model/types';

/** Column-major 4x4 (glTF layout: element (row r, column c) at c * 4 + r). */
export type Mat4 = readonly number[];

export const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** a · b (b applies first). */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out: number[] = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += (a[k * 4 + r] ?? 0) * (b[c * 4 + k] ?? 0);
      out[c * 4 + r] = sum;
    }
  return out;
}

/** T · R · S of a translation, a quaternion [x, y, z, w] (normalized here; zero length -> identity rotation) and a per-axis scale. */
export function fromTrs(t: readonly number[], q: readonly number[], s: readonly number[]): Mat4 {
  const [qx0 = 0, qy0 = 0, qz0 = 0, qw0 = 1] = q;
  const length = Math.hypot(qx0, qy0, qz0, qw0);
  const [x, y, z, w] = length > 1e-12 ? [qx0 / length, qy0 / length, qz0 / length, qw0 / length] : [0, 0, 0, 1];
  const [sx = 1, sy = 1, sz = 1] = s;
  return [
    (1 - 2 * (y * y + z * z)) * sx,
    2 * (x * y + z * w) * sx,
    2 * (x * z - y * w) * sx,
    0,
    2 * (x * y - z * w) * sy,
    (1 - 2 * (x * x + z * z)) * sy,
    2 * (y * z + x * w) * sy,
    0,
    2 * (x * z + y * w) * sz,
    2 * (y * z - x * w) * sz,
    (1 - 2 * (x * x + y * y)) * sz,
    0,
    t[0] ?? 0,
    t[1] ?? 0,
    t[2] ?? 0,
    1,
  ];
}

/** `m` applied to the point (x, y, z). */
export function transformPoint(m: Mat4, x: number, y: number, z: number): Vec3 {
  return [
    (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0),
    (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0),
    (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0),
  ];
}

/** Determinant of the upper-left 3x3 (negative: the matrix mirrors, so triangle winding flips). */
export function determinant3(m: Mat4): number {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0, i = 0] = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  return a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e);
}

/** A matrix split as world = T · R(Euler XYZ) · S, the form of an instance entity. */
export interface Decomposed {
  readonly position: Vec3;
  readonly rotation: Vec3;
  readonly scale: Vec3;
}

/** Cosine between two unit columns above which the matrix counts as sheared. */
const SHEAR_TOLERANCE = 1e-5;

/**
 * `m` as T · R · S with positive scales, or why it cannot be one: "degenerate" (a zero-length column), "mirrored" (negative determinant) or
 * "sheared" (columns not orthogonal, e.g. a non-uniform parent scale over a rotation).
 */
export function decompose(m: Mat4): Decomposed | 'degenerate' | 'mirrored' | 'sheared' {
  const column = (c: number): [number, number, number] => [m[c * 4] ?? 0, m[c * 4 + 1] ?? 0, m[c * 4 + 2] ?? 0];
  const columns: [Vec3, Vec3, Vec3] = [column(0), column(1), column(2)];
  const scale = columns.map((v) => Math.hypot(v[0], v[1], v[2]));
  if (scale.some((s) => !(s > 1e-12))) return 'degenerate';
  if (determinant3(m) < 0) return 'mirrored';
  const unit = (c: 0 | 1 | 2): Vec3 => {
    const [v, length] = [columns[c], scale[c] ?? 1];
    return [v[0] / length, v[1] / length, v[2] / length];
  };
  const [u0, u1, u2] = [unit(0), unit(1), unit(2)];
  const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if ([dot(u0, u1), dot(u0, u2), dot(u1, u2)].some((v) => Math.abs(v) > SHEAR_TOLERANCE)) return 'sheared';
  // R = [u0 u1 u2] as columns; intrinsic Euler XYZ (R = Rx · Ry · Rz).
  const m13 = u2[0];
  const y = Math.asin(Math.max(-1, Math.min(1, m13)));
  const [x, z] = Math.abs(m13) < 0.9999999 ? [Math.atan2(-u2[1], u2[2]), Math.atan2(-u1[0], u0[0])] : [Math.atan2(u1[2], u1[1]), 0];
  return { position: [m[12] ?? 0, m[13] ?? 0, m[14] ?? 0], rotation: [x, y, z], scale: [scale[0] ?? 1, scale[1] ?? 1, scale[2] ?? 1] };
}

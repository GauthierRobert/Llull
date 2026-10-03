import type { Vec3 } from '../model/types';

/** @pure component-wise a + b */
export function add3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

/** @pure component-wise a - b */
export function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/** @pure a * s */
export function scale3(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

/** @pure dot product */
export function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** @pure cross product a × b */
export function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** @pure Euclidean length */
export function len3(a: Vec3): number {
  return Math.sqrt(dot3(a, a));
}

/** @pure unit vector; `[0, 0, 1]` for (near-)zero-length input */
export function normalize3(a: Vec3): Vec3 {
  const l = len3(a);
  return l > 1e-10 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
}

/**
 * `value` as a Vec3 when it is an array of 3 finite numbers, else `[0, 0, 0]`. Never throws.
 * @param allowExtraComponents true ⇒ arrays longer than 3 are accepted (first three used)
 */
export function finiteVec3OrZero(value: unknown, allowExtraComponents = false): Vec3 {
  if (!Array.isArray(value)) return [0, 0, 0];
  if (allowExtraComponents ? value.length < 3 : value.length !== 3) return [0, 0, 0];
  const [x, y, z] = value as unknown[];
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return [0, 0, 0];
  return [x as number, y as number, z as number];
}

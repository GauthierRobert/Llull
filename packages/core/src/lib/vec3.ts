import type { Vec3 } from '../model/vectors';
import { isFiniteNumber } from './isFiniteNumber';

export function isVec3(value: unknown): value is Vec3 {
  return Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber);
}

/** The world origin `[0, 0, 0]`. */
export const ORIGIN: Vec3 = Object.freeze<Vec3>([0, 0, 0]);

export function centroid3(points: readonly Vec3[]): Vec3 {
  if (points.length === 0) return [0, 0, 0];
  return scale3(
    points.reduce<Vec3>((sum, p) => add3(sum, p), [0, 0, 0]),
    1 / points.length,
  );
}

export function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return add3(a, scale3(sub3(b, a), t));
}

export function add3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale3(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function len3(a: Vec3): number {
  return Math.sqrt(dot3(a, a));
}

export function distanceSq3(a: Vec3, b: Vec3): number {
  const delta = sub3(a, b);
  return dot3(delta, delta);
}

export function distance3(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function map3(a: Vec3, f: (component: number, axis: 0 | 1 | 2) => number): Vec3 {
  return [f(a[0], 0), f(a[1], 1), f(a[2], 2)];
}

export function vec3At(values: readonly number[], offset: number): Vec3 {
  return [values[offset] ?? 0, values[offset + 1] ?? 0, values[offset + 2] ?? 0];
}

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

/** Unit vector (`Math.hypot` length); the zero vector stays zero. */
export function normalize3OrZero(a: Vec3): Vec3 {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
}

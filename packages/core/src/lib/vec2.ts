import type { Vec2 } from '../model/types';

/** @pure component-wise a + b */
export function add2(a: Vec2, b: Vec2): Vec2 {
  return [a[0] + b[0], a[1] + b[1]];
}

/** @pure component-wise a - b */
export function sub2(a: Vec2, b: Vec2): Vec2 {
  return [a[0] - b[0], a[1] - b[1]];
}

/** @pure a * s */
export function scale2(a: Vec2, s: number): Vec2 {
  return [a[0] * s, a[1] * s];
}

/** @pure dot product */
export function dot2(a: Vec2, b: Vec2): number {
  return a[0] * b[0] + a[1] * b[1];
}

/** @pure z-component of a × b; > 0 when b is counter-clockwise from a */
export function cross2(a: Vec2, b: Vec2): number {
  return a[0] * b[1] - a[1] * b[0];
}

/** @pure Euclidean length */
export function len2(a: Vec2): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1]);
}

/** @pure unit vector; `fallback` for (near-)zero-length input */
export function normalize2(a: Vec2, fallback: Vec2 = [0, 0]): Vec2 {
  const l = len2(a);
  return l < 1e-12 ? fallback : [a[0] / l, a[1] / l];
}

/** @pure left perpendicular (90° counter-clockwise) */
export function perp2(a: Vec2): Vec2 {
  return [-a[1], a[0]];
}

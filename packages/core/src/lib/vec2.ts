import type { Vec2 } from '../model/vectors';

export function add2(a: Vec2, b: Vec2): Vec2 {
  return [a[0] + b[0], a[1] + b[1]];
}

export function sub2(a: Vec2, b: Vec2): Vec2 {
  return [a[0] - b[0], a[1] - b[1]];
}

export function scale2(a: Vec2, s: number): Vec2 {
  return [a[0] * s, a[1] * s];
}

export function dot2(a: Vec2, b: Vec2): number {
  return a[0] * b[0] + a[1] * b[1];
}

export function planPoint(center: readonly [number, number, ...number[]], angle: number, [u, v]: Vec2): Vec2 {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [center[0] + u * cos - v * sin, center[1] + u * sin + v * cos];
}

export function cross2(a: Vec2, b: Vec2): number {
  return a[0] * b[1] - a[1] * b[0];
}

export function orient2(o: Vec2, a: Vec2, b: Vec2): number {
  return cross2(sub2(a, o), sub2(b, o));
}

export function len2(a: Vec2): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1]);
}

export function normalize2(a: Vec2, fallback: Vec2 = [0, 0]): Vec2 {
  const l = len2(a);
  return l < 1e-12 ? fallback : [a[0] / l, a[1] / l];
}

export function lerp2(a: Vec2, b: Vec2, t: number): Vec2 {
  return add2(a, scale2(sub2(b, a), t));
}

export function centroid2(points: ReadonlyArray<Vec2>): Vec2 {
  const count = Math.max(points.length, 1);
  return [points.reduce((sum, p) => sum + p[0], 0) / count, points.reduce((sum, p) => sum + p[1], 0) / count];
}

export function perp2(a: Vec2): Vec2 {
  return [-a[1], a[0]];
}

export function isVec2(value: unknown): value is Vec2 {
  return Array.isArray(value) && value.length === 2 && value.every((c) => typeof c === 'number' && Number.isFinite(c));
}

export function isVec2List(value: unknown): value is Vec2[] {
  return Array.isArray(value) && value.every(isVec2);
}

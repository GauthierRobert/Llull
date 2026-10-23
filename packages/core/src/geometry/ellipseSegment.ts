/**
 * Pure math of the exact quarter-ellipse curve segment `{ type: 'ellipse', points: [start, center, end] }` (see `model/curve.ts`):
 * P(t) = C + cos(πt/2)·u + sin(πt/2)·v with u = start − C, v = end − C (conjugate semi-diameters). 2D points are lifted to z = 0.
 * @invariant u and v are not collinear, so the segment is a non-degenerate quarter of an ellipse (u ⟂ v gives the axis-aligned case)
 */

import type { Vec2, Vec3 } from '../model/types';
import { add3, cross3, dot3, len3, scale3, sub3 } from '../lib/vec3';

type Point = Vec2 | Vec3;
type Triple = readonly [Point, Point, Point];

const lift = (p: Point): Vec3 => [p[0], p[1], p[2] ?? 0];

/** Gauss-Legendre rule of `order` points on [-1, 1] (Newton on the Legendre polynomial). */
function gaussRule(order: number): ReadonlyArray<readonly [number, number]> {
  const rule: Array<readonly [number, number]> = [];
  for (let i = 0; i < order; i++) {
    let x = Math.cos((Math.PI * (i + 0.75)) / (order + 0.5));
    let derivative = 1;
    for (let iteration = 0; iteration < 100; iteration++) {
      let p0 = 1;
      let p1 = x;
      for (let k = 2; k <= order; k++) [p0, p1] = [p1, ((2 * k - 1) * x * p1 - (k - 1) * p0) / k];
      derivative = (order * (x * p1 - p0)) / (x * x - 1);
      const step = p1 / derivative;
      x -= step;
      if (Math.abs(step) < 1e-16) break;
    }
    rule.push([x, 2 / ((1 - x * x) * derivative * derivative)]);
  }
  return rule;
}

const GAUSS_32 = gaussRule(32);

/** ∫₀¹ f(t) dt by 32-point Gauss-Legendre (machine precision for the smooth integrands of an ellipse quarter). */
export function integrateUnit(f: (t: number) => number): number {
  return GAUSS_32.reduce((sum, [x, w]) => sum + (w / 2) * f((x + 1) / 2), 0);
}

function semiDiameters(points: Triple): { center: Vec3; u: Vec3; v: Vec3 } {
  const [start, center, end] = points.map(lift) as [Vec3, Vec3, Vec3];
  return { center, u: sub3(start, center), v: sub3(end, center) };
}

/** Point at t in [0, 1]. */
export function ellipsePoint(points: Triple, t: number): Vec3 {
  const { center, u, v } = semiDiameters(points);
  const angle = (Math.PI / 2) * t;
  return add3(center, add3(scale3(u, Math.cos(angle)), scale3(v, Math.sin(angle))));
}

/** dP/dt (not normalised). */
export function ellipseVelocity(points: Triple, t: number): Vec3 {
  const { u, v } = semiDiameters(points);
  const angle = (Math.PI / 2) * t;
  return scale3(add3(scale3(u, -Math.sin(angle)), scale3(v, Math.cos(angle))), Math.PI / 2);
}

/** @failure non-finite points, or start / centre / end collinear -> reason string */
export function ellipseIssue(points: Triple): string | null {
  if (!points.every((p) => p.every(Number.isFinite))) return 'has a non-finite point';
  const { u, v } = semiDiameters(points);
  const area = len3(cross3(u, v));
  return area <= 1e-9 * len3(u) * len3(v) || area === 0 ? 'has collinear start, centre and end' : null;
}

/** Arc length (elliptic integral by Gauss-Legendre). */
export function ellipseLength(points: Triple): number {
  return integrateUnit((t) => len3(ellipseVelocity(points, t)));
}

/** Curvature (1 / radius) at t in [0, 1]. */
export function ellipseCurvature(points: Triple, t: number): number {
  const { u, v } = semiDiameters(points);
  const angle = (Math.PI / 2) * t;
  const d1 = add3(scale3(u, -Math.sin(angle)), scale3(v, Math.cos(angle)));
  const d2 = scale3(add3(scale3(u, Math.cos(angle)), scale3(v, Math.sin(angle))), -1);
  return len3(cross3(d1, d2)) / len3(d1) ** 3;
}

/** Smallest radius of curvature on the quarter (sampled at 65 parameters, ends included). */
export function ellipseMinRadius(points: Triple): number {
  let most = 0;
  for (let s = 0; s <= 64; s++) most = Math.max(most, ellipseCurvature(points, s / 64));
  return most > 1e-12 ? 1 / most : Infinity;
}

/**
 * Principal axes of the ellipse: centre, unit directions of the major / minor axes and semi-lengths a >= b, and the plane normal u × v
 * (the sense start -> end is counter-clockwise about it).
 */
export function ellipseAxes(points: Triple): { center: Vec3; majorDir: Vec3; minorDir: Vec3; a: number; b: number; normal: Vec3 } {
  const { center, u, v } = semiDiameters(points);
  const theta = 0.5 * Math.atan2(2 * dot3(u, v), dot3(u, u) - dot3(v, v));
  const p = add3(scale3(u, Math.cos(theta)), scale3(v, Math.sin(theta)));
  const q = add3(scale3(u, -Math.sin(theta)), scale3(v, Math.cos(theta)));
  const [major, minor] = len3(p) >= len3(q) ? [p, q] : [q, p];
  const a = len3(major);
  const b = len3(minor);
  return { center, majorDir: scale3(major, 1 / a), minorDir: scale3(minor, 1 / b), a, b, normal: cross3(u, v) };
}

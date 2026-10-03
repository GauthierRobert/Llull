import type { Vec2 } from '../model/types';

// ---------------------------------------------------------------------------
// Internal pure geometry helpers (exported for unit-testing)
// ---------------------------------------------------------------------------

/**
 * 2D cross product (scalar z-component of a × b).
 * Positive → b is CCW from a; negative → CW.
 */
export function cross2(a: Vec2, b: Vec2): number {
  return a[0] * b[1] - a[1] * b[0];
}

/** Dot product of two 2D vectors. */
export function dot2(a: Vec2, b: Vec2): number {
  return a[0] * b[0] + a[1] * b[1];
}

/** Length of a 2D vector. */
export function len2(v: Vec2): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1]);
}

/** Normalize a 2D vector. Returns [0,0] if the input has zero length. */
export function normalize2(v: Vec2): Vec2 {
  const l = len2(v);
  if (l < 1e-12) return [0, 0];
  return [v[0] / l, v[1] / l];
}

/** Left-perpendicular of v (90° CCW). */
export function perp2(v: Vec2): Vec2 {
  return [-v[1], v[0]];
}

/**
 * Segment intersection — parametric.
 *
 * Returns { t, u } such that:
 *   P(t) = p + t*(q-p)   (on segment pq, valid for t ∈ [0,1])
 *   Q(u) = r + u*(s-r)   (on segment rs, valid for u ∈ [0,1])
 *
 * Returns null if lines are parallel / collinear.
 * Does NOT clamp t/u — callers decide whether [0,1] is required.
 */
export function segIntersect(p: Vec2, q: Vec2, r: Vec2, s: Vec2): { t: number; u: number } | null {
  const dx1 = q[0] - p[0];
  const dy1 = q[1] - p[1];
  const dx2 = s[0] - r[0];
  const dy2 = s[1] - r[1];
  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-12) return null; // parallel or collinear
  const dx3 = r[0] - p[0];
  const dy3 = r[1] - p[1];
  const t = (dx3 * dy2 - dy3 * dx2) / denom;
  const u = (dx3 * dy1 - dy3 * dx1) / denom;
  return { t, u };
}

/**
 * Compute the point on the infinite line through p→q at parameter t.
 */
export function evalLine(p: Vec2, q: Vec2, t: number): Vec2 {
  return [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])];
}

/**
 * Offset a single segment (p→q) by `distance` (positive = left of travel direction).
 * Returns the two endpoints of the offset segment.
 */
export function offsetSegment(p: Vec2, q: Vec2, distance: number): [Vec2, Vec2] {
  const dir: Vec2 = [q[0] - p[0], q[1] - p[1]];
  const n = normalize2(perp2(dir));
  const dp: Vec2 = [distance * n[0], distance * n[1]];
  return [
    [p[0] + dp[0], p[1] + dp[1]],
    [q[0] + dp[0], q[1] + dp[1]],
  ];
}

/**
 * Miter-join two consecutive offset segments.
 * Given the endpoints of two consecutive offset segments [a0,a1] and [b0,b1],
 * returns the intersection of the infinite lines through them (the miter point).
 * Falls back to a[1] (simple butt join) if the lines are parallel.
 */
export function miterJoin(a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2): Vec2 {
  const hit = segIntersect(a0, a1, b0, b1);
  if (hit === null) return a1; // parallel — butt join
  return evalLine(a0, a1, hit.t);
}

// ---------------------------------------------------------------------------
// Document helpers
// ---------------------------------------------------------------------------

import type { Vec2 } from '../model/types';
import { normalize2, perp2, sub2 } from '../lib/vec2';

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
  const n = normalize2(perp2(sub2(q, p)));
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

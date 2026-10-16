/**
 * Triangle primitives for `meshBvh`: closest point on a triangle, segment-segment and triangle-triangle distance with witness points,
 * segment-triangle and ray-triangle intersection. Pure, allocation-light, deterministic (no random, fixed evaluation order).
 */

import type { Vec3 } from '../model/types';
import { add3, cross3, dot3, scale3, sub3 } from '../lib/vec3';

export type Triangle = readonly [Vec3, Vec3, Vec3];

export interface ClosestPair {
  readonly distance: number;
  readonly pointA: Vec3;
  readonly pointB: Vec3;
}

const lengthSq = (v: Vec3): number => dot3(v, v);

/** Closest point of triangle `abc` to `p` (Ericson, Real-Time Collision Detection 5.1.5). */
export function closestPointOnTriangle(p: Vec3, [a, b, c]: Triangle): Vec3 {
  const ab = sub3(b, a);
  const ac = sub3(c, a);
  const ap = sub3(p, a);
  const d1 = dot3(ab, ap);
  const d2 = dot3(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub3(p, b);
  const d3 = dot3(ab, bp);
  const d4 = dot3(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add3(a, scale3(ab, d1 / (d1 - d3)));
  const cp = sub3(p, c);
  const d5 = dot3(ab, cp);
  const d6 = dot3(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add3(a, scale3(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return add3(b, scale3(sub3(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))));
  const denominator = 1 / (va + vb + vc);
  return add3(a, add3(scale3(ab, vb * denominator), scale3(ac, vc * denominator)));
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** Closest points between segments `p1q1` and `p2q2` (Ericson 5.1.9). */
export function closestPointsOfSegments(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): ClosestPair {
  const d1 = sub3(q1, p1);
  const d2 = sub3(q2, p2);
  const r = sub3(p1, p2);
  const a = dot3(d1, d1);
  const e = dot3(d2, d2);
  const f = dot3(d2, r);
  let s = 0;
  let t = 0;
  if (a <= 1e-300 && e <= 1e-300) {
    s = 0;
    t = 0;
  } else if (a <= 1e-300) {
    t = clamp01(f / e);
  } else {
    const c = dot3(d1, r);
    if (e <= 1e-300) {
      s = clamp01(-c / a);
    } else {
      const b = dot3(d1, d2);
      const denominator = a * e - b * b;
      s = denominator > 1e-300 ? clamp01((b * f - c * e) / denominator) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  const pointA = add3(p1, scale3(d1, s));
  const pointB = add3(p2, scale3(d2, t));
  return { distance: Math.sqrt(lengthSq(sub3(pointA, pointB))), pointA, pointB };
}

/** Point where segment `pq` pierces the plane interior of `tri` (non-coplanar crossing only), else null. */
export function segmentPiercesTriangle(p: Vec3, q: Vec3, [a, b, c]: Triangle): Vec3 | null {
  const normal = cross3(sub3(b, a), sub3(c, a));
  const direction = sub3(q, p);
  const denominator = dot3(normal, direction);
  if (denominator === 0) return null;
  const t = dot3(normal, sub3(a, p)) / denominator;
  if (t < 0 || t > 1) return null;
  const point = add3(p, scale3(direction, t));
  const slack = -1e-12 * lengthSq(normal);
  const inside =
    dot3(cross3(sub3(b, a), sub3(point, a)), normal) >= slack &&
    dot3(cross3(sub3(c, b), sub3(point, b)), normal) >= slack &&
    dot3(cross3(sub3(a, c), sub3(point, c)), normal) >= slack;
  return inside ? point : null;
}

const edgesOf = ([a, b, c]: Triangle): ReadonlyArray<readonly [Vec3, Vec3]> => [
  [a, b],
  [b, c],
  [c, a],
];

/**
 * Minimum distance between two triangles with witness points; 0 (witness = the crossing point) when they intersect. Evaluation order is
 * fixed: piercing edges of `first`, piercing edges of `second`, then edge-edge pairs, then vertex-triangle pairs; the first strictly
 * smaller candidate wins.
 */
export function triangleDistance(first: Triangle, second: Triangle): ClosestPair {
  for (const [p, q] of edgesOf(first)) {
    const hit = segmentPiercesTriangle(p, q, second);
    if (hit !== null) return { distance: 0, pointA: hit, pointB: hit };
  }
  for (const [p, q] of edgesOf(second)) {
    const hit = segmentPiercesTriangle(p, q, first);
    if (hit !== null) return { distance: 0, pointA: hit, pointB: hit };
  }
  let best: ClosestPair | null = null;
  const consider = (candidate: ClosestPair): void => {
    if (best === null || candidate.distance < best.distance) best = candidate;
  };
  for (const [p1, q1] of edgesOf(first)) {
    for (const [p2, q2] of edgesOf(second)) consider(closestPointsOfSegments(p1, q1, p2, q2));
  }
  for (const vertex of first) {
    const onSecond = closestPointOnTriangle(vertex, second);
    consider({ distance: Math.sqrt(lengthSq(sub3(vertex, onSecond))), pointA: vertex, pointB: onSecond });
  }
  for (const vertex of second) {
    const onFirst = closestPointOnTriangle(vertex, first);
    consider({ distance: Math.sqrt(lengthSq(sub3(vertex, onFirst))), pointA: onFirst, pointB: vertex });
  }
  return best ?? { distance: Infinity, pointA: first[0], pointB: second[0] };
}

/** Distance along `direction` (unit or not, in its own units) to triangle `tri` from `origin`, in [tMin, tMax]; null on a miss (Möller-Trumbore, double-sided). */
export function rayTriangleDistance(origin: Vec3, direction: Vec3, [a, b, c]: Triangle, tMin: number, tMax: number): number | null {
  const edge1 = sub3(b, a);
  const edge2 = sub3(c, a);
  const h = cross3(direction, edge2);
  const determinant = dot3(edge1, h);
  if (Math.abs(determinant) < 1e-300) return null;
  const inverse = 1 / determinant;
  const s = sub3(origin, a);
  const u = inverse * dot3(s, h);
  if (u < -1e-12 || u > 1 + 1e-12) return null;
  const q = cross3(s, edge1);
  const v = inverse * dot3(direction, q);
  if (v < -1e-12 || u + v > 1 + 1e-12) return null;
  const t = inverse * dot3(edge2, q);
  return t >= tMin && t <= tMax ? t : null;
}

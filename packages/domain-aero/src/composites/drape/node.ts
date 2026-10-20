/** Pin-jointed-net node and geodesic generator solvers (Mack & Taylor fishnet, 06 CMP §5.4), generic over a surface projection. */

import type { Vec3 } from '@core/model/types';
import { add3, cross3, dot3, len3, normalize3, scale3, sub3 } from '@lib/vec3';
import type { DrapeHit, DrapeSurface } from './surfaceQuery';

export type NodeOutcome = { readonly kind: 'node'; readonly hit: DrapeHit } | { readonly kind: 'outside' } | { readonly kind: 'inverted' };

const MAX_ITERATIONS = 30;
const MIN_CROSSING_DEG = 1;

const angleDeg = (u: Vec3, v: Vec3): number => (Math.acos(Math.max(-1, Math.min(1, dot3(u, v) / (len3(u) * len3(v))))) * 180) / Math.PI;

/** A unit vector orthogonal to `n`, in the direction of `prefer` when possible. */
function tangentBasis(n: Vec3, prefer: Vec3): [Vec3, Vec3] {
  let along = sub3(prefer, scale3(n, dot3(prefer, n)));
  if (len3(along) < 1e-12) along = cross3(n, Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
  const t1 = normalize3(along);
  return [t1, cross3(n, t1)];
}

/**
 * The node X on the surface with |X - A| = |X - B| = d, on the side of AB away from C (the opposite corner of the cell).
 * @invariant Newton in the tangent plane at each iterate with the surface projection restoring membership; the root nearest the parallelogram
 *   predictor A + B - C is taken, and a crossing angle under 1 degree counts as an inverted cell
 * @failure no root on the face -> 'outside'; the wrong branch or a crossing angle under 1 degree -> 'inverted'
 */
export function solveNode(surface: DrapeSurface, A: DrapeHit, B: DrapeHit, C: DrapeHit, d: number, margin: number): NodeOutcome {
  if (len3(sub3(A.point, B.point)) > 2 * d * (1 - 1e-12)) return { kind: 'outside' };
  let hit = surface.project(sub3(add3(A.point, B.point), C.point), A);
  if (hit === null || !surface.contains(hit, margin)) return { kind: 'outside' };
  const tolerance = 1e-11 * d * d;
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const x = hit.point;
    const r1 = sub3(x, A.point);
    const r2 = sub3(x, B.point);
    const g1 = dot3(r1, r1) - d * d;
    const g2 = dot3(r2, r2) - d * d;
    if (Math.abs(g1) < tolerance && Math.abs(g2) < tolerance) {
      const midpoint = scale3(add3(A.point, B.point), 0.5);
      if (dot3(sub3(x, midpoint), sub3(midpoint, C.point)) <= 0) return { kind: 'inverted' };
      return angleDeg(sub3(A.point, x), sub3(B.point, x)) < MIN_CROSSING_DEG ? { kind: 'inverted' } : { kind: 'node', hit };
    }
    const [t1, t2] = tangentBasis(hit.normal, r1);
    const [a, b, c, e] = [2 * dot3(r1, t1), 2 * dot3(r1, t2), 2 * dot3(r2, t1), 2 * dot3(r2, t2)];
    const det = a * e - b * c;
    if (!(Math.abs(det) > 1e-14 * d * d)) return { kind: 'outside' };
    let s1 = (-g1 * e + g2 * b) / det;
    let s2 = (-a * g2 + c * g1) / det;
    const step = Math.hypot(s1, s2);
    if (step > d) [s1, s2] = [(s1 * d) / step, (s2 * d) / step];
    hit = surface.project(add3(x, add3(scale3(t1, s1), scale3(t2, s2))), hit);
    if (hit === null || !surface.contains(hit, margin)) return { kind: 'outside' };
  }
  return { kind: 'outside' };
}

/**
 * Nodes of a discrete geodesic from `start` along `direction` at chord length `d`: each step goes along the tangent-plane projection of the
 * previous chord (a straight line on a plane, a great circle on a sphere, a helix on a cylinder), then the chord is rescaled to d.
 * @invariant stops at the first node outside the face or after `maxSteps`; the returned list excludes `start`
 */
export function geodesic(surface: DrapeSurface, start: DrapeHit, direction: Vec3, d: number, maxSteps: number, margin: number): DrapeHit[] {
  const nodes: DrapeHit[] = [];
  let current = start;
  let heading = direction;
  for (let step = 0; step < maxSteps; step++) {
    const [t] = tangentBasis(current.normal, heading);
    let length = d;
    let next: DrapeHit | null = null;
    for (let pass = 0; pass < 12; pass++) {
      next = surface.project(add3(current.point, scale3(t, length)), current);
      if (next === null) break;
      const chord = len3(sub3(next.point, current.point));
      if (chord < 1e-12) break;
      if (Math.abs(chord - d) < 1e-12 * d) break;
      length *= d / chord;
    }
    if (next === null || !surface.contains(next, margin)) break;
    nodes.push(next);
    const before = current;
    current = next;
    heading = sub3(current.point, before.point);
  }
  return nodes;
}

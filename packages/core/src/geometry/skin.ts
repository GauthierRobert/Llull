/**
 * @layer core/geometry
 * Skin a closed solid through ordered rings of equal point count: quad walls between neighbouring
 * rings and planar-projected caps on the first and last ring.
 * @invariant rings wind counter-clockwise seen from the direction of travel (first → last ring),
 *   so walls face outward; shared ring vertices are reused, so the soup welds watertight
 */

import type { Vec2, Vec3 } from '../model/types';
import { add3, centroid3, cross3, dot3, normalize3, scale3, sub3 } from '../lib/vec3';
import { triangulatePolygon } from '../lib/triangulate';
import type { Triangle } from './triangles';

/** Two triangles of the quad a-b-c-d (wound a → b → c). */
export const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3): Triangle[] => [
  [a, b, c],
  [a, c, d],
];

/** Wall quads between two rings, outward for a CCW ring pair (`flip` for an inward bore). */
export function ringWalls(lower: readonly Vec3[], upper: readonly Vec3[], flip: boolean): Triangle[] {
  return lower.flatMap((_, j) => {
    const k = (j + 1) % lower.length;
    const [a, b, c, d] = [lower[j], lower[k], upper[k], upper[j]] as [Vec3, Vec3, Vec3, Vec3];
    return flip ? quad(d, c, b, a) : quad(a, b, c, d);
  });
}

/** Newell normal of a closed ring (unnormalised area vector). */
export function ringNormal(ring: ReadonlyArray<Vec3>): Vec3 {
  let normal: Vec3 = [0, 0, 0];
  ring.forEach((p, i) => (normal = add3(normal, cross3(p, ring[(i + 1) % ring.length] as Vec3))));
  return scale3(normal, 0.5);
}

/** Triangles of a ring's cap, wound so their normal points along `outward`. */
function cap(ring: ReadonlyArray<Vec3>, outward: Vec3): Triangle[] {
  const n = normalize3(ringNormal(ring));
  const u = normalize3(Math.abs(n[0]) < 0.9 ? cross3(n, [1, 0, 0]) : cross3(n, [0, 1, 0]));
  const v = cross3(n, u);
  const flat = ring.map((p): Vec2 => [dot3(p, u), dot3(p, v)]);
  const facesOut = dot3(n, outward) > 0;
  return triangulatePolygon(flat).triangles.map(([a, b, c]): Triangle => {
    const [pa, pb, pc] = [ring[a], ring[b], ring[c]] as [Vec3, Vec3, Vec3];
    const ccwInPlane = cross3(sub3(pb, pa), sub3(pc, pa));
    const alongN = dot3(ccwInPlane, n) > 0;
    return alongN === facesOut ? [pa, pb, pc] : [pa, pc, pb];
  });
}

/** Closed solid through `rings` (>= 2, equal counts >= 3); [] when malformed. */
export function skinTriangles(rings: ReadonlyArray<ReadonlyArray<Vec3>>): Triangle[] {
  const first = rings[0];
  const last = rings[rings.length - 1];
  if (rings.length < 2 || first === undefined || last === undefined || first.length < 3) return [];
  if (rings.some((ring) => ring.length !== first.length)) return [];
  const triangles: Triangle[] = [];
  for (let i = 0; i + 1 < rings.length; i++) {
    triangles.push(...ringWalls(rings[i] as readonly Vec3[], rings[i + 1] as readonly Vec3[], false));
  }
  const travel = sub3(centroid3(last), centroid3(first));
  const direction: Vec3 = Math.hypot(...travel) > 1e-12 ? travel : normalize3(ringNormal(first));
  triangles.push(...cap(first, scale3(direction, -1)), ...cap(last, direction));
  return triangles;
}

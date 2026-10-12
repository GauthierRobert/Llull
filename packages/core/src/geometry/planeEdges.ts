/**
 * Polygon edges against a plane: signed distances and edge/plane crossings, shared by the
 * render cutaway (Sutherland–Hodgman) and decal clipping.
 *
 * @layer core/geometry
 * @pure
 */

import type { Vec3 } from '../model/types';
import { add3, dot3, scale3, sub3 } from '../lib/vec3';

/** Unit-normal plane; `signedDistance(plane, p) > 0` is its positive side. */
export interface UnitPlane {
  normal: Vec3;
  offset: number;
}

const signedDistance = (plane: UnitPlane, p: Vec3): number => dot3(plane.normal, p) - plane.offset;

/** Visit each edge `a→b` of the closed polygon `verts` with both ends' signed plane distances. */
export function forEachEdge(
  verts: readonly Vec3[],
  plane: UnitPlane,
  visit: (a: Vec3, b: Vec3, sa: number, sb: number) => void,
): void {
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i] as Vec3;
    const b = verts[(i + 1) % verts.length] as Vec3;
    visit(a, b, signedDistance(plane, a), signedDistance(plane, b));
  }
}

/** Where edge `a→b` (signed distances `sa`, `sb` of opposite sides) meets the plane. */
export const edgeCrossing = (a: Vec3, b: Vec3, sa: number, sb: number): Vec3 =>
  add3(a, scale3(sub3(b, a), sa / (sa - sb)));

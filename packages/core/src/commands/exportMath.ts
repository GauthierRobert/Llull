import type { Vec3 } from '../model/types';
import { cross3, normalize3, sub3 } from '../lib/vec3';
import { earClipTriangulate } from './tessellation';

/** Compute the outward facet normal from 3 vertices (right-hand rule). */
export function facetNormal(v0: Vec3, v1: Vec3, v2: Vec3): Vec3 {
  return normalize3(cross3(sub3(v1, v0), sub3(v2, v0)));
}

export type Triangle = readonly [Vec3, Vec3, Vec3];

/**
 * Triangulate a convex polygon as a fan from the first vertex.
 * Only correct for strictly convex polygons — use earClipTriangulateVerts for
 * general (possibly non-convex) profiles.
 */
export function fanTriangulate(verts: Vec3[]): Triangle[] {
  const tris: Triangle[] = [];
  for (let i = 1; i + 1 < verts.length; i++) {
    tris.push([verts[0]!, verts[i]!, verts[i + 1]!]);
  }
  return tris;
}

/**
 * Triangulate a general (convex or non-convex) polygon using ear-clipping.
 * `verts` are 3D points that share the same Z plane — only XY is used for
 * the ear test; Z is preserved in the output triangles.
 *
 * Falls back to fan-triangulation for degenerate inputs (< 3 verts).
 */
export function earClipTriangulateVerts(verts: Vec3[]): Triangle[] {
  if (verts.length < 3) return [];
  // Project to 2D for the ear-clip test (all verts share the same Z plane).
  const pts2d: Array<readonly [number, number]> = verts.map((v) => [v[0], v[1]] as const);
  const indexTris = earClipTriangulate(pts2d);
  return indexTris.map(([ia, ib, ic]) => [verts[ia]!, verts[ib]!, verts[ic]!] as Triangle);
}

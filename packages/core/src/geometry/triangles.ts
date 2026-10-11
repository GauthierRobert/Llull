import type { Vec3 } from '../model/types';
import { earClipTriangulate } from './tessellation';
import { elementAt } from '../lib/elementAt';

export type Triangle = readonly [Vec3, Vec3, Vec3];

/**
 * Triangulate a convex polygon as a fan from the first vertex.
 * Only correct for strictly convex polygons — use earClipTriangulateVerts for
 * general (possibly non-convex) profiles.
 */
export function fanTriangulate(verts: Vec3[]): Triangle[] {
  const tris: Triangle[] = [];
  for (let i = 1; i + 1 < verts.length; i++) {
    tris.push([elementAt(verts, 0), elementAt(verts, i), elementAt(verts, i + 1)]);
  }
  return tris;
}

/**
 * Triangulate a general (convex or non-convex) polygon using ear-clipping.
 * `verts` are 3D points that share the same Z plane — only XY is used for
 * the ear test; Z is preserved in the output triangles. Fewer than 3 verts → [].
 */
export function earClipTriangulateVerts(verts: Vec3[]): Triangle[] {
  const indexTris = earClipTriangulate(verts.map((v) => [v[0], v[1]] as const));
  return indexTris.map(
    ([ia, ib, ic]) =>
      [elementAt(verts, ia), elementAt(verts, ib), elementAt(verts, ic)] as Triangle,
  );
}

import type { Vec3 } from '../model/types';
import { applyEulerXYZ, isZeroRotation } from '../lib/eulerRotation';
import { type PreDepthPolygon } from './renderTypes';

export function centroid3(verts: Vec3[]): Vec3 {
  if (verts.length === 0) return [0, 0, 0];
  let x = 0,
    y = 0,
    z = 0;
  for (const v of verts) {
    x += v[0];
    y += v[1];
    z += v[2];
  }
  const n = verts.length;
  return [x / n, y / n, z / n];
}

export function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Apply entity rotation to every polygon produced by a tessellator.
 * Verts are rotated about `position`; normals are rotated without translation.
 * No-op when rotation is [0,0,0].
 *
 * @pure
 */
export function applyRotation(
  polys: PreDepthPolygon[],
  position: Vec3,
  rotation: Vec3,
): PreDepthPolygon[] {
  if (isZeroRotation(rotation)) return polys;
  return polys.map((poly) => ({
    ...poly,
    verts: poly.verts.map((v) => applyEulerXYZ(v, position, rotation)),
    // Normals rotate by the same matrix, without translation.
    normal: applyEulerXYZ(poly.normal, [0, 0, 0], rotation),
  }));
}

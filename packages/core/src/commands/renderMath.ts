import type { Vec3 } from '../model/types';
import { applyEulerXYZ, isZeroRotation } from '../lib/eulerRotation';
import { type PreDepthPolygon } from './renderTypes';

// ---------------------------------------------------------------------------
// Math helpers (pure, no dependencies on any external library)
// ---------------------------------------------------------------------------

export function add3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale3(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function len3(a: Vec3): number {
  return Math.sqrt(dot3(a, a));
}

export function normalize3(a: Vec3): Vec3 {
  const l = len3(a);
  return l > 1e-10 ? scale3(a, 1 / l) : [0, 0, 1];
}

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

// ---------------------------------------------------------------------------
// Euler rotation helpers (three.js 'XYZ' intrinsic order = M = Rx·Ry·Rz)
// ---------------------------------------------------------------------------

/**
 * Apply the same intrinsic XYZ Euler rotation to a direction vector (normal).
 * No translation — normals transform by the same rotation matrix.
 *
 * @pure
 */
export function rotateNormalXYZ(n: Vec3, euler: Vec3): Vec3 {
  return applyEulerXYZ(n, [0, 0, 0], euler);
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
    normal: rotateNormalXYZ(poly.normal, rotation),
  }));
}

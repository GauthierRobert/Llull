/**
 * @layer core/geometry
 * Shared surface-of-revolution sampling (export, render, viewport all consume this).
 * Sweep starts at +X, counter-clockwise; dominant axis component picks the frame
 * (Z: radial XY / axial Z, Y: radial XZ / axial Y, X: radial YZ / axial X).
 */

import type { Vec3 } from '../model/types';

type RevolutionProfile = ReadonlyArray<readonly [number, number]>;

/**
 * @pure
 * @invariant profile.length < 3 -> []
 * @invariant side faces: one quad [A_i, A_j, B_j, B_i] per profile edge per segment, then
 *   (partial sweep only, angle < 2*PI - 1e-6) start cap (reversed ring 0) and end cap (last ring)
 * @param origin added to every vertex (entity position); [0,0,0] for the local frame
 */
export function revolutionPolygons(
  profile: RevolutionProfile,
  axis: Vec3,
  angle: number,
  segments: number,
  origin: Vec3 = [0, 0, 0],
): Vec3[][] {
  if (profile.length < 3) return [];
  const [px, py, pz] = origin;
  const absX = Math.abs(axis[0]);
  const absY = Math.abs(axis[1]);
  const absZ = Math.abs(axis[2]);

  const toWorld = (r: number, a: number, theta: number): Vec3 => {
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    if (absZ >= absX && absZ >= absY) return [px + r * cosT, py + r * sinT, pz + a];
    if (absY >= absX) return [px + r * cosT, py + a, pz + r * sinT];
    return [px + a, py + r * cosT, pz + r * sinT];
  };

  const n = profile.length;
  const isFull = angle >= 2 * Math.PI - 1e-6;
  const ringCount = isFull ? segments : segments + 1;
  const rings: Vec3[][] = [];
  for (let s = 0; s < ringCount; s++) {
    const theta = (angle * s) / segments;
    rings.push(profile.map(([r, a]) => toWorld(r, a, theta)));
  }

  const polygons: Vec3[][] = [];
  for (let s = 0; s < segments; s++) {
    const ringA = rings[s]!;
    const ringB = rings[(s + 1) % ringCount]!;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      polygons.push([ringA[i]!, ringA[j]!, ringB[j]!, ringB[i]!]);
    }
  }
  if (!isFull) {
    polygons.push([...rings[0]!].reverse());
    polygons.push([...rings[segments]!]);
  }
  return polygons;
}

/**
 * @pure
 * Fan-triangulates each polygon of `revolutionPolygons` (v0,vi,vi+1).
 * Triangles are flat xyz triples: [x0,y0,z0, x1,y1,z1, x2,y2,z2, ...].
 */
export function revolutionTriangles(
  profile: RevolutionProfile,
  axis: Vec3,
  angle: number,
  segments: number,
  origin: Vec3 = [0, 0, 0],
): Array<readonly [Vec3, Vec3, Vec3]> {
  const triangles: Array<readonly [Vec3, Vec3, Vec3]> = [];
  for (const polygon of revolutionPolygons(profile, axis, angle, segments, origin)) {
    for (let i = 1; i + 1 < polygon.length; i++) {
      triangles.push([polygon[0]!, polygon[i]!, polygon[i + 1]!]);
    }
  }
  return triangles;
}

/** Which of a set of points lie inside a closed triangle mesh (ray parity along a slightly tilted +x ray, Möller–Trumbore). */

import type { Vec3 } from '../../model/vectors';

/** Triangles above which no containment is attempted (cost: points x triangles). */
const TRIANGLE_CAP = 120_000;

/** Ray direction: +x tilted off every axis so that it does not graze an edge of an axis-aligned mesh. */
const DIRECTION: Vec3 = [1, 0.000731, 0.000419];

/**
 * The points of `points` inside the closed mesh (odd number of ray crossings).
 * @failure a mesh above the triangle cap -> [] (nothing is claimed)
 */
export function pointsInsideMesh(points: ReadonlyArray<Vec3>, positions: ReadonlyArray<number>, indices: ReadonlyArray<number>): Vec3[] {
  const triangles = indices.length / 3;
  if (triangles === 0 || triangles > TRIANGLE_CAP) return [];
  const corner = (v: number): Vec3 => [positions[v * 3] as number, positions[v * 3 + 1] as number, positions[v * 3 + 2] as number];
  const inside: Vec3[] = [];
  for (const origin of points) {
    let crossings = 0;
    for (let t = 0; t < triangles; t++) {
      const [a, b, c] = [corner(indices[t * 3] as number), corner(indices[t * 3 + 1] as number), corner(indices[t * 3 + 2] as number)];
      const e1: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const h: Vec3 = [
        DIRECTION[1] * e2[2] - DIRECTION[2] * e2[1],
        DIRECTION[2] * e2[0] - DIRECTION[0] * e2[2],
        DIRECTION[0] * e2[1] - DIRECTION[1] * e2[0],
      ];
      const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
      if (Math.abs(det) < 1e-18) continue;
      const s: Vec3 = [origin[0] - a[0], origin[1] - a[1], origin[2] - a[2]];
      const u = (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]) / det;
      if (u < 0 || u > 1) continue;
      const q: Vec3 = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
      const v = (DIRECTION[0] * q[0] + DIRECTION[1] * q[1] + DIRECTION[2] * q[2]) / det;
      if (v < 0 || u + v > 1) continue;
      if ((e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det > 0) crossings++;
    }
    if (crossings % 2 === 1) inside.push(origin);
  }
  return inside;
}

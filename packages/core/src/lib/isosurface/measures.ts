/** Mesh checks used by the callers of the iso-surface mesher: divergence-theorem volume / area and the closed-manifold test. */

import type { IsoMesh } from './tetra';

export interface MeshMeasures {
  readonly volume: number;
  readonly area: number;
  readonly triangles: number;
  readonly vertices: number;
}

/** Signed volume (valid for a closed, outward-oriented mesh) and total area. */
export function meshMeasures({
  positions,
  indices,
}: {
  readonly positions: ArrayLike<number>;
  readonly indices: ArrayLike<number>;
}): MeshMeasures {
  let volume = 0;
  let area = 0;
  const at = (vertex: number, axis: number): number => positions[3 * vertex + axis] as number;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const [a, b, c] = [indices[t] as number, indices[t + 1] as number, indices[t + 2] as number];
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = [at(a, 0), at(a, 1), at(a, 2), at(b, 0), at(b, 1), at(b, 2), at(c, 0), at(c, 1), at(c, 2)];
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    const [ux, uy, uz, vx, vy, vz] = [bx - ax, by - ay, bz - az, cx - ax, cy - ay, cz - az];
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return { volume, area, triangles: Math.floor(indices.length / 3), vertices: positions.length / 3 };
}

/**
 * Edge-manifold test by vertex index: every directed edge occurs exactly once and so does its reverse.
 * @invariant exact while vertices^2 < 2^53; larger meshes answer false
 */
export function isClosedManifold({ positions, indices }: IsoMesh): boolean {
  const vertices = positions.length / 3;
  if (vertices * vertices >= Number.MAX_SAFE_INTEGER || indices.length % 3 !== 0) return false;
  const counts = new Map<number, number>();
  for (let t = 0; t < indices.length; t += 3)
    for (let e = 0; e < 3; e += 1) {
      const key = (indices[t + e] as number) * vertices + (indices[t + ((e + 1) % 3)] as number);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  for (const [key, count] of counts) {
    if (count !== 1) return false;
    const from = Math.floor(key / vertices);
    if (counts.get((key % vertices) * vertices + from) !== 1) return false;
  }
  return true;
}

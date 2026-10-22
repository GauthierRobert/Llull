/** Vertex welding for indexed triangle meshes: vertices closer than a tolerance share one index; output order is first use in a face traversal (canonical, AF-13). */

import type { MeshData } from '../../model/types';
import { tupleExtent } from '../../lib/extent';

export interface WeldedMesh {
  /** Flat xyz of the welded vertices, in first-use order. */
  readonly positions: number[];
  /** Triangle corner indices (3 per triangle), same triangle order as the input; unreferenced input vertices are dropped. */
  readonly triangles: number[];
  /** Input vertices referenced by a triangle minus welded vertices. */
  readonly mergedVertices: number;
}

/** Diagonal of the bounding box of flat xyz positions; 0 when empty. */
export function meshDiagonal(positions: ReadonlyArray<number>): number {
  if (positions.length < 3) return 0;
  const { min, max } = tupleExtent(positions, 3);
  return Math.hypot(
    (max[0] as number) - (min[0] as number),
    (max[1] as number) - (min[1] as number),
    (max[2] as number) - (min[2] as number),
  );
}

/**
 * Weld `mesh` (indexed) at `tolerance` (document units, >= 0; 0 merges only bit-identical coordinates). Vertices within `tolerance`
 * of an earlier welded vertex join it (first come wins, so the result is deterministic).
 * @invariant triangle count and order are unchanged; degenerate triangles are kept (analysis reports them)
 */
export function weldMesh(mesh: MeshData, tolerance: number): WeldedMesh {
  const { positions, indices } = mesh;
  const welded: number[] = [];
  const remap = new Int32Array(positions.length / 3).fill(-1);
  const cell = tolerance > 0 ? tolerance : 0;
  const buckets = new Map<string, number[]>();
  const triangles: number[] = [];
  let referenced = 0;
  const bucketKey = (i: number, j: number, k: number): string => `${i},${j},${k}`;
  const lookup = (x: number, y: number, z: number): number => {
    if (cell === 0) {
      const exact = buckets.get(`${x},${y},${z}`);
      return exact?.[0] ?? -1;
    }
    const [ci, cj, ck] = [Math.floor(x / cell), Math.floor(y / cell), Math.floor(z / cell)];
    const limit = cell * cell;
    let best = -1;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (let dk = -1; dk <= 1; dk++) {
          for (const candidate of buckets.get(bucketKey(ci + di, cj + dj, ck + dk)) ?? []) {
            const dx = (welded[candidate * 3] as number) - x;
            const dy = (welded[candidate * 3 + 1] as number) - y;
            const dz = (welded[candidate * 3 + 2] as number) - z;
            if (dx * dx + dy * dy + dz * dz <= limit && (best < 0 || candidate < best)) best = candidate;
          }
        }
      }
    }
    return best;
  };
  const register = (x: number, y: number, z: number): number => {
    const index = welded.length / 3;
    welded.push(x, y, z);
    const key = cell === 0 ? `${x},${y},${z}` : bucketKey(Math.floor(x / cell), Math.floor(y / cell), Math.floor(z / cell));
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [index]);
    else bucket.push(index);
    return index;
  };
  for (const corner of indices) {
    let mapped = remap[corner] ?? -1;
    if (mapped < 0) {
      referenced++;
      const [x, y, z] = [positions[corner * 3] as number, positions[corner * 3 + 1] as number, positions[corner * 3 + 2] as number];
      mapped = lookup(x, y, z);
      if (mapped < 0) mapped = register(x, y, z);
      remap[corner] = mapped;
    }
    triangles.push(mapped);
  }
  return { positions: welded, triangles, mergedVertices: referenced - welded.length / 3 };
}

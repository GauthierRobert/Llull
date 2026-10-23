/**
 * Display level of detail of a large mesh: vertex clustering on a uniform grid (O(n), any size, deterministic). Vertices in one cell merge
 * to their mean, triangles that collapse or repeat disappear. The cell size is tuned until the triangle count is near the target.
 * @invariant the LOD is for display only; every command reads the full-resolution asset
 */

import type { MeshData } from '../../model/types';
import { tupleExtent } from '../../lib/extent';

function cluster(mesh: MeshData, cell: number, origin: readonly number[], cells: readonly number[]): MeshData {
  const vertexCount = mesh.positions.length / 3;
  const target = new Int32Array(vertexCount).fill(-1);
  const byCell = new Map<number, number>();
  const sums: number[] = [];
  const counts: number[] = [];
  const referenced = new Uint8Array(vertexCount);
  for (const v of mesh.indices) referenced[v] = 1;
  for (let v = 0; v < vertexCount; v++) {
    if (referenced[v] !== 1) continue;
    const ix = Math.min(cells[0] as number, Math.floor(((mesh.positions[v * 3] as number) - (origin[0] as number)) / cell));
    const iy = Math.min(cells[1] as number, Math.floor(((mesh.positions[v * 3 + 1] as number) - (origin[1] as number)) / cell));
    const iz = Math.min(cells[2] as number, Math.floor(((mesh.positions[v * 3 + 2] as number) - (origin[2] as number)) / cell));
    const key = ix + ((cells[0] as number) + 1) * (iy + ((cells[1] as number) + 1) * iz);
    let id = byCell.get(key);
    if (id === undefined) {
      id = counts.length;
      byCell.set(key, id);
      counts.push(0);
      sums.push(0, 0, 0);
    }
    target[v] = id;
    counts[id] = (counts[id] as number) + 1;
    for (let a = 0; a < 3; a++) sums[id * 3 + a] = (sums[id * 3 + a] as number) + (mesh.positions[v * 3 + a] as number);
  }
  const positions = sums.map((value, i) => value / (counts[Math.floor(i / 3)] as number));
  const indices: number[] = [];
  const seen = new Set<string>();
  for (let f = 0; f + 2 < mesh.indices.length; f += 3) {
    const a = target[mesh.indices[f] as number] as number;
    const b = target[mesh.indices[f + 1] as number] as number;
    const c = target[mesh.indices[f + 2] as number] as number;
    if (a === b || b === c || a === c) continue;
    const key = [a, b, c].sort((x, y) => x - y).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    indices.push(a, b, c);
  }
  return { positions, indices };
}

/** `mesh` itself when it has at most `target` triangles, else a vertex-clustered copy near `target` triangles. */
export function lodMesh(mesh: MeshData, target: number): MeshData {
  if (mesh.indices.length / 3 <= target) return mesh;
  const { min, max } = tupleExtent(mesh.positions, 3);
  const extent = [0, 1, 2].map((a) => (max[a] as number) - (min[a] as number));
  const longest = Math.max(...extent, 1e-300);
  let cell = longest / Math.sqrt(target);
  let accepted: { mesh: MeshData; gap: number } | null = null;
  let latest = mesh;
  for (let pass = 0; pass < 6; pass++) {
    latest = cluster(
      mesh,
      cell,
      min,
      extent.map((e) => Math.max(1, Math.ceil(e / cell))),
    );
    const count = latest.indices.length / 3;
    const gap = Math.abs(Math.log(Math.max(count, 1) / target));
    if (count <= target * 1.25 && (accepted === null || gap < accepted.gap)) accepted = { mesh: latest, gap };
    if (count > target * 0.7 && count <= target * 1.25) break;
    cell *= Math.sqrt(Math.max(count, 1) / target);
  }
  return accepted?.mesh ?? latest;
}

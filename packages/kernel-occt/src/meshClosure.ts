/**
 * @layer kernel
 * Watertightness of a triangle mesh: every edge shared by two triangles once vertices are welded
 * by position. Pure; used to refuse an OCC solid whose display mesh came out holed.
 */

import type { MeshData } from '@core/model/types';

/** Weld grid: 1e-5 document units. */
const GRID = 1e5;

/**
 * Whether every triangle edge of `mesh` is shared (null counts as closed: nothing to show). Welded
 * on two grids half a cell apart, so two copies of one vertex straddling a cell boundary still
 * weld on one of them.
 */
export function isClosedMesh(mesh: MeshData | null): boolean {
  return mesh === null || openEdgeCount(mesh, 0) === 0 || openEdgeCount(mesh, 0.5) === 0;
}

/** Triangle edges used by exactly one triangle, vertices welded on the grid shifted by `offset`. */
export function openEdgeCount({ positions, indices }: MeshData, offset: number): number {
  const vertexCount = positions.length / 3;
  const welded = new Int32Array(vertexCount);
  const ids = new Map<string, number>();
  for (let v = 0; v < vertexCount; v++) {
    const cell = (axis: number): number =>
      Math.round((positions[v * 3 + axis] ?? 0) * GRID + offset);
    // `${-0}` is "0", so -1e-12 and +1e-12 share a key (toFixed would print "-0.00000").
    const key = `${cell(0)},${cell(1)},${cell(2)}`;
    const known = ids.get(key);
    welded[v] = known ?? ids.size;
    if (known === undefined) ids.set(key, ids.size);
  }
  const uses = new Map<number, number>();
  const stride = ids.size;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = welded[indices[t + k] ?? 0] ?? 0;
      const b = welded[indices[t + ((k + 1) % 3)] ?? 0] ?? 0;
      if (a === b) continue;
      const key = a < b ? a * stride + b : b * stride + a;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const count of uses.values()) if (count === 1) open++;
  return open;
}

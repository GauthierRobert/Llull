/** Mirror symmetry of a surface about the y = 0 plane of the case frame (TECHNICAL_SPEC §5.1 step 9). */

import type { IndexedSurface } from './weld';

/**
 * Whether every vertex has a vertex within `tolerance` after mirroring y -> -y (vertex-set Hausdorff distance, one direction: the mirror is an involution).
 * @invariant spatial hash of cell size `tolerance`; the 27 neighbouring cells are searched
 */
export function isMirrorSymmetric({ vertices }: IndexedSurface, tolerance: number): boolean {
  const cell = tolerance > 0 ? tolerance : 1e-12;
  const key = (x: number, y: number, z: number): string => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  const grid = new Map<string, number[]>();
  const count = vertices.length / 3;
  for (let v = 0; v < count; v++) {
    const k = key(vertices[v * 3] ?? 0, vertices[v * 3 + 1] ?? 0, vertices[v * 3 + 2] ?? 0);
    const list = grid.get(k);
    if (list === undefined) grid.set(k, [v]);
    else list.push(v);
  }
  for (let v = 0; v < count; v++) {
    const x = vertices[v * 3] ?? 0;
    const y = -(vertices[v * 3 + 1] ?? 0);
    const z = vertices[v * 3 + 2] ?? 0;
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    const cz = Math.floor(z / cell);
    let found = false;
    for (let dx = -1; dx <= 1 && !found; dx++)
      for (let dy = -1; dy <= 1 && !found; dy++)
        for (let dz = -1; dz <= 1 && !found; dz++)
          found = (grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []).some(
            (w) => Math.hypot((vertices[w * 3] ?? 0) - x, (vertices[w * 3 + 1] ?? 0) - y, (vertices[w * 3 + 2] ?? 0) - z) <= tolerance,
          );
    if (!found) return false;
  }
  return true;
}

/**
 * Connected components of a node sign grid (05 IMP §5.8): solid and void nodes both 14-connected by the edges of the Kuhn tetrahedra (offsets whose non-zero components share a sign), consistent with
 * the tetrahedral surface. A void that does not touch the grid boundary is enclosed.
 * @invariant components are numbered in scan order (x fastest), so the result depends on the sign grid only
 */

import type { Vec3 } from '../../model/types';
import type { FieldComponent } from './engineTypes';

/** The member node nearest the centroid of the component (a point inside it, not just any boundary node). */
function representative(members: Int32Array, nodes: readonly [number, number, number], voxel: number, origin: Vec3): Vec3 {
  const [sx, sy] = nodes;
  const at = (id: number): Vec3 => [id % sx, Math.floor(id / sx) % sy, Math.floor(id / (sx * sy))];
  const sum: [number, number, number] = [0, 0, 0];
  for (const id of members) at(id).forEach((c, axis) => (sum[axis] = (sum[axis] as number) + c));
  const centre = sum.map((s) => s / members.length);
  let best = members[0] as number;
  let bestDistance = Infinity;
  for (const id of members) {
    const p = at(id);
    const d = (p[0] - (centre[0] as number)) ** 2 + (p[1] - (centre[1] as number)) ** 2 + (p[2] - (centre[2] as number)) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = id;
    }
  }
  const p = at(best);
  return [origin[0] + p[0] * voxel, origin[1] + p[1] * voxel, origin[2] + p[2] * voxel];
}

function label(
  inside: Uint8Array,
  nodes: readonly [number, number, number],
  solid: boolean,
  voxel: number,
  origin: Vec3,
): FieldComponent[] {
  const [sx, sy, sz] = nodes;
  const wanted = solid ? 1 : 0;
  const seen = new Uint8Array(inside.length);
  const queue = new Int32Array(inside.length);
  const found: FieldComponent[] = [];
  for (let start = 0; start < inside.length; start += 1) {
    if (seen[start] === 1 || inside[start] !== wanted) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    let touchesBoundary = false;
    while (head < tail) {
      const id = queue[head++] as number;
      const [i, j, k] = [id % sx, Math.floor(id / sx) % sy, Math.floor(id / (sx * sy))];
      if (i === 0 || j === 0 || k === 0 || i === sx - 1 || j === sy - 1 || k === sz - 1) touchesBoundary = true;
      for (let dk = -1; dk <= 1; dk += 1)
        for (let dj = -1; dj <= 1; dj += 1)
          for (let di = -1; di <= 1; di += 1) {
            if (di === 0 && dj === 0 && dk === 0) continue;
            if (Math.min(di, dj, dk) < 0 && Math.max(di, dj, dk) > 0) continue;
            const [ni, nj, nk] = [i + di, j + dj, k + dk];
            if (ni < 0 || nj < 0 || nk < 0 || ni >= sx || nj >= sy || nk >= sz) continue;
            const next = ni + sx * (nj + sy * nk);
            if (seen[next] === 1 || inside[next] !== wanted) continue;
            seen[next] = 1;
            queue[tail++] = next;
          }
    }
    found.push({
      voxels: tail,
      volume: tail * voxel ** 3,
      point: representative(queue.subarray(0, tail), nodes, voxel, origin),
      enclosed: !solid && !touchesBoundary,
    });
  }
  return found;
}

/** Solid and void components of `inside` (1 = solid node) on a grid of `nodes` nodes at `origin` with spacing `voxel`. */
export function signComponents(
  inside: Uint8Array,
  nodes: readonly [number, number, number],
  voxel: number,
  origin: Vec3,
): { solids: FieldComponent[]; voids: FieldComponent[] } {
  return { solids: label(inside, nodes, true, voxel, origin), voids: label(inside, nodes, false, voxel, origin) };
}

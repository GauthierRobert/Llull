/**
 * Signed distance to a closed triangle mesh (05 IMP §5.9, `field_from_solid`): unsigned distance by a branch-and-bound walk of the
 * deterministic `meshBvh`, sign by the generalised winding number (Van Oosterom-Strackee solid angles, far nodes by their dipole), inside iff w > 1/2.
 * @invariant negative inside, positive outside, exact to the triangles; a closed outward-oriented mesh is assumed (callers refuse open meshes)
 */

import type { MeshData } from '../../model/types';
import { type MeshBvh, buildMeshBvh } from '../meshBvh';
import { closestPointOnTriangle } from '../triangleQueries';

export interface MeshSdf {
  distance(x: number, y: number, z: number): number;
}

interface NodeDipole {
  /** Sum of area-weighted normals. */
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /** Area-weighted centroid. */
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  /** Half the box diagonal. */
  readonly radius: number;
}

function dipolesOf(bvh: MeshBvh): NodeDipole[] {
  const nodes = bvh.left.length;
  const out: NodeDipole[] = new Array<NodeDipole>(nodes);
  const accumulate = (node: number): { n: [number, number, number]; c: [number, number, number]; area: number } => {
    const total = { n: [0, 0, 0] as [number, number, number], c: [0, 0, 0] as [number, number, number], area: 0 };
    const left = bvh.left[node] as number;
    if (left >= 0) {
      for (const child of [left, bvh.right[node] as number]) {
        const part = accumulate(child);
        for (const axis of [0, 1, 2] as const) {
          total.n[axis] += part.n[axis];
          total.c[axis] += part.c[axis];
        }
        total.area += part.area;
      }
    } else {
      const first = bvh.start[node] as number;
      for (let slot = first; slot < first + (bvh.count[node] as number); slot += 1) {
        const c = (bvh.order[slot] as number) * 9;
        const g = (i: number): number => bvh.corners[c + i] as number;
        const [ux, uy, uz, vx, vy, vz] = [g(3) - g(0), g(4) - g(1), g(5) - g(2), g(6) - g(0), g(7) - g(1), g(8) - g(2)];
        const [nx, ny, nz] = [(uy * vz - uz * vy) / 2, (uz * vx - ux * vz) / 2, (ux * vy - uy * vx) / 2];
        const area = Math.hypot(nx, ny, nz);
        total.n[0] += nx;
        total.n[1] += ny;
        total.n[2] += nz;
        total.c[0] += (area * (g(0) + g(3) + g(6))) / 3;
        total.c[1] += (area * (g(1) + g(4) + g(7))) / 3;
        total.c[2] += (area * (g(2) + g(5) + g(8))) / 3;
        total.area += area;
      }
    }
    const box = (i: number): number => bvh.boxes[node * 6 + i] as number;
    const inv = total.area > 0 ? 1 / total.area : 0;
    out[node] = {
      nx: total.n[0],
      ny: total.n[1],
      nz: total.n[2],
      cx: total.c[0] * inv,
      cy: total.c[1] * inv,
      cz: total.c[2] * inv,
      radius: Math.hypot(box(3) - box(0), box(4) - box(1), box(5) - box(2)) / 2,
    };
    return total;
  };
  if (nodes > 0) accumulate(0);
  return out;
}

/** Evaluator over `mesh`; an empty mesh is +Infinity everywhere. */
export function prepareMeshSdf(mesh: MeshData): MeshSdf {
  const bvh = buildMeshBvh(mesh);
  const dipoles = dipolesOf(bvh);
  const stack = new Int32Array(Math.max(64, bvh.left.length));
  const corner = (triangle: number, k: number, axis: number): number => bvh.corners[triangle * 9 + k * 3 + axis] as number;

  const unsigned = (x: number, y: number, z: number): number => {
    let best = Infinity;
    let top = 0;
    stack[top++] = 0;
    while (top > 0) {
      const node = stack[--top] as number;
      const b = (i: number): number => bvh.boxes[node * 6 + i] as number;
      const gap = Math.hypot(Math.max(b(0) - x, 0, x - b(3)), Math.max(b(1) - y, 0, y - b(4)), Math.max(b(2) - z, 0, z - b(5)));
      if (gap >= best) continue;
      const left = bvh.left[node] as number;
      if (left >= 0) {
        stack[top++] = bvh.right[node] as number;
        stack[top++] = left;
        continue;
      }
      const first = bvh.start[node] as number;
      for (let slot = first; slot < first + (bvh.count[node] as number); slot += 1) {
        const t = bvh.order[slot] as number;
        const q = closestPointOnTriangle(
          [x, y, z],
          [
            [corner(t, 0, 0), corner(t, 0, 1), corner(t, 0, 2)],
            [corner(t, 1, 0), corner(t, 1, 1), corner(t, 1, 2)],
            [corner(t, 2, 0), corner(t, 2, 1), corner(t, 2, 2)],
          ],
        );
        const d = Math.hypot(q[0] - x, q[1] - y, q[2] - z);
        if (d < best) best = d;
      }
    }
    return best;
  };

  const winding = (x: number, y: number, z: number): number => {
    let total = 0;
    let top = 0;
    stack[top++] = 0;
    while (top > 0) {
      const node = stack[--top] as number;
      const d = dipoles[node];
      if (d === undefined) continue;
      const [rx, ry, rz] = [d.cx - x, d.cy - y, d.cz - z];
      const distance = Math.hypot(rx, ry, rz);
      const left = bvh.left[node] as number;
      if (distance > 2 * d.radius && distance > 0) {
        total += (d.nx * rx + d.ny * ry + d.nz * rz) / (distance * distance * distance);
        continue;
      }
      if (left >= 0) {
        stack[top++] = bvh.right[node] as number;
        stack[top++] = left;
        continue;
      }
      const first = bvh.start[node] as number;
      for (let slot = first; slot < first + (bvh.count[node] as number); slot += 1) {
        const t = bvh.order[slot] as number;
        const [ax, ay, az] = [corner(t, 0, 0) - x, corner(t, 0, 1) - y, corner(t, 0, 2) - z];
        const [bx, by, bz] = [corner(t, 1, 0) - x, corner(t, 1, 1) - y, corner(t, 1, 2) - z];
        const [cx, cy, cz] = [corner(t, 2, 0) - x, corner(t, 2, 1) - y, corner(t, 2, 2) - z];
        const [la, lb, lc] = [Math.hypot(ax, ay, az), Math.hypot(bx, by, bz), Math.hypot(cx, cy, cz)];
        const numerator = ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
        const denominator =
          la * lb * lc + (ax * bx + ay * by + az * bz) * lc + (ax * cx + ay * cy + az * cz) * lb + (bx * cx + by * cy + bz * cz) * la;
        total += 2 * Math.atan2(numerator, denominator);
      }
    }
    return total / (4 * Math.PI);
  };

  return {
    distance(x, y, z) {
      if (bvh.triangleCount === 0) return Infinity;
      const d = unsigned(x, y, z);
      return winding(x, y, z) > 0.5 ? -d : d;
    },
  };
}

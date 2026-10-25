/**
 * Signed distance to a closed triangle mesh (05 IMP §5.9, `field_from_solid`): unsigned distance by a branch-and-bound walk of the
 * deterministic `meshBvh`, sign by the generalised winding number (Van Oosterom-Strackee solid angles, far nodes by their dipole), inside iff w > 1/2.
 * @invariant negative inside, positive outside, exact to the triangles; a closed outward-oriented mesh is assumed (callers refuse open meshes)
 */

import type { MeshData } from '../../model/types';
import { type MeshBvh, buildMeshBvh } from '../meshBvh';

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

/**
 * Distance from (x, y, z) to the triangle whose nine coordinates start at `corners[offset]`: `closestPointOnTriangle` (Ericson 5.1.5) on scalars, without
 * allocating (the hot loop of every mesh-SDF sample).
 * @invariant the same operations in the same order as `closestPointOnTriangle` + `Math.hypot`, so the result is bit-identical to them and to the native twin
 */
function distanceToTriangle(corners: Float64Array, offset: number, x: number, y: number, z: number): number {
  const ax = corners[offset] as number;
  const ay = corners[offset + 1] as number;
  const az = corners[offset + 2] as number;
  const bx = corners[offset + 3] as number;
  const by = corners[offset + 4] as number;
  const bz = corners[offset + 5] as number;
  const cx = corners[offset + 6] as number;
  const cy = corners[offset + 7] as number;
  const cz = corners[offset + 8] as number;
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  const apx = x - ax;
  const apy = y - ay;
  const apz = z - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return Math.hypot(ax - x, ay - y, az - z);
  const bpx = x - bx;
  const bpy = y - by;
  const bpz = z - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return Math.hypot(bx - x, by - y, bz - z);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return Math.hypot(ax + abx * v - x, ay + aby * v - y, az + abz * v - z);
  }
  const cpx = x - cx;
  const cpy = y - cy;
  const cpz = z - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return Math.hypot(cx - x, cy - y, cz - z);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return Math.hypot(ax + acx * w - x, ay + acy * w - y, az + acz * w - z);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return Math.hypot(bx + (cx - bx) * w - x, by + (cy - by) * w - y, bz + (cz - bz) * w - z);
  }
  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator;
  const w = vc * denominator;
  return Math.hypot(ax + (abx * v + acx * w) - x, ay + (aby * v + acy * w) - y, az + (abz * v + acz * w) - z);
}

/** Evaluator over `mesh`; an empty mesh is +Infinity everywhere. */
export function prepareMeshSdf(mesh: MeshData): MeshSdf {
  const bvh = buildMeshBvh(mesh);
  const dipoles = dipolesOf(bvh);
  const stack = new Int32Array(Math.max(64, bvh.left.length));
  const corners = bvh.corners;

  const unsigned = (x: number, y: number, z: number): number => {
    const boxes = bvh.boxes;
    let best = Infinity;
    let top = 0;
    stack[top++] = 0;
    while (top > 0) {
      const node = stack[--top] as number;
      const o = node * 6;
      const gap = Math.hypot(
        Math.max((boxes[o] as number) - x, 0, x - (boxes[o + 3] as number)),
        Math.max((boxes[o + 1] as number) - y, 0, y - (boxes[o + 4] as number)),
        Math.max((boxes[o + 2] as number) - z, 0, z - (boxes[o + 5] as number)),
      );
      if (gap >= best) continue;
      const left = bvh.left[node] as number;
      if (left >= 0) {
        stack[top++] = bvh.right[node] as number;
        stack[top++] = left;
        continue;
      }
      const first = bvh.start[node] as number;
      for (let slot = first; slot < first + (bvh.count[node] as number); slot += 1) {
        const d = distanceToTriangle(bvh.corners, (bvh.order[slot] as number) * 9, x, y, z);
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
      const rx = d.cx - x;
      const ry = d.cy - y;
      const rz = d.cz - z;
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
        const o = (bvh.order[slot] as number) * 9;
        const ax = (corners[o] as number) - x;
        const ay = (corners[o + 1] as number) - y;
        const az = (corners[o + 2] as number) - z;
        const bx = (corners[o + 3] as number) - x;
        const by = (corners[o + 4] as number) - y;
        const bz = (corners[o + 5] as number) - z;
        const cx = (corners[o + 6] as number) - x;
        const cy = (corners[o + 7] as number) - y;
        const cz = (corners[o + 8] as number) - z;
        const la = Math.hypot(ax, ay, az);
        const lb = Math.hypot(bx, by, bz);
        const lc = Math.hypot(cx, cy, cz);
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

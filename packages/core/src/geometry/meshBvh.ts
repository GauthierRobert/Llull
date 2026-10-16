/**
 * Deterministic AABB tree over a `MeshData` in its local frame (PHY-21 TR-FPR-04). Median split on the longest centroid axis, leaf size
 * 8, ties broken by the lower triangle index. Queries take a rigid transform for the other mesh.
 * @invariant same mesh => byte-identical tree and query results (no random, fixed traversal order)
 * @invariant an empty or degenerate mesh yields a tree with no triangles; every query on it misses
 */

import type { MeshData, Vec3 } from '../model/types';
import { type Triangle, rayTriangleDistance, triangleDistance } from './triangleQueries';

const LEAF_SIZE = 8;

/** Rigid motion of the OTHER mesh into this tree's frame: `rotation` is a row-major 3x3, applied before `translation`. */
export interface RigidTransform {
  readonly rotation: readonly [number, number, number, number, number, number, number, number, number];
  readonly translation: Vec3;
}

export interface MeshBvh {
  readonly triangleCount: number;
  /** Local-frame bounds of the whole mesh (zeros when empty). */
  readonly min: Vec3;
  readonly max: Vec3;
  /** 9 numbers per original triangle index. */
  readonly corners: Float64Array;
  /** Triangle indices in leaf order. */
  readonly order: Int32Array;
  /** 6 numbers per node: min xyz, max xyz. */
  readonly boxes: Float64Array;
  /** Per node: left child (-1 for a leaf). */
  readonly left: Int32Array;
  /** Per node: right child (-1 for a leaf). */
  readonly right: Int32Array;
  /** Per node: first slot in `order` (leaf) and count. */
  readonly start: Int32Array;
  readonly count: Int32Array;
}

export interface BvhDistance {
  readonly distance: number;
  /** Witness point on this tree's mesh (its frame). */
  readonly pointA: Vec3;
  /** Witness point on the other mesh, in this tree's frame. */
  readonly pointB: Vec3;
}

export interface BvhRayHit {
  readonly t: number;
  readonly triangle: number;
  readonly point: Vec3;
}

function trianglesOf(mesh: MeshData): Float64Array {
  const count = Math.floor(mesh.indices.length / 3);
  const corners = new Float64Array(count * 9);
  for (let t = 0; t < count; t++) {
    for (let k = 0; k < 3; k++) {
      const vertex = (mesh.indices[t * 3 + k] ?? 0) * 3;
      for (let axis = 0; axis < 3; axis++) corners[t * 9 + k * 3 + axis] = mesh.positions[vertex + axis] ?? 0;
    }
  }
  return corners;
}

/** Build the tree of `mesh`. */
export function buildMeshBvh(mesh: MeshData): MeshBvh {
  const corners = trianglesOf(mesh);
  const triangleCount = corners.length / 9;
  const order = Int32Array.from({ length: triangleCount }, (_, i) => i);
  const centroid = (t: number, axis: number): number =>
    ((corners[t * 9 + axis] ?? 0) + (corners[t * 9 + 3 + axis] ?? 0) + (corners[t * 9 + 6 + axis] ?? 0)) / 3;
  const boxes: number[] = [];
  const left: number[] = [];
  const right: number[] = [];
  const start: number[] = [];
  const count: number[] = [];

  const build = (from: number, to: number): number => {
    const node = left.length;
    left.push(-1);
    right.push(-1);
    start.push(from);
    count.push(to - from);
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    const centroidBox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let slot = from; slot < to; slot++) {
      const t = order[slot] ?? 0;
      for (let axis = 0; axis < 3; axis++) {
        for (let k = 0; k < 3; k++) {
          const value = corners[t * 9 + k * 3 + axis] ?? 0;
          box[axis] = Math.min(box[axis] ?? Infinity, value);
          box[3 + axis] = Math.max(box[3 + axis] ?? -Infinity, value);
        }
        const c = centroid(t, axis);
        centroidBox[axis] = Math.min(centroidBox[axis] ?? Infinity, c);
        centroidBox[3 + axis] = Math.max(centroidBox[3 + axis] ?? -Infinity, c);
      }
    }
    boxes.push(...box);
    if (to - from <= LEAF_SIZE) return node;
    let axis = 0;
    let longest = -1;
    for (let a = 0; a < 3; a++) {
      const extent = (centroidBox[3 + a] ?? 0) - (centroidBox[a] ?? 0);
      if (extent > longest) {
        longest = extent;
        axis = a;
      }
    }
    const slice = Array.from(order.subarray(from, to)).sort((p, q) => centroid(p, axis) - centroid(q, axis) || p - q);
    order.set(slice, from);
    const middle = from + Math.floor((to - from) / 2);
    const l = build(from, middle);
    const r = build(middle, to);
    left[node] = l;
    right[node] = r;
    count[node] = 0;
    return node;
  };
  if (triangleCount > 0) build(0, triangleCount);
  const all = triangleCount > 0 ? boxes.slice(0, 6) : [0, 0, 0, 0, 0, 0];
  return {
    triangleCount,
    min: [all[0] ?? 0, all[1] ?? 0, all[2] ?? 0],
    max: [all[3] ?? 0, all[4] ?? 0, all[5] ?? 0],
    corners,
    order,
    boxes: Float64Array.from(boxes),
    left: Int32Array.from(left),
    right: Int32Array.from(right),
    start: Int32Array.from(start),
    count: Int32Array.from(count),
  };
}

const applyTransform = (transform: RigidTransform, x: number, y: number, z: number): Vec3 => {
  const r = transform.rotation;
  const t = transform.translation;
  return [
    (r[0] ?? 0) * x + (r[1] ?? 0) * y + (r[2] ?? 0) * z + t[0],
    (r[3] ?? 0) * x + (r[4] ?? 0) * y + (r[5] ?? 0) * z + t[1],
    (r[6] ?? 0) * x + (r[7] ?? 0) * y + (r[8] ?? 0) * z + t[2],
  ];
};

/** World triangle `index` of `bvh`, optionally moved by `transform`. */
function triangleAt(bvh: MeshBvh, index: number, transform: RigidTransform | null): Triangle {
  const c = bvh.corners;
  const base = index * 9;
  const corner = (k: number): Vec3 => {
    const x = c[base + k * 3] ?? 0;
    const y = c[base + k * 3 + 1] ?? 0;
    const z = c[base + k * 3 + 2] ?? 0;
    return transform === null ? [x, y, z] : applyTransform(transform, x, y, z);
  };
  return [corner(0), corner(1), corner(2)];
}

/** Axis-aligned box [minX..maxZ] of node `node` of `bvh`, moved by `transform` (bounds of the moved corners). */
function nodeBox(bvh: MeshBvh, node: number, transform: RigidTransform | null): [number, number, number, number, number, number] {
  const b = bvh.boxes;
  const o = node * 6;
  const lo: Vec3 = [b[o] ?? 0, b[o + 1] ?? 0, b[o + 2] ?? 0];
  const hi: Vec3 = [b[o + 3] ?? 0, b[o + 4] ?? 0, b[o + 5] ?? 0];
  if (transform === null) return [lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]];
  const out: [number, number, number, number, number, number] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const p = applyTransform(transform, corner & 1 ? hi[0] : lo[0], corner & 2 ? hi[1] : lo[1], corner & 4 ? hi[2] : lo[2]);
    for (let axis = 0; axis < 3; axis++) {
      out[axis] = Math.min(out[axis] ?? Infinity, p[axis] ?? 0);
      out[3 + axis] = Math.max(out[3 + axis] ?? -Infinity, p[axis] ?? 0);
    }
  }
  return out;
}

type Box = ReturnType<typeof nodeBox>;

function boxGap(a: Box, b: Box): number {
  let sum = 0;
  for (let axis = 0; axis < 3; axis++) {
    const gap = Math.max((a[axis] ?? 0) - (b[3 + axis] ?? 0), (b[axis] ?? 0) - (a[3 + axis] ?? 0), 0);
    sum += gap * gap;
  }
  return Math.sqrt(sum);
}

/**
 * Closest pair of triangles within `maxDistance`, stopping at the first pair at or below `stopAt`. Children are visited nearest box first
 * (ties: left before right); a candidate replaces the best only when strictly closer.
 */
function dualQuery(a: MeshBvh, b: MeshBvh, transform: RigidTransform | null, maxDistance: number, stopAt: number): BvhDistance | null {
  if (a.triangleCount === 0 || b.triangleCount === 0) return null;
  let best: BvhDistance | null = null;
  let bound = maxDistance;
  let done = false;
  const visit = (nodeA: number, nodeB: number): void => {
    if (done) return;
    const boxA = nodeBox(a, nodeA, null);
    const boxB = nodeBox(b, nodeB, transform);
    if (boxGap(boxA, boxB) > bound) return;
    const leafA = (a.left[nodeA] ?? -1) < 0;
    const leafB = (b.left[nodeB] ?? -1) < 0;
    if (leafA && leafB) {
      for (let i = 0; i < (a.count[nodeA] ?? 0) && !done; i++) {
        const triangleA = triangleAt(a, a.order[(a.start[nodeA] ?? 0) + i] ?? 0, null);
        for (let j = 0; j < (b.count[nodeB] ?? 0) && !done; j++) {
          const pair = triangleDistance(triangleA, triangleAt(b, b.order[(b.start[nodeB] ?? 0) + j] ?? 0, transform));
          if (pair.distance <= bound && (best === null || pair.distance < best.distance)) {
            best = pair;
            bound = pair.distance;
            if (pair.distance <= stopAt) done = true;
          }
        }
      }
      return;
    }
    const sizeA = (boxA[3] - boxA[0]) ** 2 + (boxA[4] - boxA[1]) ** 2 + (boxA[5] - boxA[2]) ** 2;
    const sizeB = (boxB[3] - boxB[0]) ** 2 + (boxB[4] - boxB[1]) ** 2 + (boxB[5] - boxB[2]) ** 2;
    const splitA = !leafA && (leafB || sizeA >= sizeB);
    const parent = splitA ? a : b;
    const node = splitA ? nodeA : nodeB;
    const children: [number, number] = [parent.left[node] ?? 0, parent.right[node] ?? 0];
    const pairs: Array<[number, number]> = children.map((child): [number, number] => (splitA ? [child, nodeB] : [nodeA, child]));
    const gapOf = ([x, y]: [number, number]): number => boxGap(nodeBox(a, x, null), nodeBox(b, y, transform));
    if (gapOf(pairs[1] ?? [0, 0]) < gapOf(pairs[0] ?? [0, 0])) pairs.reverse();
    for (const [x, y] of pairs) visit(x, y);
  };
  visit(0, 0);
  return best;
}

/** Whether the two meshes share a point (surface contact counts); `tolerance` widens it (document units). */
export function bvhIntersects(a: MeshBvh, b: MeshBvh, transform: RigidTransform | null = null, tolerance = 0): boolean {
  return dualQuery(a, b, transform, tolerance, tolerance) !== null;
}

/** Closest surface points of the two meshes when within `maxDistance`, else null. Distance 0 = surfaces touch or cross. */
export function bvhMinDistance(a: MeshBvh, b: MeshBvh, maxDistance: number, transform: RigidTransform | null = null): BvhDistance | null {
  return dualQuery(a, b, transform, maxDistance, 0);
}

/** First surface hit of the ray `origin + t * direction`, t in [tMin, maxT] (double-sided); ties go to the lower triangle index. */
export function bvhRayCast(bvh: MeshBvh, origin: Vec3, direction: Vec3, maxT: number, tMin = 0): BvhRayHit | null {
  if (bvh.triangleCount === 0) return null;
  let best: BvhRayHit | null = null;
  let limit = maxT;
  const slab = (node: number): boolean => {
    const b = bvh.boxes;
    const o = node * 6;
    let near = tMin;
    let far = limit;
    for (let axis = 0; axis < 3; axis++) {
      const lo = b[o + axis] ?? 0;
      const hi = b[o + 3 + axis] ?? 0;
      const originAxis = origin[axis] ?? 0;
      const directionAxis = direction[axis] ?? 0;
      if (directionAxis === 0) {
        if (originAxis < lo || originAxis > hi) return false;
        continue;
      }
      const t1 = (lo - originAxis) / directionAxis;
      const t2 = (hi - originAxis) / directionAxis;
      near = Math.max(near, Math.min(t1, t2));
      far = Math.min(far, Math.max(t1, t2));
      if (near > far * (1 + 1e-12) + 1e-12) return false;
    }
    return true;
  };
  const visit = (node: number): void => {
    if (!slab(node)) return;
    if ((bvh.left[node] ?? -1) < 0) {
      for (let i = 0; i < (bvh.count[node] ?? 0); i++) {
        const triangle = bvh.order[(bvh.start[node] ?? 0) + i] ?? 0;
        const t = rayTriangleDistance(origin, direction, triangleAt(bvh, triangle, null), tMin, limit);
        if (t !== null && (best === null || t < best.t || (t === best.t && triangle < best.triangle))) {
          best = { t, triangle, point: [origin[0] + direction[0] * t, origin[1] + direction[1] * t, origin[2] + direction[2] * t] };
          limit = t;
        }
      }
      return;
    }
    visit(bvh.left[node] ?? 0);
    visit(bvh.right[node] ?? 0);
  };
  visit(0);
  return best;
}

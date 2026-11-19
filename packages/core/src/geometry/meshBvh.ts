/**
 * Deterministic AABB tree over a `MeshData` in its local frame (PHY-21 TR-FPR-04). Median split on the longest centroid axis, leaf size
 * 8, ties broken by the lower triangle index. Queries take a rigid transform for the other mesh.
 * @invariant same mesh => byte-identical tree and query results (no random, fixed traversal order)
 * @invariant an empty or degenerate mesh yields a tree with no triangles; every query on it misses
 */

import type { MeshData, Vec3 } from '../model/types';
import { PAIR_FLOATS, RESULT_FLOATS, triangleDistanceInto } from './triangleDistanceKernel';
import { type Triangle, rayTriangleDistance } from './triangleQueries';
import { appendAll } from '../lib/appendAll';

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
    appendAll(boxes, box);
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

/** World triangle `index` of `bvh` (the ray cast reads it in the tree's own frame). */
function triangleAt(bvh: MeshBvh, index: number): Triangle {
  const c = bvh.corners;
  const base = index * 9;
  const corner = (k: number): Vec3 => [c[base + k * 3] ?? 0, c[base + k * 3 + 1] ?? 0, c[base + k * 3 + 2] ?? 0];
  return [corner(0), corner(1), corner(2)];
}

/**
 * Preallocated scratch of the dual query (it is synchronous and never re-entered): boxes are 6 floats [min xyz, max xyz]; `pair` holds the
 * two triangles handed to the distance kernel; `leafB` / `leafBoxB` the transformed triangles and boxes of the current B leaf.
 */
const nodeBoxA = new Float64Array(6);
const nodeBoxB = new Float64Array(6);
const childBox = new Float64Array(6);
const gapBoxA = new Float64Array(6);
const triangleBoxA = new Float64Array(6);
const pair = new Float64Array(PAIR_FLOATS);
const pairResult = new Float64Array(RESULT_FLOATS);
let leafB = new Float64Array(LEAF_SIZE * 9);
let leafBoxB = new Float64Array(LEAF_SIZE * 6);

/** Box of node `node` of `bvh` into `out`, moved by `transform` (bounds of the moved corners). */
function writeNodeBox(bvh: MeshBvh, node: number, transform: RigidTransform | null, out: Float64Array): void {
  const b = bvh.boxes;
  const o = node * 6;
  const lx = b[o] ?? 0;
  const ly = b[o + 1] ?? 0;
  const lz = b[o + 2] ?? 0;
  const hx = b[o + 3] ?? 0;
  const hy = b[o + 4] ?? 0;
  const hz = b[o + 5] ?? 0;
  if (transform === null) {
    out[0] = lx;
    out[1] = ly;
    out[2] = lz;
    out[3] = hx;
    out[4] = hy;
    out[5] = hz;
    return;
  }
  const r = transform.rotation;
  const t = transform.translation;
  const r0 = r[0] ?? 0;
  const r1 = r[1] ?? 0;
  const r2 = r[2] ?? 0;
  const r3 = r[3] ?? 0;
  const r4 = r[4] ?? 0;
  const r5 = r[5] ?? 0;
  const r6 = r[6] ?? 0;
  const r7 = r[7] ?? 0;
  const r8 = r[8] ?? 0;
  out.fill(Infinity, 0, 3);
  out.fill(-Infinity, 3, 6);
  for (let corner = 0; corner < 8; corner++) {
    const x = corner & 1 ? hx : lx;
    const y = corner & 2 ? hy : ly;
    const z = corner & 4 ? hz : lz;
    const px = r0 * x + r1 * y + r2 * z + t[0];
    const py = r3 * x + r4 * y + r5 * z + t[1];
    const pz = r6 * x + r7 * y + r8 * z + t[2];
    out[0] = Math.min(out[0] ?? Infinity, px);
    out[3] = Math.max(out[3] ?? -Infinity, px);
    out[1] = Math.min(out[1] ?? Infinity, py);
    out[4] = Math.max(out[4] ?? -Infinity, py);
    out[2] = Math.min(out[2] ?? Infinity, pz);
    out[5] = Math.max(out[5] ?? -Infinity, pz);
  }
}

/** Triangle `index` of `bvh`, moved by `transform`, into `out` at `offset` (9 floats). */
function writeTriangle(bvh: MeshBvh, index: number, transform: RigidTransform | null, out: Float64Array, offset: number): void {
  const c = bvh.corners;
  const base = index * 9;
  if (transform === null) {
    for (let k = 0; k < 9; k++) out[offset + k] = c[base + k] ?? 0;
    return;
  }
  const r = transform.rotation;
  const t = transform.translation;
  for (let k = 0; k < 3; k++) {
    const x = c[base + k * 3] ?? 0;
    const y = c[base + k * 3 + 1] ?? 0;
    const z = c[base + k * 3 + 2] ?? 0;
    out[offset + k * 3] = (r[0] ?? 0) * x + (r[1] ?? 0) * y + (r[2] ?? 0) * z + t[0];
    out[offset + k * 3 + 1] = (r[3] ?? 0) * x + (r[4] ?? 0) * y + (r[5] ?? 0) * z + t[1];
    out[offset + k * 3 + 2] = (r[6] ?? 0) * x + (r[7] ?? 0) * y + (r[8] ?? 0) * z + t[2];
  }
}

/** Bounds of the triangle at `offset` of `source` into `out` at `outOffset` (6 floats). */
function writeTriangleBox(source: Float64Array, offset: number, out: Float64Array, outOffset: number): void {
  const s = (k: number): number => source[offset + k] ?? 0;
  out[outOffset] = Math.min(s(0), s(3), s(6));
  out[outOffset + 1] = Math.min(s(1), s(4), s(7));
  out[outOffset + 2] = Math.min(s(2), s(5), s(8));
  out[outOffset + 3] = Math.max(s(0), s(3), s(6));
  out[outOffset + 4] = Math.max(s(1), s(4), s(7));
  out[outOffset + 5] = Math.max(s(2), s(5), s(8));
}

/** Distance between the boxes at `ao` of `a` and `bo` of `b` (0 when they overlap). */
function boxGap(a: Float64Array, ao: number, b: Float64Array, bo: number): number {
  let sum = 0;
  for (let axis = 0; axis < 3; axis++) {
    const gap = Math.max((a[ao + axis] ?? 0) - (b[bo + 3 + axis] ?? 0), (b[bo + axis] ?? 0) - (a[ao + 3 + axis] ?? 0), 0);
    sum += gap * gap;
  }
  return Math.sqrt(sum);
}

const boxSize = (box: Float64Array): number =>
  ((box[3] ?? 0) - (box[0] ?? 0)) ** 2 + ((box[4] ?? 0) - (box[1] ?? 0)) ** 2 + ((box[5] ?? 0) - (box[2] ?? 0)) ** 2;

/** Gap between the boxes of node `x` of `a` and node `y` of `b` (moved by `transform`). */
function nodeGap(a: MeshBvh, x: number, b: MeshBvh, y: number, transform: RigidTransform | null): number {
  writeNodeBox(a, x, null, childBox);
  gapBoxA.set(childBox);
  writeNodeBox(b, y, transform, childBox);
  return boxGap(gapBoxA, 0, childBox, 0);
}

/**
 * Closest pair of triangles within `maxDistance`, stopping at the first pair at or below `stopAt`. Children are visited nearest box first
 * (ties: left before right); a candidate replaces the best only when strictly closer. No allocation per node or per triangle pair.
 */
function dualQuery(a: MeshBvh, b: MeshBvh, transform: RigidTransform | null, maxDistance: number, stopAt: number): BvhDistance | null {
  if (a.triangleCount === 0 || b.triangleCount === 0) return null;
  let found = false;
  let bestDistance = Infinity;
  const bestPoints = new Float64Array(6);
  let bound = maxDistance;
  let done = false;
  const leafPairs = (nodeA: number, nodeB: number): void => {
    // each triangle pair is tested against its own boxes first: a pair whose boxes are farther apart than `bound` cannot improve the best
    const countB = b.count[nodeB] ?? 0;
    if (leafB.length < countB * 9) {
      leafB = new Float64Array(countB * 9);
      leafBoxB = new Float64Array(countB * 6);
    }
    for (let j = 0; j < countB; j++) {
      writeTriangle(b, b.order[(b.start[nodeB] ?? 0) + j] ?? 0, transform, leafB, j * 9);
      writeTriangleBox(leafB, j * 9, leafBoxB, j * 6);
    }
    for (let i = 0; i < (a.count[nodeA] ?? 0) && !done; i++) {
      writeTriangle(a, a.order[(a.start[nodeA] ?? 0) + i] ?? 0, null, pair, 0);
      writeTriangleBox(pair, 0, triangleBoxA, 0);
      for (let j = 0; j < countB && !done; j++) {
        if (boxGap(triangleBoxA, 0, leafBoxB, j * 6) > bound + 1e-12 * Math.max(1, bound)) continue;
        for (let k = 0; k < 9; k++) pair[9 + k] = leafB[j * 9 + k] ?? 0;
        triangleDistanceInto(pair, pairResult);
        const distance = pairResult[0] ?? 0;
        if (distance <= bound && (!found || distance < bestDistance)) {
          found = true;
          bestDistance = distance;
          for (let k = 0; k < 6; k++) bestPoints[k] = pairResult[1 + k] ?? 0;
          bound = distance;
          if (distance <= stopAt) done = true;
        }
      }
    }
  };
  const visit = (nodeA: number, nodeB: number): void => {
    if (done) return;
    writeNodeBox(a, nodeA, null, nodeBoxA);
    writeNodeBox(b, nodeB, transform, nodeBoxB);
    if (boxGap(nodeBoxA, 0, nodeBoxB, 0) > bound) return;
    const leafA = (a.left[nodeA] ?? -1) < 0;
    const leafBNode = (b.left[nodeB] ?? -1) < 0;
    if (leafA && leafBNode) return leafPairs(nodeA, nodeB);
    const splitA = !leafA && (leafBNode || boxSize(nodeBoxA) >= boxSize(nodeBoxB));
    const parent = splitA ? a : b;
    const node = splitA ? nodeA : nodeB;
    const first = parent.left[node] ?? 0;
    const second = parent.right[node] ?? 0;
    const gapFirst = splitA ? nodeGap(a, first, b, nodeB, transform) : nodeGap(a, nodeA, b, first, transform);
    const gapSecond = splitA ? nodeGap(a, second, b, nodeB, transform) : nodeGap(a, nodeA, b, second, transform);
    const secondFirst = gapSecond < gapFirst;
    const one = secondFirst ? second : first;
    const two = secondFirst ? first : second;
    if (splitA) {
      visit(one, nodeB);
      visit(two, nodeB);
    } else {
      visit(nodeA, one);
      visit(nodeA, two);
    }
  };
  visit(0, 0);
  if (!found) return null;
  return {
    distance: bestDistance,
    pointA: [bestPoints[0] ?? 0, bestPoints[1] ?? 0, bestPoints[2] ?? 0],
    pointB: [bestPoints[3] ?? 0, bestPoints[4] ?? 0, bestPoints[5] ?? 0],
  };
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
        const t = rayTriangleDistance(origin, direction, triangleAt(bvh, triangle), tMin, limit);
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

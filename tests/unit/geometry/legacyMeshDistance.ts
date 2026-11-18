/**
 * FROZEN oracle (PERF1 #3): the tuple-allocating triangle distance and BVH dual query as they were before the allocation-free kernel
 * (`triangleDistanceKernel.ts`). The kernel must match this bit for bit; do not "improve" this file.
 */
import type { Vec3 } from '@core/model/types';
import { add3, cross3, dot3, scale3, sub3 } from '@lib/vec3';
import type { MeshBvh, RigidTransform, BvhDistance } from '@core/geometry/meshBvh';

type Triangle = readonly [Vec3, Vec3, Vec3];

interface ClosestPair {
  readonly distance: number;
  readonly pointA: Vec3;
  readonly pointB: Vec3;
}

const lengthSq = (v: Vec3): number => dot3(v, v);

/** Closest point of triangle `abc` to `p` (Ericson, Real-Time Collision Detection 5.1.5). */
function closestPointOnTriangle(p: Vec3, [a, b, c]: Triangle): Vec3 {
  const ab = sub3(b, a);
  const ac = sub3(c, a);
  const ap = sub3(p, a);
  const d1 = dot3(ab, ap);
  const d2 = dot3(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub3(p, b);
  const d3 = dot3(ab, bp);
  const d4 = dot3(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add3(a, scale3(ab, d1 / (d1 - d3)));
  const cp = sub3(p, c);
  const d5 = dot3(ab, cp);
  const d6 = dot3(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add3(a, scale3(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return add3(b, scale3(sub3(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))));
  const denominator = 1 / (va + vb + vc);
  return add3(a, add3(scale3(ab, vb * denominator), scale3(ac, vc * denominator)));
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** Closest points between segments `p1q1` and `p2q2` (Ericson 5.1.9). */
function closestPointsOfSegments(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): ClosestPair {
  const d1 = sub3(q1, p1);
  const d2 = sub3(q2, p2);
  const r = sub3(p1, p2);
  const a = dot3(d1, d1);
  const e = dot3(d2, d2);
  const f = dot3(d2, r);
  let s = 0;
  let t = 0;
  if (a <= 1e-300 && e <= 1e-300) {
    s = 0;
    t = 0;
  } else if (a <= 1e-300) {
    t = clamp01(f / e);
  } else {
    const c = dot3(d1, r);
    if (e <= 1e-300) {
      s = clamp01(-c / a);
    } else {
      const b = dot3(d1, d2);
      const denominator = a * e - b * b;
      s = denominator > 1e-300 ? clamp01((b * f - c * e) / denominator) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  const pointA = add3(p1, scale3(d1, s));
  const pointB = add3(p2, scale3(d2, t));
  return { distance: Math.sqrt(lengthSq(sub3(pointA, pointB))), pointA, pointB };
}

/** Point where segment `pq` pierces the plane interior of `tri` (non-coplanar crossing only), else null. */
function segmentPiercesTriangle(p: Vec3, q: Vec3, [a, b, c]: Triangle): Vec3 | null {
  const normal = cross3(sub3(b, a), sub3(c, a));
  const direction = sub3(q, p);
  const denominator = dot3(normal, direction);
  if (denominator === 0) return null;
  const t = dot3(normal, sub3(a, p)) / denominator;
  if (t < 0 || t > 1) return null;
  const point = add3(p, scale3(direction, t));
  const slack = -1e-12 * lengthSq(normal);
  const inside =
    dot3(cross3(sub3(b, a), sub3(point, a)), normal) >= slack &&
    dot3(cross3(sub3(c, b), sub3(point, b)), normal) >= slack &&
    dot3(cross3(sub3(a, c), sub3(point, c)), normal) >= slack;
  return inside ? point : null;
}

const edgesOf = ([a, b, c]: Triangle): ReadonlyArray<readonly [Vec3, Vec3]> => [
  [a, b],
  [b, c],
  [c, a],
];

/**
 * Minimum distance between two triangles with witness points; 0 (witness = the crossing point) when they intersect. Evaluation order is
 * fixed: piercing edges of `first`, piercing edges of `second`, then edge-edge pairs, then vertex-triangle pairs; the first strictly
 * smaller candidate wins.
 */
export function legacyTriangleDistance(first: Triangle, second: Triangle): ClosestPair {
  for (const [p, q] of edgesOf(first)) {
    const hit = segmentPiercesTriangle(p, q, second);
    if (hit !== null) return { distance: 0, pointA: hit, pointB: hit };
  }
  for (const [p, q] of edgesOf(second)) {
    const hit = segmentPiercesTriangle(p, q, first);
    if (hit !== null) return { distance: 0, pointA: hit, pointB: hit };
  }
  let best: ClosestPair | null = null;
  const consider = (candidate: ClosestPair): void => {
    if (best === null || candidate.distance < best.distance) best = candidate;
  };
  for (const [p1, q1] of edgesOf(first)) {
    for (const [p2, q2] of edgesOf(second)) consider(closestPointsOfSegments(p1, q1, p2, q2));
  }
  for (const vertex of first) {
    const onSecond = closestPointOnTriangle(vertex, second);
    consider({ distance: Math.sqrt(lengthSq(sub3(vertex, onSecond))), pointA: vertex, pointB: onSecond });
  }
  for (const vertex of second) {
    const onFirst = closestPointOnTriangle(vertex, first);
    consider({ distance: Math.sqrt(lengthSq(sub3(vertex, onFirst))), pointA: onFirst, pointB: vertex });
  }
  return best ?? { distance: Infinity, pointA: first[0], pointB: second[0] };
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

function triangleBox(triangle: Triangle): Box {
  const [p, q, r] = triangle;
  return [
    Math.min(p[0], q[0], r[0]),
    Math.min(p[1], q[1], r[1]),
    Math.min(p[2], q[2], r[2]),
    Math.max(p[0], q[0], r[0]),
    Math.max(p[1], q[1], r[1]),
    Math.max(p[2], q[2], r[2]),
  ];
}

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
export function legacyDualQuery(
  a: MeshBvh,
  b: MeshBvh,
  transform: RigidTransform | null,
  maxDistance: number,
  stopAt: number,
): BvhDistance | null {
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
      // each triangle pair is tested against its own boxes first: a pair whose boxes are farther apart than `bound` cannot improve the best
      const trianglesB = Array.from({ length: b.count[nodeB] ?? 0 }, (_, j) =>
        triangleAt(b, b.order[(b.start[nodeB] ?? 0) + j] ?? 0, transform),
      );
      const boxesB = trianglesB.map(triangleBox);
      for (let i = 0; i < (a.count[nodeA] ?? 0) && !done; i++) {
        const triangleA = triangleAt(a, a.order[(a.start[nodeA] ?? 0) + i] ?? 0, null);
        const boxOfA = triangleBox(triangleA);
        for (let j = 0; j < trianglesB.length && !done; j++) {
          if (boxGap(boxOfA, boxesB[j] ?? boxOfA) > bound + 1e-12 * Math.max(1, bound)) continue;
          const pair = legacyTriangleDistance(triangleA, trianglesB[j] ?? triangleA);
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

/**
 * Convex envelope of a flight run (14 FLL-M2b, `at: "convex_envelope"`): the instants whose specific force a - g (body axes, the load factor
 * vector, which the mounts balance: sum F = m (a - g)) are the vertices of the convex hull of the specific forces of all sampled instants,
 * within a tolerance. Every sampled specific force lies inside the hull of the chosen instants or within `tolerance` x the diagonal of their
 * bounding box of it, so a response linear in the specific force is bounded by the chosen load cases to that tolerance.
 */

import type { Vec3 } from '@core/model/vectors';
import { maxOf, minOf } from '@lib/arrayExtrema';

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => {
  const length = norm(a);
  return length > 0 ? [a[0] / length, a[1] / length, a[2] / length] : [0, 0, 0];
};

interface Face {
  readonly corners: readonly [number, number, number];
  readonly normal: Vec3;
  readonly offset: number;
}

/** 2D hull (monotone chain) of points that lie within `eps` of a plane through `origin` spanned by e1, e2: the vertex indices. */
function planarHull(points: readonly Vec3[], origin: Vec3, e1: Vec3, e2: Vec3, eps: number): number[] {
  const flat = points.map((p, index) => ({ index, x: dot(sub(p, origin), e1), y: dot(sub(p, origin), e2) }));
  flat.sort((a, b) => a.x - b.x || a.y - b.y || a.index - b.index);
  type Flat = (typeof flat)[number];
  const turn = (o: Flat, a: Flat, b: Flat): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const chain = (ordered: readonly Flat[]): Flat[] => {
    const out: Flat[] = [];
    for (const point of ordered) {
      for (;;) {
        const b = out[out.length - 1];
        const a = out[out.length - 2];
        // b is dropped when it lies within eps of the segment a -> point (or right of it)
        if (a === undefined || b === undefined || turn(a, b, point) > eps * Math.hypot(point.x - a.x, point.y - a.y)) break;
        out.pop();
      }
      out.push(point);
    }
    return out.slice(0, -1);
  };
  return [...chain(flat), ...chain([...flat].reverse())].map((point) => point.index);
}

/** Face through the points a, b, c (indices) with the normal (b - a) x (c - a), unit. */
function planeFace(at: (index: number) => Vec3, a: number, b: number, c: number): Face {
  const normal = unit(cross(sub(at(b), at(a)), sub(at(c), at(a))));
  return { corners: [a, b, c], normal, offset: dot(normal, at(a)) };
}

/** Face through a, b, c oriented away from `inside`. */
function outwardFace(at: (index: number) => Vec3, [a, b, c]: readonly [number, number, number], inside: Vec3): Face {
  const face = planeFace(at, a, b, c);
  return dot(face.normal, inside) > face.offset ? planeFace(at, a, c, b) : face;
}

/** Distance from p to the triangle a b c (the plane when p projects inside it, else the nearest edge). */
function triangleDistance(p: Vec3, a: Vec3, b: Vec3, c: Vec3, normal: Vec3): number {
  const height = dot(sub(p, a), normal);
  const q = sub(p, [normal[0] * height, normal[1] * height, normal[2] * height]);
  const left = (from: Vec3, to: Vec3): boolean => dot(cross(sub(to, from), sub(q, from)), normal) >= 0;
  if (left(a, b) && left(b, c) && left(c, a)) return Math.abs(height);
  const segment = (from: Vec3, to: Vec3): number => {
    const edge = sub(to, from);
    const length2 = dot(edge, edge);
    const t = length2 > 0 ? Math.min(1, Math.max(0, dot(sub(p, from), edge) / length2)) : 0;
    return norm(sub(p, [from[0] + t * edge[0], from[1] + t * edge[1], from[2] + t * edge[2]]));
  };
  return Math.min(segment(a, b), segment(b, c), segment(c, a));
}

/** Euclidean distance from p to the convex hull bounded by `faces` (0 inside): the nearest visible face. */
function hullDistance(at: (index: number) => Vec3, faces: readonly Face[], p: Vec3): number {
  let distance = Infinity;
  for (const face of faces)
    if (dot(face.normal, p) - face.offset > 0)
      distance = Math.min(distance, triangleDistance(p, at(face.corners[0]), at(face.corners[1]), at(face.corners[2]), face.normal));
  return Number.isFinite(distance) ? distance : 0;
}

/** The first point of `indices` farthest by `score`. */
const farthest = (indices: readonly number[], score: (index: number) => number): number =>
  indices.reduce((best, index) => (score(index) > score(best) ? index : best), indices[0] ?? 0);

/** A tetrahedron of `indices` thicker than eps, or the dimension (0, 1, 2) of the cloud with its spanning points. */
function seedOf(
  at: (index: number) => Vec3,
  indices: readonly number[],
  eps: number,
):
  | { readonly seed: readonly [number, number, number, number] }
  | { readonly flat: readonly number[]; readonly u: Vec3; readonly normal: Vec3 } {
  const first = indices[0] ?? 0;
  const i0 = farthest(indices, (index) => norm(sub(at(index), at(first))));
  const i1 = farthest(indices, (index) => norm(sub(at(index), at(i0))));
  if (!(norm(sub(at(i1), at(i0))) > eps)) return { flat: [i0], u: [0, 0, 0], normal: [0, 0, 0] };
  const u = unit(sub(at(i1), at(i0)));
  const offLine = (index: number): number => norm(cross(sub(at(index), at(i0)), u));
  const i2 = farthest(indices, offLine);
  if (!(offLine(i2) > eps)) return { flat: [i0, i1], u, normal: [0, 0, 0] };
  const normal = unit(cross(u, sub(at(i2), at(i0))));
  const offPlane = (index: number): number => Math.abs(dot(sub(at(index), at(i0)), normal));
  const i3 = farthest(indices, offPlane);
  if (!(offPlane(i3) > eps)) return { flat: [i0, i1, i2], u, normal };
  return { seed: [i0, i1, i2, i3] };
}

/**
 * Incremental 3D hull of `indices` from the tetrahedron `seed`: a point farther than `eps` (Euclidean) from the current hull replaces every
 * face it sees (horizon edges kept); a nearer one is skipped, and stays within eps since the hull only grows.
 */
function spatialHull(
  at: (index: number) => Vec3,
  indices: readonly number[],
  seed: readonly [number, number, number, number],
  eps: number,
): Face[] {
  const [i0, i1, i2, i3] = seed;
  const [a, b, c, d] = [at(i0), at(i1), at(i2), at(i3)];
  const centre: Vec3 = [(a[0] + b[0] + c[0] + d[0]) / 4, (a[1] + b[1] + c[1] + d[1]) / 4, (a[2] + b[2] + c[2] + d[2]) / 4];
  let faces: Face[] = [
    outwardFace(at, [i0, i1, i2], centre),
    outwardFace(at, [i0, i1, i3], centre),
    outwardFace(at, [i0, i2, i3], centre),
    outwardFace(at, [i1, i2, i3], centre),
  ];
  const order = [...indices].sort((p, q) => norm(sub(at(q), centre)) - norm(sub(at(p), centre)) || p - q);
  for (const index of order) {
    const p = at(index);
    if (!(hullDistance(at, faces, p) > eps)) continue;
    const visibleSet = new Set(faces.filter((face) => dot(face.normal, p) - face.offset > 0));
    const edges = new Set([...visibleSet].flatMap(({ corners: [x, y, z] }) => [`${x}:${y}`, `${y}:${z}`, `${z}:${x}`]));
    const horizon = [...edges].map((edge) => edge.split(':').map(Number) as [number, number]).filter(([x, y]) => !edges.has(`${y}:${x}`));
    faces = [...faces.filter((face) => !visibleSet.has(face)), ...horizon.map(([from, to]) => planeFace(at, from, to, index))];
  }
  return faces;
}

/** Vertices of a 3D hull without the ones within `floor` of the hull of the others (points on a face or an edge of the final hull). */
function pruned(at: (index: number) => Vec3, faces: readonly Face[], floor: number): number[] {
  let kept = [...new Set(faces.flatMap((face) => face.corners))].sort((p, q) => p - q);
  for (const vertex of [...kept]) {
    const others = kept.filter((index) => index !== vertex);
    const seed = seedOf(at, others, floor);
    if (!('seed' in seed)) continue;
    if (!(hullDistance(at, spatialHull(at, others, seed.seed, floor), at(vertex)) > floor)) kept = others;
  }
  return kept;
}

/**
 * Indices (ascending) of the instants whose `points` are the vertices of their convex hull to within eps = tolerance x the bounding-box
 * diagonal: a point less than eps (Euclidean) from the current hull is not added; points on a face or an edge of the result are dropped. A
 * degenerate cloud gives its hull in its own dimension (one point, the two ends of a segment, a planar polygon).
 * @invariant every point lies within eps (plus 1e-9 of the diagonal) of the convex hull of the returned points, so max over returned u.p >= max over all u.p - eps for every unit u
 */
export function convexEnvelopeIndices(points: readonly Vec3[], tolerance: number): number[] {
  if (points.length === 0) return [];
  const at = (index: number): Vec3 => points[index] ?? [0, 0, 0];
  const axis = (k: 0 | 1 | 2): number => maxOf(points.map((p) => p[k])) - minOf(points.map((p) => p[k]));
  const diagonal = Math.hypot(axis(0), axis(1), axis(2));
  const eps = tolerance * diagonal;
  const all = points.map((_, index) => index);
  const seed = seedOf(at, all, eps);
  if ('seed' in seed) return pruned(at, spatialHull(at, all, seed.seed, eps), 1e-9 * diagonal);
  if (seed.flat.length < 3) return [...seed.flat].sort((p, q) => p - q);
  const origin = at(seed.flat[0] ?? 0);
  return [...new Set(planarHull(points, origin, seed.u, cross(seed.normal, seed.u), eps))].sort((p, q) => p - q);
}

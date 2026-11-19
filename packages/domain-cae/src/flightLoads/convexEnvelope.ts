/**
 * Convex envelope of a flight run (14 FLL-M2b, `at: "convex_envelope"`): the instants whose specific force a - g (body axes, the load factor
 * vector, which the mounts balance: sum F = m (a - g)) are the vertices of the convex hull of the specific forces of all sampled instants,
 * within a tolerance. Every sampled specific force lies inside the hull of the chosen instants or within `tolerance` x the diagonal of their
 * bounding box of it (Euclidean, also for a flat cloud hulled in its plane or on its line), so a response linear in the specific force is
 * bounded by the chosen load cases to that tolerance.
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

interface Flat {
  readonly index: number;
  readonly x: number;
  readonly y: number;
}

const turn = (o: Flat, a: Flat, b: Flat): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Distance from p to the segment a b in the plane. */
function segmentDistance2(p: Flat, a: Flat, b: Flat): number {
  const [ex, ey] = [b.x - a.x, b.y - a.y];
  const length2 = ex * ex + ey * ey;
  const t = length2 > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * ex + (p.y - a.y) * ey) / length2)) : 0;
  return Math.hypot(p.x - a.x - t * ex, p.y - a.y - t * ey);
}

/** Distance from p to the counter-clockwise convex polygon `ring` (0 inside): the nearest edge it lies outside of. */
function ringDistance(ring: readonly Flat[], p: Flat): number {
  let distance = Infinity;
  ring.forEach((a, k) => {
    const b = ring[(k + 1) % ring.length] ?? a;
    if (turn(a, b, p) < 0) distance = Math.min(distance, segmentDistance2(p, a, b));
  });
  return Number.isFinite(distance) ? distance : 0;
}

/** `ring` with `p` (outside it) inserted: the vertices strictly inside the chain of edges p sees are removed. */
function ringWith(ring: readonly Flat[], p: Flat): Flat[] {
  const n = ring.length;
  const sees = (k: number): boolean => turn(ring[k % n] ?? p, ring[(k + 1) % n] ?? p, p) < 0;
  let start = 0;
  while (start < n && !(sees(start) && !sees(start + n - 1))) start++;
  let stop = start;
  while (stop + 1 < start + n && sees(stop + 1)) stop++;
  // edges start..stop are visible: keep vertex `start`, drop start + 1 .. stop, insert p, continue with stop + 1
  const kept = Array.from({ length: n - (stop - start) }, (_, k) => ring[(stop + 1 + k) % n] ?? p);
  return [...kept, p];
}

/**
 * Incremental 2D hull of points lying within eps of the plane through `origin` spanned by e1, e2 (farthest from the seed triangle first): a
 * point farther than `eps` from the current polygon is added, a nearer one skipped (it stays within eps: the polygon only grows); vertices left
 * within 1e-9 x `scale` of the polygon of the others (collinear ones) are dropped, each removal checked against every vertex removed before it.
 */
function planarHull(
  points: readonly Vec3[],
  seed: readonly [number, number, number],
  frame: readonly [Vec3, Vec3, Vec3],
  eps: number,
  scale: number,
): number[] {
  const [origin, e1, e2] = frame;
  const flat = points.map((p, index): Flat => ({ index, x: dot(sub(p, origin), e1), y: dot(sub(p, origin), e2) }));
  const of = (index: number): Flat => flat[index] ?? { index, x: 0, y: 0 };
  const [a, b, c] = [of(seed[0]), of(seed[1]), of(seed[2])];
  // e2 = normal x e1 is the part of (seed 3 - seed 1) across e1, so the seed triangle is counter-clockwise in (e1, e2)
  let ring: Flat[] = [a, b, c];
  const [cx, cy] = [(a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3];
  const order = [...flat].sort((p, q) => Math.hypot(q.x - cx, q.y - cy) - Math.hypot(p.x - cx, p.y - cy) || p.index - q.index);
  for (const point of order) if (ringDistance(ring, point) > eps) ring = ringWith(ring, point);
  const floor = 1e-9 * scale;
  const removed: Flat[] = [];
  for (const vertex of [...ring]) {
    const others = ring.filter((entry) => entry !== vertex);
    if (others.length >= 3 && [vertex, ...removed].every((entry) => !(ringDistance(others, entry) > floor))) {
      ring = others;
      removed.push(vertex);
    }
  }
  return ring.map((point) => point.index);
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

/** Thresholds of `seedOf`: the largest point extent, off-line distance and signed off-plane spread a cloud may have and still count as flat. */
interface FlatLimits {
  readonly point: number;
  readonly line: number;
  readonly plane: number;
}

/** A tetrahedron of `indices` thicker than the limits, or the dimension (0, 1, 2) of the cloud with its spanning points. */
function seedOf(
  at: (index: number) => Vec3,
  indices: readonly number[],
  limits: FlatLimits,
):
  | { readonly seed: readonly [number, number, number, number] }
  | { readonly flat: readonly number[]; readonly u: Vec3; readonly normal: Vec3 } {
  const first = indices[0] ?? 0;
  const i0 = farthest(indices, (index) => norm(sub(at(index), at(first))));
  const i1 = farthest(indices, (index) => norm(sub(at(index), at(i0))));
  if (!(norm(sub(at(i1), at(i0))) > limits.point)) return { flat: [i0], u: [0, 0, 0], normal: [0, 0, 0] };
  const u = unit(sub(at(i1), at(i0)));
  const offLine = (index: number): number => norm(cross(sub(at(index), at(i0)), u));
  const i2 = farthest(indices, offLine);
  if (!(offLine(i2) > limits.line)) return { flat: [i0, i1], u, normal: [0, 0, 0] };
  const normal = unit(cross(u, sub(at(i2), at(i0))));
  const height = (index: number): number => dot(sub(at(index), at(i0)), normal);
  const spread = maxOf(indices.map(height)) - minOf(indices.map(height));
  if (!(spread > limits.plane)) return { flat: [i0, i1, i2], u, normal };
  const i3 = farthest(indices, (index) => Math.abs(height(index)));
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

/** Hull faces of `indices`, or null when they are flatter than `floor` (no 3D hull). */
function facesOf(at: (index: number) => Vec3, indices: readonly number[], floor: number): Face[] | null {
  const seed = seedOf(at, indices, { point: floor, line: floor, plane: floor });
  return 'seed' in seed ? spatialHull(at, indices, seed.seed, floor) : null;
}

/**
 * Vertices of a 3D hull without the ones within `floor` of the hull of the others (points on a face or an edge of the final hull). A removal
 * is kept only if every vertex removed so far stays within `floor` of the new hull, so the floors do not accumulate.
 */
function pruned(at: (index: number) => Vec3, faces: readonly Face[], floor: number): number[] {
  let kept = [...new Set(faces.flatMap((face) => face.corners))].sort((p, q) => p - q);
  const removed: number[] = [];
  for (const vertex of [...kept]) {
    const others = kept.filter((index) => index !== vertex);
    const hull = facesOf(at, others, floor);
    if (hull !== null && [vertex, ...removed].every((index) => !(hullDistance(at, hull, at(index)) > floor))) {
      kept = others;
      removed.push(vertex);
    }
  }
  return kept;
}

/**
 * Indices (ascending) of the instants whose `points` are the vertices of their convex hull to within eps = tolerance x the bounding-box
 * diagonal: a point less than eps (Euclidean) from the current hull is not added; points on a face or an edge of the result are dropped. A
 * degenerate cloud gives its hull in its own dimension (one point, the two ends of a segment, a planar polygon).
 * @invariant every point lies within eps (plus 1e-9 of the diagonal) of the convex hull of the returned points (Euclidean): in 3D by the
 *   insertion test; a flat cloud (signed off-plane spread <= eps / sqrt 2) by sqrt((eps / sqrt 2)^2 + spread^2) <= eps; a line (off-line
 *   distance <= eps / 2) by the disc of the offsets; so max over returned u.p >= max over all u.p - eps for every unit u
 */
export function convexEnvelopeIndices(points: readonly Vec3[], tolerance: number): number[] {
  if (points.length === 0) return [];
  const at = (index: number): Vec3 => points[index] ?? [0, 0, 0];
  const axis = (k: 0 | 1 | 2): number => maxOf(points.map((p) => p[k])) - minOf(points.map((p) => p[k]));
  const diagonal = Math.hypot(axis(0), axis(1), axis(2));
  const eps = tolerance * diagonal;
  const all = points.map((_, index) => index);
  // a flat cloud is hulled in its plane with flatEps = eps / sqrt 2 when its signed off-plane spread is at most flatEps too: the nearest point
  // of the projected hull lifts to a point of the 3D hull whose height differs from the sample's by at most the spread, so the distance is at
  // most sqrt(flatEps^2 + spread^2) <= eps. On a line the perpendicular offsets lie in a disc of radius eps / 2 (their differences <= eps).
  const flatEps = eps / Math.SQRT2;
  const seed = seedOf(at, all, { point: flatEps, line: eps / 2, plane: flatEps });
  if ('seed' in seed) return pruned(at, spatialHull(at, all, seed.seed, eps), 1e-9 * diagonal);
  if (seed.flat.length === 1) return [...seed.flat];
  if (seed.flat.length === 2) {
    const along = (index: number): number => dot(at(index), seed.u);
    return [farthest(all, (index) => -along(index)), farthest(all, along)].sort((p, q) => p - q);
  }
  const spanning = (k: number): number => seed.flat[k] ?? 0;
  const [i0, i1, i2] = [spanning(0), spanning(1), spanning(2)];
  const frame: [Vec3, Vec3, Vec3] = [at(i0), seed.u, cross(seed.normal, seed.u)];
  return [...new Set(planarHull(points, [i0, i1, i2], frame, flatEps, diagonal))].sort((p, q) => p - q);
}

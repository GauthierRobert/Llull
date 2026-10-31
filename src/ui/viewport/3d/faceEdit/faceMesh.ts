// Picking on the display triangles of a solid (04 DIR M1): the triangle under a ray, and the coplanar patch of triangles around it (the "face"
// the user sees). The B-rep face itself is named to the command by a point on it (`faceNear`), so no kernel is needed here. Pure, world space.

import type { Vec3 } from '@core/model/types';
import type { Triangle } from '@core/geometry/triangles';
import { cross3, dot3, len3, normalize3, scale3, sub3, add3 } from '@lib/vec3';

export interface PickRay {
  readonly origin: Vec3;
  /** Unit length. */
  readonly direction: Vec3;
}

export interface TriangleHit {
  readonly index: number;
  readonly distance: number;
  readonly point: Vec3;
}

/** Triangle normal from its winding, or null for a degenerate (zero area) triangle. */
function triangleNormal(triangle: Triangle): Vec3 | null {
  const n = cross3(sub3(triangle[1], triangle[0]), sub3(triangle[2], triangle[0]));
  return len3(n) < 1e-18 ? null : normalize3(n);
}

/** Nearest triangle hit by `ray` (Moller-Trumbore, both sides), or null. */
export function raycastTriangles(triangles: readonly Triangle[], ray: PickRay): TriangleHit | null {
  let best: TriangleHit | null = null;
  for (let index = 0; index < triangles.length; index++) {
    const [a, b, c] = triangles[index] as Triangle;
    const edge1 = sub3(b, a);
    const edge2 = sub3(c, a);
    const p = cross3(ray.direction, edge2);
    const determinant = dot3(edge1, p);
    if (Math.abs(determinant) < 1e-18) continue;
    const toOrigin = sub3(ray.origin, a);
    const u = dot3(toOrigin, p) / determinant;
    if (u < 0 || u > 1) continue;
    const q = cross3(toOrigin, edge1);
    const v = dot3(ray.direction, q) / determinant;
    if (v < 0 || u + v > 1) continue;
    const distance = dot3(edge2, q) / determinant;
    if (distance <= 0 || (best !== null && distance >= best.distance)) continue;
    best = { index, distance, point: add3(ray.origin, scale3(ray.direction, distance)) };
  }
  return best;
}

const keyOf = (p: Vec3): string => `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)},${Math.round(p[2] * 1e5)}`;

/** Triangles sharing an edge (matching quantised vertices) with each triangle. */
export function triangleAdjacency(triangles: readonly Triangle[]): number[][] {
  const owners = new Map<string, number[]>();
  triangles.forEach((triangle, index) => {
    for (let k = 0; k < 3; k++) {
      const [a, b] = [keyOf(triangle[k] as Vec3), keyOf(triangle[(k + 1) % 3] as Vec3)];
      const edge = a < b ? `${a}|${b}` : `${b}|${a}`;
      const list = owners.get(edge);
      if (list === undefined) owners.set(edge, [index]);
      else list.push(index);
    }
  });
  const neighbours: number[][] = triangles.map(() => []);
  for (const list of owners.values()) for (const i of list) for (const j of list) if (i !== j) (neighbours[i] as number[]).push(j);
  return neighbours;
}

/** The planar patch: triangles connected to the start one, on its plane within `tolerance` (distance) and `cosine` (normal agreement). */
export function planarRegion(
  triangles: readonly Triangle[],
  adjacency: readonly (readonly number[])[],
  start: number,
  tolerance = 1e-4,
  cosine = 0.99998,
): number[] {
  const first = triangles[start];
  const normal = first === undefined ? null : triangleNormal(first);
  if (first === undefined || normal === null) return [start];
  const onPlane = (index: number): boolean => {
    const triangle = triangles[index] as Triangle;
    const n = triangleNormal(triangle);
    if (n === null || Math.abs(dot3(n, normal)) < cosine) return false;
    return triangle.every((p) => Math.abs(dot3(sub3(p, first[0]), normal)) <= tolerance);
  };
  const seen = new Set<number>([start]);
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    for (const next of adjacency[queue[head] as number] ?? []) {
      if (seen.has(next) || !onPlane(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return queue;
}

/** Angle in degrees between the unit normals of two triangles (0 when either is degenerate). */
function turnBetween(a: Triangle, b: Triangle): number {
  const [na, nb] = [triangleNormal(a), triangleNormal(b)];
  return na === null || nb === null ? 0 : (Math.acos(Math.max(-1, Math.min(1, dot3(na, nb)))) * 180) / Math.PI;
}

/** Widest turn between neighbouring facets that still reads as one curved face (a tessellated bore has 5 to 20 degrees per facet). */
const MAX_FACET_TURN_DEG = 40;
const MIN_FACET_TURN_DEG = 0.5;
const TURN_TOLERANCE = 0.25;
const MAX_STRIP_PATCHES = 4096;

/**
 * The facet strip of a curved face, the heuristic used only when the kernel cannot label the triangles. A facet (a coplanar patch of at most two triangles)
 * joins a strip when its neighbours turn by the SAME small angle on both sides (a regular tessellation of a cylinder, cone or sphere); the strip grows into
 * patches of at most two triangles that continue that turn. A flat face, a face next to a tangent fillet (turns of half and a whole step) and a 90 degree
 * corner therefore stay as they are.
 */
export function facetStripRegion(triangles: readonly Triangle[], adjacency: readonly (readonly number[])[], start: number): number[] {
  const patchOf = (index: number): number[] => planarRegion(triangles, adjacency, index);
  const neighbourPatches = (patch: readonly number[]): number[][] => {
    const inside = new Set(patch);
    const seen = new Set<number>();
    const found: number[][] = [];
    for (const t of patch)
      for (const next of adjacency[t] ?? []) {
        if (inside.has(next) || seen.has(next)) continue;
        const neighbour = patchOf(next);
        neighbour.forEach((n) => seen.add(n));
        found.push(neighbour);
      }
    return found;
  };
  const turnOf = (from: readonly number[], to: readonly number[]): number =>
    turnBetween(triangles[from[0] as number] as Triangle, triangles[to[0] as number] as Triangle);
  const first = patchOf(start);
  if (first.length > 2) return first;
  const smooth = neighbourPatches(first)
    .map((patch) => ({ patch, turn: turnOf(first, patch) }))
    .filter(({ turn }) => turn >= MIN_FACET_TURN_DEG && turn <= MAX_FACET_TURN_DEG);
  const widest = Math.max(0, ...smooth.map(({ turn }) => turn));
  const sides = smooth.filter(({ turn }) => Math.abs(turn - widest) <= TURN_TOLERANCE * widest);
  if (sides.length < 2) return first;
  const region = new Set(first);
  const accepted = new Set<number>([Math.min(...first)]);
  const queue = [first];
  for (let head = 0; head < queue.length && queue.length < MAX_STRIP_PATCHES; head++) {
    const current = queue[head] as number[];
    for (const neighbour of neighbourPatches(current)) {
      const turn = turnOf(current, neighbour);
      const lead = Math.min(...neighbour);
      if (neighbour.length > 2 || accepted.has(lead) || turn < MIN_FACET_TURN_DEG || Math.abs(turn - widest) > TURN_TOLERANCE * widest)
        continue;
      accepted.add(lead);
      neighbour.forEach((n) => region.add(n));
      queue.push(neighbour);
    }
  }
  return [...region];
}

/** Normal of `triangle` turned to face the viewer looking along `ray` (a picked surface is seen from outside, so this is the outward normal). */
export function viewerFacingNormal(triangle: Triangle, ray: PickRay): Vec3 | null {
  const n = triangleNormal(triangle);
  if (n === null) return null;
  return dot3(n, ray.direction) > 0 ? scale3(n, -1) : n;
}

/** Offsets `dot(normal, p)` of the distinct planes parallel to `normal` (either orientation) among `triangles`, ascending, merged within `tolerance`. */
export function parallelPlaneOffsets(triangles: readonly Triangle[], normal: Vec3, tolerance = 1e-6): number[] {
  const offsets: number[] = [];
  for (const triangle of triangles) {
    const n = triangleNormal(triangle);
    if (n === null || Math.abs(dot3(n, normal)) < 1 - 1e-6) continue;
    offsets.push(dot3(triangle[0], normal));
  }
  offsets.sort((a, b) => a - b);
  return offsets.filter((value, i) => i === 0 || value - (offsets[i - 1] as number) > tolerance);
}

/** Smallest distance along `axis` from the lowest point of `triangles` to `point`: the lever of a draft about the neutral plane at the bottom. */
export function heightAbove(triangles: readonly Triangle[], axis: Vec3, point: Vec3): number {
  let lowest = Infinity;
  for (const triangle of triangles) for (const p of triangle) lowest = Math.min(lowest, dot3(p, axis));
  return lowest === Infinity ? 0 : dot3(point, axis) - lowest;
}

/** Diagonal of the bounding box of the triangles (0 when empty): the scale of drag steps and handles. */
export function diagonalOf(triangles: readonly Triangle[]): number {
  const min = new Float64Array(3).fill(Infinity);
  const max = new Float64Array(3).fill(-Infinity);
  for (const triangle of triangles)
    for (const p of triangle)
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k] as number, p[k] as number);
        max[k] = Math.max(max[k] as number, p[k] as number);
      }
  return triangles.length === 0 ? 0 : Math.hypot(...Array.from(max, (m, k) => m - (min[k] as number)));
}

/** Flat xyz list of the triangles at `indices` (a highlight fill). */
export function regionPositions(triangles: readonly Triangle[], indices: readonly number[]): number[] {
  const out: number[] = [];
  for (const index of indices) for (const p of triangles[index] ?? []) out.push(p[0], p[1], p[2]);
  return out;
}

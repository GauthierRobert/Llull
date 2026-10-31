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

/**
 * The smooth patch of a curved face: triangles connected to the start one through edges across which the normal turns by less than `cosine` (default
 * about 36 degrees, so a tessellated bore or boss is one patch while a 90 degree corner stops it).
 */
export function smoothRegion(
  triangles: readonly Triangle[],
  adjacency: readonly (readonly number[])[],
  start: number,
  cosine = 0.8,
): number[] {
  const normals = triangles.map(triangleNormal);
  const seen = new Set<number>([start]);
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const here = normals[queue[head] as number];
    if (here === null || here === undefined) continue;
    for (const next of adjacency[queue[head] as number] ?? []) {
      const there = normals[next];
      if (seen.has(next) || there === null || there === undefined || dot3(here, there) < cosine) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return queue;
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

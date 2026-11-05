/**
 * Ray casting through a tetrahedral mesh for the through-thickness adequacy measure (adequacy.ts). Typed-array layout: the corner node
 * indices of every tetrahedron in one Int32Array (`nodes[4 * tet + corner]`, dense indices into `xyz`), node coordinates in one Float64Array;
 * face adjacency by an open-addressing table keyed on the sorted node triple (no strings, no per-face objects).
 */

import type { Vec3 } from '@core/model/vectors';

export type Corner = 0 | 1 | 2 | 3;
export const CORNERS: readonly Corner[] = [0, 1, 2, 3];
/** Faces of a tetrahedron by the corner each one is opposite to. */
const FACE_OF: Readonly<Record<Corner, readonly [Corner, Corner, Corner]>> = { 0: [1, 2, 3], 1: [0, 2, 3], 2: [0, 1, 3], 3: [0, 1, 2] };
/** A direction counts as leaving a tetrahedron face only when its cosine with the outward normal exceeds this. */
const EXIT_COSINE = 1e-9;

type Corners = readonly [Vec3, Vec3, Vec3, Vec3];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** The four corner positions of tetrahedron `tet`. */
function cornersOf(xyz: Float64Array, nodes: Int32Array, tet: number): Corners {
  const at = (corner: number): Vec3 => {
    const node = (nodes[4 * tet + corner] as number) * 3;
    return [xyz[node] as number, xyz[node + 1] as number, xyz[node + 2] as number];
  };
  return [at(0), at(1), at(2), at(3)];
}

/** Absolute volume of a tetrahedron. */
function volumeOf(corners: Corners): number {
  const [a, b, c, d] = corners;
  return Math.abs(dot(sub(b, a), cross(sub(c, a), sub(d, a)))) / 6;
}

/** Unit outward normal of the face of a tetrahedron opposite `opposite`, and one of its vertices; null for a zero-area face. */
function outwardFace(corners: Corners, opposite: Corner): { readonly normal: Vec3; readonly vertex: Vec3 } | null {
  const [a, b, c] = FACE_OF[opposite];
  const [pa, pb, pc] = [corners[a], corners[b], corners[c]];
  const raw = cross(sub(pb, pa), sub(pc, pa));
  const length = Math.hypot(raw[0], raw[1], raw[2]);
  if (!(length > 0) || !Number.isFinite(length)) return null;
  const sign = dot(raw, sub(corners[opposite], pa)) > 0 ? -1 : 1;
  return { normal: [(sign * raw[0]) / length, (sign * raw[1]) / length, (sign * raw[2]) / length], vertex: pa };
}

/** Sorted node triple of the face of `tet` opposite `corner`, written to `out`. */
function sortedFace(nodes: Int32Array, tet: number, corner: Corner, out: Int32Array): void {
  const [i, j, k] = FACE_OF[corner];
  let a = nodes[4 * tet + i] as number;
  let b = nodes[4 * tet + j] as number;
  let c = nodes[4 * tet + k] as number;
  if (a > b) [a, b] = [b, a];
  if (b > c) [b, c] = [c, b];
  if (a > b) [a, b] = [b, a];
  out[0] = a;
  out[1] = b;
  out[2] = c;
}

/** Deterministic pseudo-random order of a face (hash of its sorted node indices): samples spread over a part without aliasing the mesh pattern. */
export function faceHash(nodes: Int32Array, tet: number, corner: Corner): number {
  const key = new Int32Array(3);
  sortedFace(nodes, tet, corner, key);
  return (Math.imul(key[0] as number, 73856093) ^ Math.imul(key[1] as number, 19349663) ^ Math.imul(key[2] as number, 83492791)) >>> 0;
}

/**
 * `neighbours[4 * tet + corner]` is the tetrahedron across the face opposite `corner`, -1 on the boundary. Faces shared by more than two
 * tetrahedra (overlapping elements) keep the first pairing.
 */
export function buildAdjacency(nodes: Int32Array): Int32Array {
  const count = nodes.length / 4;
  const neighbours = new Int32Array(nodes.length).fill(-1);
  let size = 16;
  while (size < nodes.length * 2) size *= 2;
  const mask = size - 1;
  const table = new Int32Array(size).fill(-1);
  const mine = new Int32Array(3);
  const theirs = new Int32Array(3);
  for (let tet = 0; tet < count; tet += 1)
    for (const corner of CORNERS) {
      sortedFace(nodes, tet, corner, mine);
      let slot =
        (Math.imul(mine[0] as number, 73856093) ^ Math.imul(mine[1] as number, 19349663) ^ Math.imul(mine[2] as number, 83492791)) & mask;
      const face = tet * 4 + corner;
      for (;;) {
        const other = table[slot] as number;
        if (other === -1) {
          table[slot] = face;
          break;
        }
        sortedFace(nodes, Math.floor(other / 4), (other % 4) as Corner, theirs);
        if (theirs[0] === mine[0] && theirs[1] === mine[1] && theirs[2] === mine[2]) {
          if (neighbours[other] === -1) {
            neighbours[other] = tet;
            neighbours[face] = Math.floor(other / 4);
          }
          break;
        }
        slot = (slot + 1) & mask;
      }
    }
  return neighbours;
}

/** Area and centroid of the face of `tet` opposite `corner`. */
export function faceGeometry(
  xyz: Float64Array,
  nodes: Int32Array,
  tet: number,
  corner: Corner,
): { readonly area: number; readonly centroid: Vec3 } {
  const corners = cornersOf(xyz, nodes, tet);
  const [a, b, c] = FACE_OF[corner].map((vertex) => corners[vertex]) as [Vec3, Vec3, Vec3];
  const raw = cross(sub(b, a), sub(c, a));
  return {
    area: Math.hypot(raw[0], raw[1], raw[2]) / 2,
    centroid: [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3],
  };
}

export interface Ray {
  /** Element layers: hit distance over the local element size. */
  readonly layers: number;
  readonly tets: number;
}

/**
 * The ray from the centroid of a boundary face along the inward normal until it leaves the part: its hit distance t over the local element size
 * h = (6 x mean volume of the crossed tets)^(1/3) (a Kuhn cell of side s holds 6 tets of volume s^3 / 6, so h = s exactly); null for a degenerate
 * face or a ray that crosses nothing measurable. A ray stops where it makes no progress (a degenerate tet, overlapping tets whose faces point at
 * each other, or a ray through a node / edge whose exit face leads to a tet it does not enter), so it always terminates and never reads thicker
 * than the wall it crossed.
 */
export function castRay(xyz: Float64Array, nodes: Int32Array, neighbours: Int32Array, start: number, corner: Corner): Ray | null {
  const first = cornersOf(xyz, nodes, start);
  const face = outwardFace(first, corner);
  if (face === null) return null;
  const origin = faceGeometry(xyz, nodes, start, corner).centroid;
  const direction: Vec3 = [-face.normal[0], -face.normal[1], -face.normal[2]];
  let current = start;
  let crossed = 0;
  let volume = 0;
  let travelled = 0;
  for (;;) {
    const corners = cornersOf(xyz, nodes, current);
    let exitCorner: Corner | null = null;
    let exitAt = Infinity;
    for (const opposite of CORNERS) {
      const candidate = outwardFace(corners, opposite);
      if (candidate === null) continue;
      const cosine = dot(direction, candidate.normal);
      if (cosine <= EXIT_COSINE) continue;
      const at = dot(sub(candidate.vertex, origin), candidate.normal) / cosine;
      if (at < exitAt) {
        exitAt = at;
        exitCorner = opposite;
      }
    }
    if (exitCorner === null || !(exitAt > travelled)) break;
    crossed += 1;
    volume += volumeOf(corners);
    travelled = exitAt;
    const next = neighbours[current * 4 + exitCorner] as number;
    if (next < 0) break;
    current = next;
  }
  const size = Math.cbrt((6 * volume) / Math.max(crossed, 1));
  return crossed > 0 && size > 0 ? { layers: travelled / size, tets: crossed } : null;
}

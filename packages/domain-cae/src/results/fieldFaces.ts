/**
 * The faces a result plot draws: the outer skin of the (selected) tet parts, clipped by an optional cut plane, plus the section face of every
 * tetrahedron the plane crosses, so an interior peak shows on the cut. Every vertex carries the undeformed position (where the cut is made),
 * the plotted (deformed) position and the nodal value, all interpolated linearly along the clipped edges.
 */

import type { FeMeshArtifact } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';
import { meshSkinOwned } from './fieldSurface';

export interface FieldVertex {
  readonly u: Vec3;
  readonly p: Vec3;
  readonly v: number;
}

export interface FieldFace {
  readonly corners: readonly [FieldVertex, FieldVertex, FieldVertex];
  readonly entityId: string;
  /** True for a section face of the cut (its normal points along the cut normal, toward the removed side). */
  readonly cap: boolean;
}

/** Removes the half-space `dot(normal, u) > offset` of the undeformed mesh. `normal` has unit length. */
export interface CutPlane {
  readonly normal: Vec3;
  readonly offset: number;
}

export interface FaceInput {
  readonly mesh: FeMeshArtifact;
  readonly coordinates: ReadonlyMap<number, Vec3>;
  /** Parts to plot (null: all). */
  readonly entityIds: ReadonlySet<string> | null;
  readonly cut: CutPlane | null;
  /** Plotted (deformed) position of a node. */
  readonly position: (node: number) => Vec3 | undefined;
  readonly value: (node: number) => number | undefined;
}

/** Corner quadruples (0-based indices of the C3D10 node list) of the 8 linear tets a quadratic tet splits into. */
const QUADRATIC_SUBTETS: readonly (readonly [number, number, number, number])[] = [
  [0, 4, 6, 7],
  [4, 1, 5, 8],
  [6, 5, 2, 9],
  [7, 8, 9, 3],
  [4, 9, 5, 6],
  [4, 9, 6, 7],
  [4, 9, 7, 8],
  [4, 9, 8, 5],
];

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const mix = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];
const between = (a: FieldVertex, b: FieldVertex, t: number): FieldVertex => ({
  u: mix(a.u, b.u, t),
  p: mix(a.p, b.p, t),
  v: a.v + t * (b.v - a.v),
});

/** Sutherland-Hodgman clip of a polygon to `distance <= 0`. */
function clipKept(polygon: readonly FieldVertex[], distance: (vertex: FieldVertex) => number): FieldVertex[] {
  const out: FieldVertex[] = [];
  polygon.forEach((current, index) => {
    const previous = polygon[(index + polygon.length - 1) % polygon.length];
    if (previous === undefined) return;
    const [dc, dp] = [distance(current), distance(previous)];
    if (dc <= 0) {
      if (dp > 0) out.push(between(previous, current, dp / (dp - dc)));
      out.push(current);
    } else if (dp <= 0) out.push(between(current, previous, dc / (dc - dp)));
  });
  return out;
}

/** The fan triangles of a convex polygon. */
function fan(polygon: readonly FieldVertex[]): (readonly [FieldVertex, FieldVertex, FieldVertex])[] {
  const [first] = polygon;
  if (first === undefined) return [];
  const out: (readonly [FieldVertex, FieldVertex, FieldVertex])[] = [];
  for (let index = 1; index + 1 < polygon.length; index += 1) {
    const [b, c] = [polygon[index], polygon[index + 1]];
    if (b !== undefined && c !== undefined) out.push([first, b, c]);
  }
  return out;
}

/** The plane section of a linear tet as a polygon (3 or 4 vertices), or null when the plane misses it. */
function sectionOf(tet: readonly FieldVertex[], cut: CutPlane, snap: number): FieldVertex[] | null {
  const distance = tet.map((vertex) => snapped(dot(cut.normal, vertex.u) - cut.offset, snap));
  const removed = [0, 1, 2, 3].filter((index) => (distance[index] ?? 0) > 0);
  const kept = [0, 1, 2, 3].filter((index) => (distance[index] ?? 0) <= 0);
  if (removed.length === 0 || kept.length === 0) return null;
  const crossing = (i: number, j: number): FieldVertex | undefined => {
    const [a, b, di, dj] = [tet[i], tet[j], distance[i], distance[j]];
    if (a === undefined || b === undefined || di === undefined || dj === undefined) return undefined;
    return between(a, b, di / (di - dj));
  };
  const [r0 = 0, r1 = 0] = removed;
  const [k0 = 0, k1 = 0] = kept;
  const order: [number, number][] =
    removed.length === 1
      ? kept.map((k): [number, number] => [r0, k])
      : kept.length === 1
        ? removed.map((r): [number, number] => [r, k0])
        : [
            [r0, k0],
            [r0, k1],
            [r1, k1],
            [r1, k0],
          ];
  const polygon = order.map(([i, j]) => crossing(i, j)).filter((vertex) => vertex !== undefined);
  return polygon.length === order.length ? polygon : null;
}

/** A distance within `snap` of the plane is exactly on it, so every tet sharing a node on the plane classifies that node the same way. */
const snapped = (distance: number, snap: number): number => (Math.abs(distance) <= snap ? 0 : distance);

/** Area vector of a polygon (Newell): robust when its first corners coincide or are collinear, unlike the cross product of two edges. */
const areaVectorOfU = (polygon: readonly FieldVertex[]): Vec3 => {
  const sum: [number, number, number] = [0, 0, 0];
  polygon.forEach((current, index) => {
    const next = polygon[(index + 1) % polygon.length] ?? current;
    sum[0] += (current.u[1] - next.u[1]) * (current.u[2] + next.u[2]);
    sum[1] += (current.u[2] - next.u[2]) * (current.u[0] + next.u[0]);
    sum[2] += (current.u[0] - next.u[0]) * (current.u[1] + next.u[1]);
  });
  return sum;
};

/** Diagonal of the bounding box of the node coordinates (0 for no node). */
function modelSize(coordinates: ReadonlyMap<number, Vec3>): number {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (const at of coordinates.values())
    for (const axis of [0, 1, 2] as const) {
      low[axis] = Math.min(low[axis] ?? Infinity, at[axis]);
      high[axis] = Math.max(high[axis] ?? -Infinity, at[axis]);
    }
  return coordinates.size === 0
    ? 0
    : Math.hypot((high[0] ?? 0) - (low[0] ?? 0), (high[1] ?? 0) - (low[1] ?? 0), (high[2] ?? 0) - (low[2] ?? 0));
}

/**
 * Faces to draw: skin triangles of the selected parts (kept side of the cut), and, with a cut, one section face per crossed tet.
 * @invariant skin triangles keep their outward winding, section faces wind along the cut normal; triangles with a node lacking a position
 *   or value are dropped
 */
export function fieldFaces(input: FaceInput): FieldFace[] {
  const { mesh, coordinates, cut } = input;
  const blocks = input.entityIds === null ? mesh.blocks : mesh.blocks.filter((block) => input.entityIds?.has(block.entityId));
  const selected: FeMeshArtifact = { ...mesh, blocks };
  const vertices = new Map<number, FieldVertex | null>();
  const vertexOf = (node: number): FieldVertex | null => {
    const known = vertices.get(node);
    if (known !== undefined) return known;
    const [u, p, v] = [coordinates.get(node), input.position(node), input.value(node)];
    const made = u === undefined || p === undefined || v === undefined ? null : { u, p, v };
    vertices.set(node, made);
    return made;
  };
  const faces: FieldFace[] = [];
  const snap = 1e-7 * modelSize(coordinates);
  const minArea = 1e-12 * modelSize(coordinates) ** 2;
  const distance = (vertex: FieldVertex): number => (cut === null ? 0 : snapped(dot(cut.normal, vertex.u) - cut.offset, snap));
  for (const { nodes, entityId } of meshSkinOwned(selected, coordinates)) {
    const corners = nodes.map(vertexOf);
    if (corners.some((vertex) => vertex === null)) continue;
    const polygon = cut === null ? (corners as FieldVertex[]) : clipKept(corners as FieldVertex[], distance);
    for (const corner of fan(polygon)) faces.push({ corners: corner, entityId, cap: false });
  }
  if (cut === null) return faces;
  for (const block of blocks) {
    if (block.type !== 'C3D4' && block.type !== 'C3D10') continue;
    const subTets = block.type === 'C3D10' ? QUADRATIC_SUBTETS : [[0, 1, 2, 3] as const];
    for (const element of block.elements) {
      const nodes = element.slice(1);
      const complete = block.type === 'C3D4' || nodes.length >= 10;
      for (const quad of complete ? subTets : [[0, 1, 2, 3] as const]) {
        const tet = quad.map((index) => vertexOf(nodes[index] ?? -1));
        if (tet.some((vertex) => vertex === null)) continue;
        const polygon = sectionOf(tet as FieldVertex[], cut, snap);
        if (polygon === null) continue;
        const area = areaVectorOfU(polygon);
        const along = dot(area, cut.normal);
        if (!(Math.abs(along) > minArea)) continue;
        for (const corner of fan(along < 0 ? [...polygon].reverse() : polygon))
          faces.push({ corners: corner, entityId: block.entityId, cap: true });
      }
    }
  }
  return faces;
}

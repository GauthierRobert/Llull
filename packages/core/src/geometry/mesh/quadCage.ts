/**
 * Helpers for quad meshes from quad remeshing (07 MSH M6): winding per shell, vertex valence, hard edges as cage creases, triangulation. Pure; a quad is
 * four vertex indices, counter-clockwise seen from outside.
 */

import type { MeshData } from '../../model/types';
import { SurfaceIndex } from './surfaceIndex';
import type { Vec3 } from '../../model/vectors';

const at = (positions: ReadonlyArray<number>, index: number): Vec3 => [
  positions[3 * index] as number,
  positions[3 * index + 1] as number,
  positions[3 * index + 2] as number,
];

const quadAt = (quads: ReadonlyArray<number>, face: number): [number, number, number, number] => [
  quads[4 * face] as number,
  quads[4 * face + 1] as number,
  quads[4 * face + 2] as number,
  quads[4 * face + 3] as number,
];

/** Connected components of the quads (quads sharing a vertex): the component index of every quad. */
function shellOfQuads(quads: ReadonlyArray<number>, vertexCount: number): { shell: number[]; count: number } {
  const parent = Array.from({ length: vertexCount }, (_, i) => i);
  const find = (v: number): number => {
    let root = v;
    while (parent[root] !== root) root = parent[root] as number;
    let w = v;
    while (parent[w] !== root) [w, parent[w]] = [parent[w] as number, root];
    return root;
  };
  for (let f = 0; f < quads.length / 4; f++) {
    const [a, b, c, d] = quadAt(quads, f);
    for (const v of [b, c, d]) parent[find(v)] = find(a);
  }
  const ids = new Map<number, number>();
  const shell = Array.from({ length: quads.length / 4 }, (_, f) => {
    const root = find(quads[4 * f] as number);
    if (!ids.has(root)) ids.set(root, ids.size);
    return ids.get(root) as number;
  });
  return { shell, count: ids.size };
}

/** The quads wound so that every connected shell encloses a positive volume (a shell that is inside out is reversed on its own). */
export function outwardQuads(positions: ReadonlyArray<number>, quads: ReadonlyArray<number>): number[] {
  const { shell, count } = shellOfQuads(quads, positions.length / 3);
  const volume = new Array<number>(count).fill(0);
  for (let f = 0; f < quads.length / 4; f++) {
    const [a, b, c, d] = quadAt(quads, f);
    for (const [i, j, k] of [
      [a, b, c],
      [a, c, d],
    ] as const) {
      const [p, q, r] = [at(positions, i), at(positions, j), at(positions, k)];
      const s = shell[f] as number;
      volume[s] =
        (volume[s] as number) +
        (p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0])) / 6;
    }
  }
  const out: number[] = [];
  for (let f = 0; f < quads.length / 4; f++) {
    const [a, b, c, d] = quadAt(quads, f);
    if ((volume[shell[f] as number] as number) >= 0) out.push(a, b, c, d);
    else out.push(a, d, c, b);
  }
  return out;
}

/** Number of vertices per valence (faces around the vertex), keyed by the valence in ascending order. */
export function quadValence(quads: ReadonlyArray<number>, vertexCount: number): Record<string, number> {
  const around = new Array<number>(vertexCount).fill(0);
  for (const v of quads) around[v] = (around[v] ?? 0) + 1;
  const histogram = new Map<number, number>();
  for (const valence of around) histogram.set(valence, (histogram.get(valence) ?? 0) + 1);
  return Object.fromEntries([...histogram.entries()].sort((a, b) => a[0] - b[0]).map(([valence, count]) => [String(valence), count]));
}

function faceNormal(positions: ReadonlyArray<number>, quads: ReadonlyArray<number>, face: number): Vec3 {
  const corners = quadAt(quads, face).map((i) => at(positions, i));
  let [x, y, z] = [0, 0, 0];
  for (const [i, p] of corners.entries()) {
    const q = corners[(i + 1) % 4] as Vec3;
    x += (p[1] - q[1]) * (p[2] + q[2]);
    y += (p[2] - q[2]) * (p[0] + q[0]);
    z += (p[0] - q[0]) * (p[1] + q[1]);
  }
  const length = Math.hypot(x, y, z);
  return length === 0 ? [0, 0, 0] : [x / length, y / length, z / length];
}

const sub = (p: Vec3, q: Vec3): Vec3 => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
const dot = (p: Vec3, q: Vec3): number => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const norm = (p: Vec3): number => Math.hypot(p[0], p[1], p[2]);

/** Cage edges whose two quads meet at more than `angleRad` (angle between the quad normals, Newell's method), as `[a, b]` with a < b. */
function turnedCageEdges(positions: ReadonlyArray<number>, quads: ReadonlyArray<number>, angleRad: number): Array<[number, number]> {
  const faces = new Map<string, number>();
  const turned: Array<[number, number]> = [];
  const cosine = Math.cos(angleRad);
  for (let f = 0; f < quads.length / 4; f++) {
    const corners = quadAt(quads, f);
    for (const [i, a] of corners.entries()) {
      const b = corners[(i + 1) % 4] as number;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const other = faces.get(key);
      if (other === undefined) {
        faces.set(key, f);
        continue;
      }
      if (dot(faceNormal(positions, quads, other), faceNormal(positions, quads, f)) < cosine) turned.push(a < b ? [a, b] : [b, a]);
    }
  }
  return turned;
}

type Segment = readonly [Vec3, Vec3];

/** The edges of the triangle mesh whose two triangles meet at more than `angleRad` (the hard edges of the source surface), as segments. */
function sharpSegments(source: MeshData, angleRad: number): Segment[] {
  const owner = new Map<string, number>();
  const segments: Segment[] = [];
  const cosine = Math.cos(angleRad);
  const triangleNormal = (t: number): Vec3 => {
    const [p, q, r] = [0, 1, 2].map((k) => at(source.positions, source.indices[3 * t + k] as number)) as [Vec3, Vec3, Vec3];
    const [u, v] = [sub(q, p), sub(r, p)];
    const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = norm(n);
    return length === 0 ? [0, 0, 0] : [n[0] / length, n[1] / length, n[2] / length];
  };
  for (let t = 0; t < source.indices.length / 3; t++) {
    for (let k = 0; k < 3; k++) {
      const [a, b] = [source.indices[3 * t + k] as number, source.indices[3 * t + ((k + 1) % 3)] as number];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const other = owner.get(key);
      if (other === undefined) {
        owner.set(key, t);
        continue;
      }
      if (dot(triangleNormal(other), triangleNormal(t)) < cosine) segments.push([at(source.positions, a), at(source.positions, b)]);
    }
  }
  return segments;
}

function distanceToSegment(point: Vec3, [a, b]: Segment): number {
  const [ab, ap] = [sub(b, a), sub(point, a)];
  const length2 = dot(ab, ab);
  const s = length2 === 0 ? 0 : Math.min(1, Math.max(0, dot(ap, ab) / length2));
  return Math.hypot(ap[0] - s * ab[0], ap[1] - s * ab[1], ap[2] - s * ab[2]);
}

/** A cage edge follows a hard edge when every sample along it lies within this fraction of its length (at most half a grid cell) of a parallel hard-edge segment. */
const FOLLOW_FRACTION = 0.25;
/** Cosine of the largest angle (20 degrees) between a cage edge and a hard-edge segment it follows. */
const PARALLEL_COSINE = Math.cos((20 * Math.PI) / 180);
/** Samples along a cage edge, ends included. */
const EDGE_SAMPLES = 5;

/** The grid cell is never smaller than this fraction of the source diagonal, so a tiny or broken cage cannot make a segment walk thousands of cells. */
const MIN_CELL_FRACTION = 1e-3;
/** Most cells one segment is sampled into (never reached once the cell has its floor: a segment is at most the diagonal long). */
const MAX_SEGMENT_STEPS = 4096;

function diagonalOf(positions: ReadonlyArray<number>): number {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    const axis = i % 3;
    low[axis] = Math.min(low[axis] as number, positions[i] as number);
    high[axis] = Math.max(high[axis] as number, positions[i] as number);
  }
  return positions.length === 0
    ? 0
    : Math.hypot(
        (high[0] as number) - (low[0] as number),
        (high[1] as number) - (low[1] as number),
        (high[2] as number) - (low[2] as number),
      );
}

/** Uniform grid over the hard-edge segments: a segment is listed in the cell of every point sampled along it every half cell; a query reads the 27 cells around a point. */
function segmentGrid(segments: ReadonlyArray<Segment>, cell: number): (point: Vec3) => Segment[] {
  const cells = new Map<string, Segment[]>();
  const key = (i: number, j: number, k: number): string => `${i},${j},${k}`;
  const cellOf = (p: Vec3): [number, number, number] => [Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell)];
  for (const segment of segments) {
    const [a, b] = segment;
    const steps = Math.min(MAX_SEGMENT_STEPS, Math.max(1, Math.ceil(norm(sub(b, a)) / (cell / 2))));
    for (let s = 0; s <= steps; s++) {
      const u = s / steps;
      const id = key(...cellOf([a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1]), a[2] + u * (b[2] - a[2])]));
      const list = cells.get(id);
      if (list === undefined) cells.set(id, [segment]);
      else if (list[list.length - 1] !== segment) list.push(segment);
    }
  }
  return (point) => {
    const [i, j, k] = cellOf(point);
    const found: Segment[] = [];
    for (let di = -1; di <= 1; di++)
      for (let dj = -1; dj <= 1; dj++)
        for (let dk = -1; dk <= 1; dk++) for (const segment of cells.get(key(i + di, j + dj, k + dk)) ?? []) found.push(segment);
    return found;
  };
}

/**
 * Cage edges that follow a hard edge of the `source` surface: the quad normals across the edge differ by more than `angleRad` AND every sample
 * along the edge (both ends, the midpoint, two more) lies on a source edge whose triangles meet at more than `angleRad` and that runs within 20 degrees
 * of the cage edge. A coarse quad cage of a smooth surface has turned edges but no hard ones; a cage edge crossing a hard edge is not one. Each sample is
 * matched on its own, so the source tessellation may be finer or coarser than the cage. The segments sit in a uniform grid (cell = median turned edge
 * length): linear time. Returned as `[a, b]` with a < b, ascending.
 */
export function hardEdgeCreases(
  positions: ReadonlyArray<number>,
  quads: ReadonlyArray<number>,
  source: MeshData,
  angleRad: number,
): Array<[number, number]> {
  const turned = turnedCageEdges(positions, quads, angleRad);
  if (turned.length === 0) return [];
  const segments = sharpSegments(source, angleRad);
  if (segments.length === 0) return [];
  const lengths = turned.map(([a, b]) => norm(sub(at(positions, a), at(positions, b)))).sort((p, q) => p - q);
  const cell = Math.max(lengths[Math.floor(lengths.length / 2)] as number, diagonalOf(source.positions) * MIN_CELL_FRACTION);
  const near = segmentGrid(segments, cell);
  const follows = (point: Vec3, direction: Vec3, length: number, tolerance: number): boolean =>
    near(point).some((segment) => {
      const along = sub(segment[1], segment[0]);
      const alongLength = norm(along);
      return (
        alongLength > 0 &&
        Math.abs(dot(along, direction)) >= PARALLEL_COSINE * alongLength * length &&
        distanceToSegment(point, segment) <= tolerance
      );
    });
  const creases = turned.filter(([a, b]) => {
    const [p, q] = [at(positions, a), at(positions, b)];
    const direction = sub(q, p);
    const length = norm(direction);
    const tolerance = Math.min(FOLLOW_FRACTION * length, cell / 2);
    return (
      length > 0 &&
      Array.from({ length: EDGE_SAMPLES }, (_, s) => s / (EDGE_SAMPLES - 1)).every((u) =>
        follows([p[0] + u * direction[0], p[1] + u * direction[1], p[2] + u * direction[2]], direction, length, tolerance),
      )
    );
  });
  return creases.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
}

/** Triangles (three indices each) of the quads, every quad split along its shorter diagonal. */
export function triangulateQuads(positions: ReadonlyArray<number>, quads: ReadonlyArray<number>): number[] {
  const triangles: number[] = [];
  const distance = (i: number, j: number): number => norm(sub(at(positions, i), at(positions, j)));
  for (let f = 0; f < quads.length / 4; f++) {
    const [a, b, c, d] = quadAt(quads, f);
    if (distance(a, c) <= distance(b, d)) triangles.push(a, b, c, a, c, d);
    else triangles.push(a, b, d, b, c, d);
  }
  return triangles;
}

/** The result box may stick out of the source box by this fraction of the source diagonal (a cage lies on the surface, so it sits inside the box). */
const RESULT_BOX_GROWTH = 0.05;
/** The result diagonal must be at least this fraction of the source diagonal (a smaller one is a collapsed result, not a coarse one). */
const RESULT_MIN_DIAGONAL = 0.1;
/** A result vertex may be at most this many median cage edge lengths from the source surface. */
const RESULT_MAX_OFFSET_EDGES = 1;

function boxOf(values: ReadonlyArray<number>): { low: number[]; high: number[]; diagonal: number } {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  values.forEach((v, i) => {
    low[i % 3] = Math.min(low[i % 3] as number, v);
    high[i % 3] = Math.max(high[i % 3] as number, v);
  });
  return { low, high, diagonal: values.length === 0 ? 0 : Math.hypot(...[0, 1, 2].map((k) => (high[k] as number) - (low[k] as number))) };
}

/**
 * Why the quad vertices `positions` cannot be a remesh of `source`, or null: the result box sticks out of the source box by more than
 * RESULT_BOX_GROWTH x the source diagonal on some side (one-sided: a valid coarse cage lies INSIDE the box, a 6-quad cube cage of a sphere about 12 % of
 * the diagonal inside on every side), or the result diagonal is under RESULT_MIN_DIAGONAL x the source diagonal (collapsed).
 */
export function resultBoxProblem(positions: ReadonlyArray<number>, source: MeshData): string | null {
  const [result, original] = [boxOf(positions), boxOf(source.positions)];
  const growth = Math.max(
    ...[0, 1, 2].flatMap((k) => [
      (original.low[k] as number) - (result.low[k] as number),
      (result.high[k] as number) - (original.high[k] as number),
    ]),
  );
  if (growth > RESULT_BOX_GROWTH * original.diagonal)
    return `the engine's quads stick out of the source's bounding box by ${growth.toPrecision(3)} (over ${RESULT_BOX_GROWTH * 100} % of the source diagonal ${original.diagonal.toPrecision(3)})`;
  if (result.diagonal < RESULT_MIN_DIAGONAL * original.diagonal)
    return `the engine's quads are collapsed: their bounding box diagonal is ${result.diagonal.toPrecision(3)}, under ${RESULT_MIN_DIAGONAL * 100} % of the source's ${original.diagonal.toPrecision(3)}`;
  return null;
}

/**
 * Why the quad vertices are not on the surface of `source`, or null: the distance of a result vertex to the source surface may not exceed
 * RESULT_MAX_OFFSET_EDGES x the longest quad edge next to it (an edge of an incident quad that does not touch it). A strongly graded cage
 * (adaptiveSize) has long edges on flat parts and short ones where the surface bends, so one global edge length would be wrong. Runs before the
 * crease search: one closest-point query per vertex on a bounding-box tree.
 */
export function offSourceProblem(positions: ReadonlyArray<number>, quads: ReadonlyArray<number>, source: MeshData): string | null {
  const longest = new Array<number>(positions.length / 3).fill(0);
  for (let f = 0; f < quads.length / 4; f++) {
    const corners = quadAt(quads, f);
    const edge = (k: number): number => norm(sub(at(positions, corners[k % 4] as number), at(positions, corners[(k + 1) % 4] as number)));
    // the two edges of the quad that do NOT touch the corner: its own edges grow with its offset (a vertex pulled to the middle of a sphere has edges as
    // long as its distance)
    corners.forEach((v, k) => {
      longest[v] = Math.max(longest[v] as number, edge(k + 1), edge(k + 2));
    });
  }
  const index = new SurfaceIndex(source.positions, source.indices);
  let worst = { distance: 0, edge: 0, excess: -Infinity };
  for (let v = 0; v < longest.length; v++) {
    const distance = index.closest(at(positions, v)).distance;
    const edge = longest[v] as number;
    if (distance - RESULT_MAX_OFFSET_EDGES * edge > worst.excess)
      worst = { distance, edge, excess: distance - RESULT_MAX_OFFSET_EDGES * edge };
  }
  return worst.excess <= 0
    ? null
    : `the engine's quads are not on the source: a vertex is ${worst.distance.toPrecision(3)} from its surface, over ${RESULT_MAX_OFFSET_EDGES} x the longest quad edge next to it (${worst.edge.toPrecision(3)})`;
}

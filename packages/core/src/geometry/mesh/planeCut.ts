/**
 * Plane cut of an indexed triangle mesh (07 MSH FR-MSH-16): exact clipping of every triangle against the plane, section loops chained from the
 * clipped edges, optional planar caps (outer loops, holes by containment) triangulated by the watertight cap triangulator.
 * @invariant works on open and non-manifold input; vertices within `epsilon` of the plane are snapped onto it
 * @invariant cap faces share the section vertices, so a closed input yields a closed output; cap normals point away from the kept side
 */

import type { MeshData } from '../../model/types';
import type { Vec3 } from '../../model/vectors';
import { triangulateCap } from './capTriangulate';

export interface CutResult {
  readonly mesh: MeshData;
  readonly loops: number;
  readonly capTriangles: number;
  readonly capArea: number;
  /** Section chains that did not close (open input) and holes with no enclosing loop: left uncapped. */
  readonly uncapped: number;
}

type Point2 = readonly [number, number];

const unit = (v: Vec3): Vec3 => {
  const length = Math.hypot(...v);
  return [v[0] / length, v[1] / length, v[2] / length];
};

function planeFrame(normal: Vec3): { u: Vec3; v: Vec3 } {
  const helper: Vec3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit([
    helper[1] * normal[2] - helper[2] * normal[1],
    helper[2] * normal[0] - helper[0] * normal[2],
    helper[0] * normal[1] - helper[1] * normal[0],
  ]);
  const v: Vec3 = [normal[1] * u[2] - normal[2] * u[1], normal[2] * u[0] - normal[0] * u[2], normal[0] * u[1] - normal[1] * u[0]];
  return { u, v };
}

const signedArea2 = (ring: ReadonlyArray<Point2>): number =>
  ring.reduce((s, p, k) => {
    const q = ring[(k + 1) % ring.length] as Point2;
    return s + (p[0] * q[1] - q[0] * p[1]) / 2;
  }, 0);

function inside2(point: Point2, ring: ReadonlyArray<Point2>): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [a, b] = [ring[i] as Point2, ring[j] as Point2];
    if (a[1] > point[1] !== b[1] > point[1] && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}

/** Directed section edges chained into closed loops; chains that do not close are counted. */
function chainLoops(edges: ReadonlyArray<readonly [number, number]>): { loops: number[][]; open: number } {
  const outgoing = new Map<number, number[]>();
  edges.forEach(([from], index) => outgoing.set(from, [...(outgoing.get(from) ?? []), index]));
  const used = new Uint8Array(edges.length);
  const loops: number[][] = [];
  let open = 0;
  for (let start = 0; start < edges.length; start++) {
    if (used[start] === 1) continue;
    const chain: number[] = [];
    let edge = start;
    let closed = false;
    for (;;) {
      used[edge] = 1;
      const [from, to] = edges[edge] as readonly [number, number];
      chain.push(from);
      if (to === (edges[start] as readonly [number, number])[0]) {
        closed = true;
        break;
      }
      const next = (outgoing.get(to) ?? []).find((candidate) => used[candidate] !== 1);
      if (next === undefined) break;
      edge = next;
    }
    if (closed) loops.push(chain);
    else open++;
  }
  return { loops, open };
}

/**
 * Keep the `side` (+1 positive / -1 negative) half of `mesh` cut by the plane (`origin`, unit `normal`).
 * @failure a plane that misses the mesh is the caller's check (`crossesPlane`)
 */
export function cutMeshByPlane(mesh: MeshData, origin: Vec3, normalInput: Vec3, side: 1 | -1, cap: boolean, epsilon: number): CutResult {
  const normal = unit(normalInput);
  const vertexCount = mesh.positions.length / 3;
  const point = (i: number): Vec3 => [
    mesh.positions[i * 3] as number,
    mesh.positions[i * 3 + 1] as number,
    mesh.positions[i * 3 + 2] as number,
  ];
  const distance = Array.from({ length: vertexCount }, (_, i) => {
    const p = point(i);
    const d = side * ((p[0] - origin[0]) * normal[0] + (p[1] - origin[1]) * normal[1] + (p[2] - origin[2]) * normal[2]);
    return Math.abs(d) <= epsilon ? 0 : d;
  });
  const positions: number[] = [];
  const remap = new Map<number, number>();
  const cuts = new Map<number, number>();
  const keepVertex = (i: number): number => {
    let mapped = remap.get(i);
    if (mapped === undefined) {
      mapped = positions.length / 3;
      const p = point(i);
      positions.push(p[0], p[1], p[2]);
      remap.set(i, mapped);
    }
    return mapped;
  };
  const cutVertex = (a: number, b: number): number => {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const key = lo * vertexCount + hi;
    let mapped = cuts.get(key);
    if (mapped === undefined) {
      const [da, db] = [distance[lo] as number, distance[hi] as number];
      const t = da / (da - db);
      const [pa, pb] = [point(lo), point(hi)];
      mapped = positions.length / 3;
      positions.push(pa[0] + t * (pb[0] - pa[0]), pa[1] + t * (pb[1] - pa[1]), pa[2] + t * (pb[2] - pa[2]));
      cuts.set(key, mapped);
    }
    return mapped;
  };
  const indices: number[] = [];
  const planeOf = new Set<number>();
  for (let f = 0; f + 2 < mesh.indices.length; f += 3) {
    const corner = [mesh.indices[f] as number, mesh.indices[f + 1] as number, mesh.indices[f + 2] as number] as [number, number, number];
    const d = corner.map((c) => distance[c] as number);
    if (d.every((x) => x === 0)) {
      const [pa, pb, pc] = corner.map(point) as [Vec3, Vec3, Vec3];
      const n: Vec3 = [
        (pb[1] - pa[1]) * (pc[2] - pa[2]) - (pb[2] - pa[2]) * (pc[1] - pa[1]),
        (pb[2] - pa[2]) * (pc[0] - pa[0]) - (pb[0] - pa[0]) * (pc[2] - pa[2]),
        (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]),
      ];
      if (side * (n[0] * normal[0] + n[1] * normal[1] + n[2] * normal[2]) < 0)
        indices.push(keepVertex(corner[0]), keepVertex(corner[1]), keepVertex(corner[2]));
      continue;
    }
    if (d.every((x) => x >= 0)) {
      indices.push(keepVertex(corner[0]), keepVertex(corner[1]), keepVertex(corner[2]));
      continue;
    }
    if (d.every((x) => x <= 0)) continue;
    const polygon: number[] = [];
    for (let k = 0; k < 3; k++) {
      const [cur, next] = [corner[k] as number, corner[(k + 1) % 3] as number];
      const [dc, dn] = [distance[cur] as number, distance[next] as number];
      if (dc >= 0) polygon.push(keepVertex(cur));
      if ((dc > 0 && dn < 0) || (dc < 0 && dn > 0)) polygon.push(cutVertex(cur, next));
    }
    for (let k = 1; k + 1 < polygon.length; k++) indices.push(polygon[0] as number, polygon[k] as number, polygon[k + 1] as number);
  }
  for (const [original, mapped] of remap) if (distance[original] === 0) planeOf.add(mapped);
  for (const mapped of cuts.values()) planeOf.add(mapped);
  if (!cap) return { mesh: { positions, indices }, loops: 0, capTriangles: 0, capArea: 0, uncapped: 0 };
  const uses = new Map<number, number>();
  const key = (a: number, b: number): number => Math.min(a, b) * 2_000_000_011 + Math.max(a, b);
  for (let f = 0; f < indices.length; f += 3)
    for (let k = 0; k < 3; k++) {
      const id = key(indices[f + k] as number, indices[f + ((k + 1) % 3)] as number);
      uses.set(id, (uses.get(id) ?? 0) + 1);
    }
  const sectionEdges: Array<readonly [number, number]> = [];
  for (let f = 0; f < indices.length; f += 3)
    for (let k = 0; k < 3; k++) {
      const [a, b] = [indices[f + k] as number, indices[f + ((k + 1) % 3)] as number];
      if (planeOf.has(a) && planeOf.has(b) && uses.get(key(a, b)) === 1) sectionEdges.push([a, b]);
    }
  const { loops, open } = chainLoops(sectionEdges);
  const { u, v } = planeFrame(normal);
  const flat = (i: number): Point2 => {
    const p = [positions[i * 3] as number, positions[i * 3 + 1] as number, positions[i * 3 + 2] as number] as const;
    return [
      (p[0] - origin[0]) * u[0] + (p[1] - origin[1]) * u[1] + (p[2] - origin[2]) * u[2],
      (p[0] - origin[0]) * v[0] + (p[1] - origin[1]) * v[1] + (p[2] - origin[2]) * v[2],
    ];
  };
  const rings = loops.map((loop) => loop.map(flat));
  const outers: number[] = [];
  const holes: number[] = [];
  rings.forEach((ring, k) => (signedArea2(ring) * side > 0 ? outers : holes).push(k));
  const holesOf = new Map<number, number[]>(outers.map((o) => [o, []]));
  let uncapped = open;
  for (const h of holes) {
    const owners = outers.filter((o) => inside2((rings[h] as Point2[])[0] as Point2, rings[o] as Point2[]));
    owners.sort((a, b) => Math.abs(signedArea2(rings[a] as Point2[])) - Math.abs(signedArea2(rings[b] as Point2[])));
    const owner = owners[0];
    if (owner === undefined) uncapped++;
    else holesOf.get(owner)?.push(h);
  }
  let capTriangles = 0;
  let capArea = 0;
  for (const outer of outers) {
    const ringIds = [outer, ...(holesOf.get(outer) ?? [])];
    const vertexIds = ringIds.flatMap((r) => loops[r] as number[]);
    const [outerRing, ...holeRings] = ringIds.map((r) => rings[r] as Point2[]) as [Point2[], ...Point2[][]];
    const triangulation = triangulateCap(outerRing, holeRings);
    if (!triangulation.complete) {
      uncapped++;
      continue;
    }
    for (const [i, j, k] of triangulation.triangles) {
      const ids = [i, j, k].map((t) => vertexIds[t] as number) as [number, number, number];
      // Triangulator output faces +normal; the cap faces away from the kept side (-side * normal).
      if (side === 1) indices.push(ids[0], ids[2], ids[1]);
      else indices.push(ids[0], ids[1], ids[2]);
      const [a, b, c] = ids.map(flat) as [Point2, Point2, Point2];
      capArea += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
      capTriangles++;
    }
  }
  return { mesh: { positions, indices }, loops: loops.length, capTriangles, capArea, uncapped };
}

/** True when the plane has mesh vertices strictly on both sides (beyond `epsilon`). */
export function crossesPlane(mesh: MeshData, origin: Vec3, normalInput: Vec3, epsilon: number): boolean {
  const normal = unit(normalInput);
  let above = false;
  let below = false;
  for (let i = 0; i + 2 < mesh.positions.length; i += 3) {
    const d =
      ((mesh.positions[i] as number) - origin[0]) * normal[0] +
      ((mesh.positions[i + 1] as number) - origin[1]) * normal[1] +
      ((mesh.positions[i + 2] as number) - origin[2]) * normal[2];
    if (d > epsilon) above = true;
    else if (d < -epsilon) below = true;
  }
  return above && below;
}

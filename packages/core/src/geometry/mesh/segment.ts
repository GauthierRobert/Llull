/**
 * Segmentation of a triangle mesh into smooth regions and the analytic primitive each one follows (07 MSH FR-MSH-20): faces joined across edges
 * whose dihedral angle is at most the feature angle form a region, every region is fitted (plane, cylinder, cone, sphere) or left freeform.
 * @invariant needs a manifold, consistently wound mesh; every non-degenerate face belongs to exactly one region; regions are numbered by their lowest face
 */

import type { MeshData } from '../../model/types';
import type { PrimitiveFit } from '../../model/meshProvenance';
import type { Vec3 } from '../../model/vectors';
import { fitDistance, fitRegion, type PrimitiveKind } from './primitiveFit';

export interface SegmentParams {
  readonly featureAngleRad: number;
  /** Largest distance of a region's vertices to its primitive (document units). */
  readonly fitTolerance: number;
  readonly kinds: ReadonlyArray<PrimitiveKind>;
}

interface SegmentGroup {
  readonly index: number;
  /** Faces of the region, ascending. */
  readonly faces: number[];
  readonly area: number;
  readonly fit: PrimitiveFit;
}

interface Adjacency {
  readonly a: number;
  readonly b: number;
  /** Mesh edges shared by the two regions and their summed length. */
  readonly edges: number;
  readonly length: number;
}

export interface Segmentation {
  readonly groups: SegmentGroup[];
  readonly adjacency: Adjacency[];
  /** Region of each face (-1: degenerate face, in no region). */
  readonly faceGroup: Int32Array;
  readonly unassignedFaces: number;
}

/** Vertices a fit uses at most: larger regions are thinned evenly for the fit and checked in full afterwards. */
const FIT_POINT_LIMIT = 20_000;

class UnionFind {
  private readonly parent: Int32Array;
  constructor(size: number) {
    this.parent = Int32Array.from({ length: size }, (_, i) => i);
  }
  find(x: number): number {
    let root = x;
    while ((this.parent[root] as number) !== root) root = this.parent[root] as number;
    let current = x;
    while (current !== root) {
      const next = this.parent[current] as number;
      this.parent[current] = root;
      current = next;
    }
    return root;
  }
  union(a: number, b: number): void {
    const [ra, rb] = [this.find(a), this.find(b)];
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

/** Faces sharing an edge, as [faceA, faceB, edge length] (manifold edges only). */
function faceNeighbours(mesh: MeshData): Array<[number, number, number]> {
  const faces = mesh.indices.length / 3;
  const vertexCount = mesh.positions.length / 3;
  const keys = new Float64Array(faces * 3);
  for (let f = 0; f < faces; f++) {
    for (let k = 0; k < 3; k++) {
      const [a, b] = [mesh.indices[f * 3 + k] as number, mesh.indices[f * 3 + ((k + 1) % 3)] as number];
      keys[f * 3 + k] = Math.min(a, b) * vertexCount + Math.max(a, b);
    }
  }
  const order = Int32Array.from({ length: keys.length }, (_, i) => i).sort((x, y) => (keys[x] as number) - (keys[y] as number) || x - y);
  const pairs: Array<[number, number, number]> = [];
  for (let i = 0; i + 1 < order.length; i++) {
    const [first, second] = [order[i] as number, order[i + 1] as number];
    if (keys[first] !== keys[second]) continue;
    if (i + 2 < order.length && keys[order[i + 2] as number] === keys[first]) continue;
    if (i > 0 && keys[order[i - 1] as number] === keys[first]) continue;
    const key = keys[first] as number;
    const [a, b] = [Math.floor(key / vertexCount), key % vertexCount];
    const length = Math.hypot(
      (mesh.positions[a * 3] as number) - (mesh.positions[b * 3] as number),
      (mesh.positions[a * 3 + 1] as number) - (mesh.positions[b * 3 + 1] as number),
      (mesh.positions[a * 3 + 2] as number) - (mesh.positions[b * 3 + 2] as number),
    );
    pairs.push([Math.floor(first / 3), Math.floor(second / 3), length]);
  }
  return pairs;
}

export function segmentMesh(mesh: MeshData, params: SegmentParams): Segmentation {
  const faces = mesh.indices.length / 3;
  const point = (v: number): Vec3 => [
    mesh.positions[v * 3] as number,
    mesh.positions[v * 3 + 1] as number,
    mesh.positions[v * 3 + 2] as number,
  ];
  const normals: Vec3[] = [];
  const areas: number[] = [];
  for (let f = 0; f < faces; f++) {
    const [a, b, c] = [
      point(mesh.indices[f * 3] as number),
      point(mesh.indices[f * 3 + 1] as number),
      point(mesh.indices[f * 3 + 2] as number),
    ];
    const [ux, uy, uz, vx, vy, vz] = [b[0] - a[0], b[1] - a[1], b[2] - a[2], c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n: Vec3 = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const length = Math.hypot(...n);
    normals.push(length > 0 ? [n[0] / length, n[1] / length, n[2] / length] : [0, 0, 0]);
    areas.push(length / 2);
  }
  const unions = new UnionFind(faces);
  const neighbours = faceNeighbours(mesh);
  const cosine = Math.cos(params.featureAngleRad);
  for (const [a, b] of neighbours) {
    const [na, nb] = [normals[a] as Vec3, normals[b] as Vec3];
    if ((areas[a] as number) > 0 && (areas[b] as number) > 0 && na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2] >= cosine) unions.union(a, b);
  }
  const faceGroup = new Int32Array(faces).fill(-1);
  const members: number[][] = [];
  const indexOfRoot = new Map<number, number>();
  for (let f = 0; f < faces; f++) {
    if ((areas[f] as number) <= 0) continue;
    const root = unions.find(f);
    let index = indexOfRoot.get(root);
    if (index === undefined) {
      index = members.length;
      indexOfRoot.set(root, index);
      members.push([]);
    }
    (members[index] as number[]).push(f);
    faceGroup[f] = index;
  }
  const groups: SegmentGroup[] = members.map((region, index) => {
    const used = new Set<number>();
    for (const f of region) for (let k = 0; k < 3; k++) used.add(mesh.indices[f * 3 + k] as number);
    const all = [...used].sort((x, y) => x - y).map(point);
    const stride = Math.max(1, Math.ceil(all.length / FIT_POINT_LIMIT));
    const thinned = all.filter((_, i) => i % stride === 0);
    const centres = region.map((f): Vec3 => {
      const [a, b, c] = [
        point(mesh.indices[f * 3] as number),
        point(mesh.indices[f * 3 + 1] as number),
        point(mesh.indices[f * 3 + 2] as number),
      ];
      return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    });
    const regionArea = region.reduce((sum, f) => sum + (areas[f] as number), 0);
    const edgeLength = Math.sqrt((4 * regionArea) / (Math.sqrt(3) * Math.max(region.length, 1)));
    let fit = fitRegion(
      {
        points: thinned,
        normals: region.map((f) => normals[f] as Vec3),
        areas: region.map((f) => areas[f] as number),
        centres,
        edgeLength,
      },
      params.kinds,
      params.fitTolerance,
    );
    if (stride > 1 && fit.type !== 'freeform') {
      const distances = all.map((p) => fitDistance(fit, p));
      const max = distances.reduce((m, d) => Math.max(m, d), 0);
      const rms = Math.sqrt(distances.reduce((s, d) => s + d * d, 0) / distances.length);
      fit = max <= params.fitTolerance ? { ...fit, rms, max } : { type: 'freeform', rms, max };
    }
    return { index, faces: region, area: region.reduce((s, f) => s + (areas[f] as number), 0), fit };
  });
  const pairKey = (a: number, b: number): string => `${Math.min(a, b)},${Math.max(a, b)}`;
  const shared = new Map<string, { a: number; b: number; edges: number; length: number }>();
  for (const [fa, fb, length] of neighbours) {
    const [ga, gb] = [faceGroup[fa] as number, faceGroup[fb] as number];
    if (ga < 0 || gb < 0 || ga === gb) continue;
    const key = pairKey(ga, gb);
    const entry = shared.get(key) ?? { a: Math.min(ga, gb), b: Math.max(ga, gb), edges: 0, length: 0 };
    entry.edges++;
    entry.length += length;
    shared.set(key, entry);
  }
  const adjacency = [...shared.values()].sort((x, y) => x.a - y.a || x.b - y.b);
  return { groups, adjacency, faceGroup, unassignedFaces: faceGroup.reduce((s, g) => s + (g < 0 ? 1 : 0), 0) };
}

/**
 * Features below two cells of the target resolution (TECHNICAL_SPEC §5.1 step 7): thin walls (inward ray from a triangle centre), gaps
 * (outward ray) and small closed loops of feature edges (holes, bosses). The surface must be closed and outward oriented.
 */

import type { MeshData, Vec3 } from '@core/model/types';
import { buildMeshBvh, bvhRayCast } from '@core/geometry/meshBvh';
import type { IndexedSurface } from './weld';

export type SmallFeatureKind = 'thin_wall' | 'gap' | 'small_loop';

export interface SmallFeature {
  readonly kind: SmallFeatureKind;
  /** Thickness (thin wall), opening (gap) or diameter (loop), metres. */
  readonly sizeM: number;
  readonly at: Vec3;
  /** Sample points or loops merged into this row. */
  readonly count: number;
  readonly entityId: string | null;
}

export interface SmallFeatureReport {
  readonly features: SmallFeature[];
  /** Rows before the cap on the listing. */
  readonly total: number;
}

/** Rays cast at most; larger surfaces are sampled with a fixed stride. */
export const MAX_FEATURE_RAYS = 20_000;
/** Rows listed. */
export const MAX_FEATURE_ROWS = 50;
/** Dihedral angle above which an edge is a feature edge (cosine of 30 degrees). */
const FEATURE_COS = Math.cos((30 * Math.PI) / 180);
const MAX_LOOP_VERTICES = 2000;

const vertexAt = (vertices: readonly number[], v: number): Vec3 => [
  vertices[v * 3] ?? 0,
  vertices[v * 3 + 1] ?? 0,
  vertices[v * 3 + 2] ?? 0,
];

interface Facet {
  readonly centre: Vec3;
  readonly normal: Vec3;
}

function facetOf({ vertices, triangles }: IndexedSurface, t: number): Facet {
  const a = vertexAt(vertices, triangles[t * 3] ?? 0);
  const b = vertexAt(vertices, triangles[t * 3 + 1] ?? 0);
  const c = vertexAt(vertices, triangles[t * 3 + 2] ?? 0);
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [
    (u[1] ?? 0) * (w[2] ?? 0) - (u[2] ?? 0) * (w[1] ?? 0),
    (u[2] ?? 0) * (w[0] ?? 0) - (u[0] ?? 0) * (w[2] ?? 0),
    (u[0] ?? 0) * (w[1] ?? 0) - (u[1] ?? 0) * (w[0] ?? 0),
  ];
  const length = Math.hypot(n[0] ?? 0, n[1] ?? 0, n[2] ?? 0) || 1;
  return {
    centre: [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3],
    normal: [(n[0] ?? 0) / length, (n[1] ?? 0) / length, (n[2] ?? 0) / length],
  };
}

interface Bin {
  kind: SmallFeatureKind;
  size: number;
  sum: [number, number, number];
  count: number;
}

function rayFeatures(surface: IndexedSurface, facets: readonly Facet[], h: number): Map<string, Bin> {
  const mesh: MeshData = { positions: surface.vertices, indices: surface.triangles };
  const bvh = buildMeshBvh(mesh);
  const stride = Math.max(1, Math.ceil(facets.length / MAX_FEATURE_RAYS));
  const bins = new Map<string, Bin>();
  const cell = 4 * h;
  for (let t = 0; t < facets.length; t += stride) {
    const { centre, normal } = facets[t] as Facet;
    const key = [0, 1, 2].map((axis) => Math.floor((centre[axis] ?? 0) / cell)).join(',');
    for (const [kind, sign] of [
      ['thin_wall', -1],
      ['gap', 1],
    ] as const) {
      const hit = bvhRayCast(bvh, centre, [sign * normal[0], sign * normal[1], sign * normal[2]], 2 * h, 1e-4 * h);
      if (hit === null) continue;
      const binKey = `${kind}:${key}`;
      const bin = bins.get(binKey) ?? { kind, size: Infinity, sum: [0, 0, 0], count: 0 };
      bin.size = Math.min(bin.size, hit.t);
      bin.sum = [bin.sum[0] + centre[0], bin.sum[1] + centre[1], bin.sum[2] + centre[2]];
      bin.count++;
      bins.set(binKey, bin);
    }
  }
  return bins;
}

/** Closed loops of feature edges (every vertex has exactly two) with their vertex list. */
function featureLoops(surface: IndexedSurface, facets: readonly Facet[]): Vec3[][] {
  const { vertices, triangles } = surface;
  const stride = vertices.length / 3 + 1;
  const owners = new Map<number, number[]>();
  for (let t = 0; t < facets.length; t++)
    for (let k = 0; k < 3; k++) {
      const a = triangles[t * 3 + k] ?? 0;
      const b = triangles[t * 3 + ((k + 1) % 3)] ?? 0;
      const key = Math.min(a, b) * stride + Math.max(a, b);
      const list = owners.get(key);
      if (list === undefined) owners.set(key, [t]);
      else list.push(t);
    }
  const neighbours = new Map<number, number[]>();
  const link = (a: number, b: number): void => {
    neighbours.set(a, [...(neighbours.get(a) ?? []), b]);
    neighbours.set(b, [...(neighbours.get(b) ?? []), a]);
  };
  for (const [key, pair] of owners) {
    const [first, second] = pair;
    if (pair.length !== 2 || first === undefined || second === undefined) continue;
    const n1 = (facets[first] as Facet).normal;
    const n2 = (facets[second] as Facet).normal;
    if (n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2] < FEATURE_COS) link(Math.floor(key / stride), key % stride);
  }
  const seen = new Set<number>();
  const loops: Vec3[][] = [];
  for (const start of neighbours.keys()) {
    if (seen.has(start)) continue;
    const component: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const v = stack.pop() as number;
      component.push(v);
      for (const w of neighbours.get(v) ?? [])
        if (!seen.has(w)) {
          seen.add(w);
          stack.push(w);
        }
    }
    if (component.every((v) => (neighbours.get(v) ?? []).length === 2)) loops.push(component.map((v) => vertexAt(vertices, v)));
  }
  return loops;
}

function loopDiameter(points: readonly Vec3[]): number {
  if (points.length > MAX_LOOP_VERTICES) return Infinity;
  let best = 0;
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++) {
      const p = points[i] as Vec3;
      const q = points[j] as Vec3;
      best = Math.max(best, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
    }
  return best;
}

/**
 * Rows for every feature smaller than `2h`, smallest first, capped at MAX_FEATURE_ROWS (`total` counts all).
 * @invariant deterministic: fixed sampling stride, insertion-ordered bins, ties by position
 */
export function findSmallFeatures(surface: IndexedSurface, h: number, attribute: (point: Vec3) => string | null): SmallFeatureReport {
  const facets = Array.from({ length: surface.triangles.length / 3 }, (_, t) => facetOf(surface, t));
  const rows: SmallFeature[] = [];
  for (const bin of rayFeatures(surface, facets, h).values()) {
    const at: Vec3 = [bin.sum[0] / bin.count, bin.sum[1] / bin.count, bin.sum[2] / bin.count];
    rows.push({ kind: bin.kind, sizeM: bin.size, at, count: bin.count, entityId: attribute(at) });
  }
  for (const loop of featureLoops(surface, facets)) {
    const sizeM = loopDiameter(loop);
    if (!(sizeM < 2 * h)) continue;
    const at = loop.reduce<Vec3>(
      (sum, p) => [sum[0] + p[0] / loop.length, sum[1] + p[1] / loop.length, sum[2] + p[2] / loop.length],
      [0, 0, 0],
    );
    rows.push({ kind: 'small_loop', sizeM, at, count: 1, entityId: attribute(at) });
  }
  rows.sort((a, b) => a.sizeM - b.sizeM || a.at[0] - b.at[0] || a.at[1] - b.at[1] || a.at[2] - b.at[2]);
  return { features: rows.slice(0, MAX_FEATURE_ROWS), total: rows.length };
}

/**
 * Wall thickness, ray method (FR-FPR-07): area-weighted deterministic samples on the surface, a ray along the inward normal, the first
 * hit is the local thickness. Samples near a sharp edge (dihedral > 60 degrees) are excluded within `cornerExclusion`.
 * @invariant deterministic: Halton sequences (bases 2, 3, 5), no random
 * @invariant the ray method overestimates on non-parallel walls (stated in the item note)
 */

import type { MeshData, Vec3 } from '../../model/types';
import { quantizedKey } from '../../lib/quantize';
import { add3, cross3, dot3, len3, scale3, sub3 } from '../../lib/vec3';
import { type GeometryQueryEngine, type MeshRay, resolveGeometryQueries } from '../geometryQueries';

export interface ThicknessReport {
  /** Thinnest sample (document units). */
  readonly min: number;
  /** 1st percentile of the samples. */
  readonly p1: number;
  readonly samples: number;
  readonly excluded: number;
  /** Centres of the thinnest clusters, thinnest first, with their thickness. */
  readonly clusters: ReadonlyArray<{ readonly center: Vec3; readonly thickness: number; readonly samples: number }>;
}

const SHARP_DIHEDRAL_DEGREES = 60;
const MAX_CLUSTERS = 10;
/** Edge lists longer than this skip the corner exclusion (cost is samples x edges). */
const MAX_EDGES_FOR_EXCLUSION = 20_000;
const START_OFFSET_RELATIVE = 1e-6;

/** Radical inverse of `index` in `base` (Halton sequence). */
export function halton(index: number, base: number): number {
  let result = 0;
  let fraction = 1 / base;
  for (let i = index; i > 0; i = Math.floor(i / base)) {
    result += (i % base) * fraction;
    fraction /= base;
  }
  return result;
}

interface Edge {
  readonly a: Vec3;
  readonly b: Vec3;
}

function sharpEdges(corners: readonly Vec3[][], normals: readonly Vec3[]): Edge[] {
  const byEdge = new Map<string, { a: Vec3; b: Vec3; normals: Vec3[] }>();
  corners.forEach((triangle, index) => {
    for (let k = 0; k < 3; k++) {
      const a = triangle[k] as Vec3;
      const b = triangle[(k + 1) % 3] as Vec3;
      const [ka, kb] = [quantizedKey(a, 1e-6), quantizedKey(b, 1e-6)];
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const entry = byEdge.get(key) ?? { a, b, normals: [] };
      entry.normals.push(normals[index] as Vec3);
      byEdge.set(key, entry);
    }
  });
  const limit = Math.cos((SHARP_DIHEDRAL_DEGREES * Math.PI) / 180);
  return [...byEdge.values()].filter((edge) => edge.normals.length === 2 && dot3(edge.normals[0] as Vec3, edge.normals[1] as Vec3) < limit);
}

function distanceToSegment(point: Vec3, { a, b }: Edge): number {
  const ab = sub3(b, a);
  const lengthSquared = dot3(ab, ab);
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, dot3(sub3(point, a), ab) / lengthSquared));
  return len3(sub3(point, add3(a, scale3(ab, t))));
}

/**
 * Thickness statistics of a closed, outward-wound mesh; null when the mesh has no triangles or no sample hit the opposite wall.
 * @param cornerExclusion document units; 0 disables the exclusion
 * @param clusterRadius document units; samples closer than this to a cluster's first sample join it
 */
export function measureThickness(
  mesh: MeshData,
  rays: number,
  cornerExclusion: number,
  clusterRadius: number,
  engine?: GeometryQueryEngine | null,
): ThicknessReport | null {
  const triangleCount = Math.floor(mesh.indices.length / 3);
  if (triangleCount === 0 || rays <= 0) return null;
  const vertex = (i: number): Vec3 => [mesh.positions[i * 3] ?? 0, mesh.positions[i * 3 + 1] ?? 0, mesh.positions[i * 3 + 2] ?? 0];
  const corners = Array.from({ length: triangleCount }, (_, t) => [0, 1, 2].map((k) => vertex(mesh.indices[t * 3 + k] ?? 0)));
  const cross = corners.map(([a, b, c]) => cross3(sub3(b as Vec3, a as Vec3), sub3(c as Vec3, a as Vec3)));
  const areas = cross.map((c) => len3(c) / 2);
  const normals = cross.map((c) => (len3(c) > 0 ? scale3(c, 1 / len3(c)) : ([0, 0, 0] as Vec3)));
  const cumulative: number[] = [];
  areas.reduce((sum, area, t) => (cumulative[t] = sum + area), 0);
  const total = cumulative[triangleCount - 1] ?? 0;
  if (!(total > 0)) return null;
  const lows = [Infinity, Infinity, Infinity];
  const highs = [-Infinity, -Infinity, -Infinity];
  for (const triangle of corners) {
    for (const corner of triangle) {
      for (let axis = 0; axis < 3; axis++) {
        lows[axis] = Math.min(lows[axis] ?? Infinity, corner?.[axis] ?? Infinity);
        highs[axis] = Math.max(highs[axis] ?? -Infinity, corner?.[axis] ?? -Infinity);
      }
    }
  }
  const diagonal = len3(sub3(highs as unknown as Vec3, lows as unknown as Vec3));
  const edges = cornerExclusion > 0 ? sharpEdges(corners, normals) : [];
  const exclude = cornerExclusion > 0 && edges.length > 0 && edges.length <= MAX_EDGES_FOR_EXCLUSION;
  const samples: Array<{ point: Vec3; ray: MeshRay }> = [];
  let excluded = 0;
  for (let i = 1; i <= rays; i++) {
    const target = halton(i, 2) * total;
    let low = 0;
    let high = triangleCount - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((cumulative[middle] ?? 0) < target) low = middle + 1;
      else high = middle;
    }
    const [a, b, c] = corners[low] as [Vec3, Vec3, Vec3];
    let [u, v] = [halton(i, 3), halton(i, 5)];
    if (u + v > 1) [u, v] = [1 - u, 1 - v];
    const point = add3(a, add3(scale3(sub3(b, a), u), scale3(sub3(c, a), v)));
    if (exclude && edges.some((edge) => distanceToSegment(point, edge) < cornerExclusion)) {
      excluded++;
      continue;
    }
    const inward = scale3(normals[low] as Vec3, -1);
    samples.push({ point, ray: { origin: point, direction: inward, tMin: START_OFFSET_RELATIVE * diagonal } });
  }
  const hits = resolveGeometryQueries(engine).rayCastBatch(
    mesh,
    samples.map((sample) => sample.ray),
    Infinity,
  );
  const found: Array<{ point: Vec3; thickness: number }> = [];
  samples.forEach((sample, k) => {
    const hit = hits[k];
    if (hit !== null && hit !== undefined) found.push({ point: sample.point, thickness: hit.t });
  });
  if (found.length === 0) return null;
  const sorted = [...found].sort(
    (p, q) => p.thickness - q.thickness || p.point[0] - q.point[0] || p.point[1] - q.point[1] || p.point[2] - q.point[2],
  );
  const clusters: Array<{ center: Vec3; thickness: number; samples: number }> = [];
  for (const sample of sorted) {
    const near = clusters.find((cluster) => len3(sub3(cluster.center, sample.point)) <= clusterRadius);
    if (near !== undefined) near.samples++;
    else if (clusters.length < MAX_CLUSTERS) clusters.push({ center: sample.point, thickness: sample.thickness, samples: 1 });
  }
  return {
    min: sorted[0]?.thickness ?? 0,
    p1: sorted[Math.floor(0.01 * (sorted.length - 1))]?.thickness ?? 0,
    samples: found.length,
    excluded,
    clusters,
  };
}

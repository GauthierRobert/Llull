/**
 * Symmetric deviation between two triangle meshes (07 MSH FR-MSH-25): closest-surface distance from sample points of each mesh to the other.
 * Samples are the vertices and the triangle centroids (and, with `edgeMidpoints`, the midpoints of the edges) (evenly strided down to `maxSamples` per mesh), so the Hausdorff value is a lower bound
 * of the true one that is exact for vertex-dominated differences and tight for fine meshes.
 * @invariant deterministic: same inputs -> same numbers
 */

import type { MeshData } from '../../model/types';
import type { Vec3 } from '../../model/vectors';
import { SurfaceIndex } from './surfaceIndex';

export interface DeviationSummary {
  /** Largest distance from a sample of `a` to the surface of `b`. */
  readonly forwardMax: number;
  /** Largest distance from a sample of `b` to the surface of `a`. */
  readonly backwardMax: number;
  readonly hausdorff: number;
  readonly mean: number;
  readonly rms: number;
  readonly samples: number;
  /** Sample counts in 10 equal bins from 0 to the Hausdorff value. */
  readonly histogram: number[];
  /** The sample farthest from the other mesh: its point, which mesh it belongs to (a = first argument) and the distance. */
  readonly worst: { readonly point: Vec3; readonly mesh: 'a' | 'b'; readonly distance: number };
}

/** Default samples per mesh. */
export const DEVIATION_MAX_SAMPLES = 20_000;

function samplePoints(mesh: MeshData, maxSamples: number, edgeMidpoints: boolean): Vec3[] {
  const points: Vec3[] = [];
  const vertices = mesh.positions.length / 3;
  const used = new Uint8Array(vertices);
  for (const i of mesh.indices) used[i] = 1;
  for (let v = 0; v < vertices; v++)
    if (used[v] === 1)
      points.push([mesh.positions[v * 3] as number, mesh.positions[v * 3 + 1] as number, mesh.positions[v * 3 + 2] as number]);
  for (let f = 0; f + 2 < mesh.indices.length; f += 3) {
    const [a, b, c] = [mesh.indices[f] as number, mesh.indices[f + 1] as number, mesh.indices[f + 2] as number];
    const centre = (axis: number): number =>
      ((mesh.positions[a * 3 + axis] as number) + (mesh.positions[b * 3 + axis] as number) + (mesh.positions[c * 3 + axis] as number)) / 3;
    points.push([centre(0), centre(1), centre(2)]);
  }
  if (edgeMidpoints) {
    const seen = new Set<number>();
    const count = vertices;
    for (let f = 0; f + 2 < mesh.indices.length; f += 3)
      for (let k = 0; k < 3; k++) {
        const [a, b] = [mesh.indices[f + k] as number, mesh.indices[f + ((k + 1) % 3)] as number];
        const key = Math.min(a, b) * count + Math.max(a, b);
        if (seen.has(key)) continue;
        seen.add(key);
        points.push([
          ((mesh.positions[a * 3] as number) + (mesh.positions[b * 3] as number)) / 2,
          ((mesh.positions[a * 3 + 1] as number) + (mesh.positions[b * 3 + 1] as number)) / 2,
          ((mesh.positions[a * 3 + 2] as number) + (mesh.positions[b * 3 + 2] as number)) / 2,
        ]);
      }
  }
  if (points.length <= maxSamples) return points;
  const stride = points.length / maxSamples;
  return Array.from({ length: maxSamples }, (_, i) => points[Math.floor(i * stride)] as Vec3);
}

function distances(points: ReadonlyArray<Vec3>, target: SurfaceIndex): number[] {
  return points.map((p) => target.closest(p).distance);
}

/** Both-way deviation of `a` and `b`; null when either mesh has no triangle. */
export function symmetricDeviation(
  a: MeshData,
  b: MeshData,
  maxSamples = DEVIATION_MAX_SAMPLES,
  options: { readonly edgeMidpoints?: boolean } = {},
): DeviationSummary | null {
  if (a.indices.length < 3 || b.indices.length < 3) return null;
  const [indexA, indexB] = [new SurfaceIndex(a.positions, a.indices), new SurfaceIndex(b.positions, b.indices)];
  const [pointsA, pointsB] = [
    samplePoints(a, maxSamples, options.edgeMidpoints === true),
    samplePoints(b, maxSamples, options.edgeMidpoints === true),
  ];
  const forward = distances(pointsA, indexB);
  const backward = distances(pointsB, indexA);
  const all = [...forward, ...backward];
  const forwardMax = forward.reduce((m, d) => Math.max(m, d), 0);
  const backwardMax = backward.reduce((m, d) => Math.max(m, d), 0);
  const hausdorff = Math.max(forwardMax, backwardMax);
  const histogram = new Array<number>(10).fill(0);
  for (const d of all) {
    const bin = hausdorff > 0 ? Math.min(9, Math.floor((d / hausdorff) * 10)) : 0;
    histogram[bin] = (histogram[bin] as number) + 1;
  }
  const fromA = forwardMax >= backwardMax;
  const worstIndex = (fromA ? forward : backward).indexOf(fromA ? forwardMax : backwardMax);
  return {
    forwardMax,
    backwardMax,
    hausdorff,
    mean: all.reduce((s, d) => s + d, 0) / all.length,
    rms: Math.sqrt(all.reduce((s, d) => s + d * d, 0) / all.length),
    samples: all.length,
    histogram,
    worst: { point: (fromA ? pointsA : pointsB)[worstIndex] as Vec3, mesh: fromA ? 'a' : 'b', distance: hausdorff },
  };
}

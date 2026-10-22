/** Minimum wall thickness of a closed outward-wound mesh: inward ray from each (sampled) triangle centroid to the first surface hit. */

import type { MeshData } from '../../model/types';
import type { Vec3 } from '../../model/vectors';
import { cross3, normalize3, sub3 } from '../../lib/vec3';
import { buildMeshBvh, bvhRayCast } from '../meshBvh';
import { meshDiagonal } from './weld';

export interface WallThickness {
  /** Smallest thickness found; Infinity when no ray hit anything. */
  readonly min: number;
  /** Centroid of the triangle where it was found. */
  readonly at: Vec3 | null;
  readonly samples: number;
}

/** At most this many triangles are probed (evenly strided, deterministic). */
const MAX_THICKNESS_SAMPLES = 20_000;

export function minimumWallThickness(mesh: MeshData): WallThickness {
  const triangles = Math.floor(mesh.indices.length / 3);
  if (triangles === 0) return { min: Infinity, at: null, samples: 0 };
  const bvh = buildMeshBvh(mesh);
  const diagonal = meshDiagonal(mesh.positions);
  const stride = Math.max(1, Math.ceil(triangles / MAX_THICKNESS_SAMPLES));
  const point = (i: number): Vec3 => [
    mesh.positions[i * 3] as number,
    mesh.positions[i * 3 + 1] as number,
    mesh.positions[i * 3 + 2] as number,
  ];
  let min = Infinity;
  let at: Vec3 | null = null;
  let samples = 0;
  for (let f = 0; f < triangles; f += stride) {
    const [a, b, c] = [
      point(mesh.indices[f * 3] as number),
      point(mesh.indices[f * 3 + 1] as number),
      point(mesh.indices[f * 3 + 2] as number),
    ];
    const normal = cross3(sub3(b, a), sub3(c, a));
    if (Math.hypot(...normal) === 0) continue;
    const centroid: Vec3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const inward = normalize3([-normal[0], -normal[1], -normal[2]]);
    samples++;
    const hit = bvhRayCast(bvh, centroid, inward, diagonal * 2, 1e-7 * diagonal);
    if (hit !== null && hit.t < min) {
      min = hit.t;
      at = centroid;
    }
  }
  return { min, at, samples };
}

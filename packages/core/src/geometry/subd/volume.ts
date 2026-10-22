/** Volume of the level meshes of a cage and the limit-surface estimate (04 DIR §5.8, FR-DIR-35). Pure. */

import type { Vec3 } from '../../model/types';
import { cross3, dot3 } from '../../lib/vec3';
import { type Cage, subdivide } from '../subdivision';

/** Signed volume of the fan triangulation of a closed, outward-wound polygon mesh. */
function polygonMeshVolume(vertices: ReadonlyArray<Vec3>, faces: ReadonlyArray<ReadonlyArray<number>>): number {
  let sum = 0;
  for (const face of faces)
    for (let k = 1; k + 1 < face.length; k++)
      sum += dot3(
        vertices[face[0] as number] as Vec3,
        cross3(vertices[face[k] as number] as Vec3, vertices[face[k + 1] as number] as Vec3),
      );
  return sum / 6;
}

/** Volume of the cage refined `levels` times (the surface the display mesh and the no-kernel mass properties use). */
export function levelMeshVolume(cage: Cage, levels: number): number {
  const mesh = subdivide(cage, levels);
  return polygonMeshVolume(mesh.vertices, mesh.faces);
}

/** Quad count of the level mesh of `cage` at `levels` (without building it). */
export function levelQuadCount(cage: Cage, levels: number): number {
  const corners = cage.faces.reduce((total, face) => total + face.length, 0);
  return levels === 0 ? cage.faces.length : corners * 4 ** (levels - 1);
}

/**
 * Estimate of the limit-surface volume: the level meshes converge with ratio 1/4 per level (error ~ h^2), so
 * V_inf ~ V_m + (V_m - V_(m-1)) / 3 at the finest level m <= 5 whose mesh has at most `maxQuads` quads. Null when even level 2 is too large.
 */
export function limitVolumeEstimate(cage: Cage, maxQuads = 40_000): { volume: number; level: number } | null {
  let level = 5;
  while (level >= 2 && levelQuadCount(cage, level) > maxQuads) level--;
  if (level < 2) return null;
  const [fine, coarse] = [levelMeshVolume(cage, level), levelMeshVolume(cage, level - 1)];
  return { volume: fine + (fine - coarse) / 3, level };
}

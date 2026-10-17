/** Axis-aligned extent of a display mesh. */

import type { MeshData, Vec3 } from '../model/types';
import { boundsOfPoints } from './bounds';
import { distance3 } from '../lib/vec3';

/** Opposite corners of the mesh's bounding box ([0,0,0] twice for an empty mesh). */
export function meshCorners(mesh: Pick<MeshData, 'positions'>): [Vec3, Vec3] {
  const points: Vec3[] = [];
  for (let i = 0; i + 2 < mesh.positions.length; i += 3)
    points.push([mesh.positions[i] ?? 0, mesh.positions[i + 1] ?? 0, mesh.positions[i + 2] ?? 0]);
  if (points.length === 0)
    return [
      [0, 0, 0],
      [0, 0, 0],
    ];
  const { min, max } = boundsOfPoints(points);
  return [min, max];
}

/** Length of the bounding-box diagonal. */
export const meshDiagonal = (mesh: Pick<MeshData, 'positions'>): number => distance3(...meshCorners(mesh));

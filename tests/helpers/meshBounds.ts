import type { MeshData } from '@core/geometry/kernel';
import type { Vec3 } from '@core/model/types';

/** Axis-aligned bounds of a mesh's vertex positions. */
export function meshBounds(mesh: MeshData): { min: Vec3; max: Vec3 } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, mesh.positions[i + k]!);
      max[k] = Math.max(max[k]!, mesh.positions[i + k]!);
    }
  }
  return { min: min as unknown as Vec3, max: max as unknown as Vec3 };
}

/** Bounding-box diagonal of a kernel shape, the length scale of the blend tolerances. */

import type { GeometryKernel, ShapeHandle } from '../../geometry/kernel';
import { distance3 } from '../../lib/vec3';

/** Bounding-box diagonal of `shape` (exact mass properties, else the display mesh); 0 when unknown. */
export function diagonalOf(kernel: GeometryKernel, shape: ShapeHandle): number {
  const bounds = kernel.massProperties?.(shape)?.bounds;
  if (bounds !== undefined) return distance3(bounds.min, bounds.max);
  const mesh = kernel.tessellate(shape);
  if (mesh === null || mesh.positions.length < 3) return 0;
  const low: number[] = [Infinity, Infinity, Infinity];
  const high: number[] = [-Infinity, -Infinity, -Infinity];
  for (let at = 0; at + 2 < mesh.positions.length; at += 3)
    for (let axis = 0; axis < 3; axis++) {
      const value = mesh.positions[at + axis] ?? 0;
      low[axis] = Math.min(low[axis] ?? value, value);
      high[axis] = Math.max(high[axis] ?? value, value);
    }
  const [x0 = 0, y0 = 0, z0 = 0] = low;
  const [x1 = 0, y1 = 0, z1 = 0] = high;
  return distance3([x0, y0, z0], [x1, y1, z1]);
}

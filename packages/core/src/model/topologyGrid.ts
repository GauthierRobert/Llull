/**
 * Grid geometry of a topology artifact (PHY-17), shared by the topology plugin (iso-surface, rebuild) and the implicit plugin (density as a scalar field):
 * the world axis of each grid direction and the mirror-averaging of a density across the symmetry planes of its study.
 * @invariant pure; the field is averaged with its mirror image across each plane through the centre of the grid (a no-op for a plane normal to a 2D grid)
 */

import type { FeTopologyArtifact, SymmetryPlane } from './topology';

type Axes = readonly [number, number, number];

const PLANE_AXES: Readonly<Record<SymmetryPlane, Axes>> = { XY: [0, 1, 2], XZ: [0, 2, 1], YZ: [1, 2, 0] };
const NORMAL_AXIS: Readonly<Record<SymmetryPlane, number>> = { XY: 2, XZ: 1, YZ: 0 };

/** Grid axes of an artifact grid (world axis of grid directions i, j, k). */
export const axesOfGrid = (grid: FeTopologyArtifact['grid']): Axes => (grid.plane === undefined ? [0, 1, 2] : PLANE_AXES[grid.plane]);

/** The field averaged with its mirror image across each plane through the centre of the grid (a no-op for a plane normal to a 2D grid). */
export function symmetrise(field: Float32Array, grid: FeTopologyArtifact['grid'], planes: readonly SymmetryPlane[]): Float32Array {
  const axes = axesOfGrid(grid);
  const sizes = [grid.nx, grid.ny, grid.nz] as const;
  let current = field;
  for (const plane of new Set(planes)) {
    const direction = axes.indexOf(NORMAL_AXIS[plane]);
    if (grid.dimension === 2 && direction === 2) continue;
    const mirrored = new Float32Array(current.length);
    for (let k = 0; k < grid.nz; k += 1)
      for (let j = 0; j < grid.ny; j += 1)
        for (let i = 0; i < grid.nx; i += 1) {
          const at = [i, j, k];
          at[direction] = (sizes[direction] ?? 1) - 1 - (at[direction] ?? 0);
          mirrored[i + grid.nx * (j + grid.ny * k)] =
            0.5 *
            ((current[i + grid.nx * (j + grid.ny * k)] ?? 0) +
              (current[(at[0] ?? 0) + grid.nx * ((at[1] ?? 0) + grid.ny * (at[2] ?? 0))] ?? 0));
        }
    current = mirrored;
  }
  return current;
}

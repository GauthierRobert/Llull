/**
 * 05 loads as the optimiser sees them (TECHNICAL_SPEC 5.4, 15.3): nodal forces of a force or pressure load on the mapped grid nodes, and the
 * gravity force per fully solid voxel of a load case. Units are those of the analysis unit system (the voxel size and face areas are converted
 * from document units by the caller).
 */

import type { FeaLoad } from '@core/model/analysis';
import type { Vec3 } from '@core/model/types';
import { dofComponents, type MappedTarget } from './mapping';
import type { TopologyGrid } from './voxel';

export interface NodalForces {
  readonly dofs: number[];
  readonly values: number[];
}

/** `vector` (world) spread over `mapped.nodes`: the whole vector at each node for `per_node`, else an equal share of it. */
function spread(grid: TopologyGrid, mapped: MappedTarget, vector: Vec3, perNode: boolean): NodalForces {
  const share = perNode ? 1 : 1 / mapped.nodes.length;
  const dofs: number[] = [];
  const values: number[] = [];
  for (let component = 0; component < dofComponents(grid); component += 1) {
    const value = (vector[grid.axes[component] ?? 0] ?? 0) * share;
    if (value === 0) continue;
    for (const node of mapped.nodes) {
      dofs.push(dofComponents(grid) * node + component);
      values.push(value);
    }
  }
  return { dofs, values };
}

/** Out-of-plane share of a world vector on a 2D grid (0 on a 3D grid). */
function outOfPlane(grid: TopologyGrid, vector: Vec3): number {
  if (grid.dimension === 3) return 0;
  const length = Math.hypot(...vector);
  return length === 0 ? 0 : Math.abs(vector[grid.axes[2] ?? 2] ?? 0) / length;
}

/**
 * Nodal forces of a `force` load.
 * @failure no in-plane component -> an explanation
 */
export function forceLoad(load: FeaLoad, grid: TopologyGrid, mapped: MappedTarget): NodalForces | string {
  const forces = spread(grid, mapped, load.vector ?? [0, 0, 0], load.distribution === 'per_node');
  return forces.dofs.length === 0 ? `load '${load.id}' has no in-plane force component` : forces;
}

/**
 * Nodal forces of a `pressure` load: the total force `magnitude x face area` (positive pushes INTO the material, along the inward normal)
 * spread equally over the nodes of the loaded face. `areaFactor` converts the face area from document units squared to the analysis unit.
 * @failure a target without faces, or a face whose normal leaves the plane of a 2D grid -> an explanation
 */
export function pressureLoad(load: FeaLoad, grid: TopologyGrid, mapped: MappedTarget, areaFactor: number): NodalForces | string {
  if (mapped.normal === undefined || mapped.faceArea === undefined || !(mapped.faceArea > 0))
    return `pressure '${load.id}' needs a facesNear target (a pressure acts on faces)`;
  if (outOfPlane(grid, mapped.normal) > 1e-6)
    return `pressure '${load.id}': the loaded face is not perpendicular to the plane of the 2D grid`;
  const total = (load.magnitude ?? 0) * mapped.faceArea * areaFactor;
  const inward: Vec3 = [-mapped.normal[0] * total, -mapped.normal[1] * total, -mapped.normal[2] * total];
  const forces = spread(grid, mapped, inward, false);
  return forces.dofs.length === 0 ? `pressure '${load.id}' has no in-plane force component` : forces;
}

/**
 * Gravity as the force a fully solid voxel weighs, per grid component: `density x acceleration x voxel volume` (analysis units).
 * @failure an acceleration with an out-of-plane component on a 2D grid -> an explanation
 */
export function gravityPerVoxel(load: FeaLoad, grid: TopologyGrid, density: number, voxelVolume: number): number[] | string {
  const acceleration: Vec3 = load.vector ?? [0, 0, 0];
  if (outOfPlane(grid, acceleration) > 1e-9) return `gravity '${load.id}' must lie in the plane of the 2D grid`;
  const components: number[] = [];
  for (let component = 0; component < dofComponents(grid); component += 1)
    components.push(density * (acceleration[grid.axes[component] ?? 0] ?? 0) * voxelVolume);
  return components;
}

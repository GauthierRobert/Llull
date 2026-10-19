/** Keep-in / keep-out regions of a study as voxel masks on its grid. */

import type { TopologyRegion } from '@core/model/topology';
import { entityToTriangles } from '@core/geometry/entityTriangles';
import { is3D, type CadDocument } from '@core/model/types';
import { isMappingFailure, mapTarget, nodeCoordinates, nodeSets } from './mapping';
import { boxMask, insideMask, type TopologyGrid } from './voxel';

type NodeSetsOf = ReturnType<typeof nodeSets>;

/** Voxels within `depth` layers of the nodes (depth 1 = the voxels that touch a node), restricted to active voxels. */
export function voxelsAroundNodes(grid: TopologyGrid, active: Uint8Array, nodes: readonly number[], depth: number): Uint8Array {
  const mask = new Uint8Array(grid.count);
  for (const node of nodes) {
    const [ni, nj, nk] = nodeCoordinates(grid, node);
    for (
      let k = grid.dimension === 2 ? 0 : Math.max(0, nk - depth);
      k <= (grid.dimension === 2 ? 0 : Math.min(grid.nz - 1, nk + depth - 1));
      k += 1
    )
      for (let j = Math.max(0, nj - depth); j <= Math.min(grid.ny - 1, nj + depth - 1); j += 1)
        for (let i = Math.max(0, ni - depth); i <= Math.min(grid.nx - 1, ni + depth - 1); i += 1) {
          const index = i + grid.nx * (j + grid.ny * k);
          if (active[index] === 1) mask[index] = 1;
        }
  }
  return mask;
}

/**
 * Active voxels of one region.
 * @failure unknown / non-solid entity, or a target that maps to no node -> `{ error }`
 */
function regionMask(
  doc: CadDocument,
  grid: TopologyGrid,
  active: Uint8Array,
  sets: NodeSetsOf,
  region: TopologyRegion,
): Uint8Array | { readonly error: string } {
  if (region.kind === 'box') return boxMask(grid, region.min, region.max).map((flag, index) => flag & (active[index] ?? 0));
  const entityId = region.kind === 'entity' ? region.entityId : region.target.entityId;
  const entity = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId] : undefined;
  if (entity === undefined || !is3D(entity)) return { error: `'${entityId}' is not an existing 3D solid` };
  const triangles = entityToTriangles(entity, doc);
  if (region.kind === 'entity') return insideMask(triangles, grid).map((flag, index) => flag & (active[index] ?? 0));
  const mapped = mapTarget(grid, sets, triangles, region.target);
  if (isMappingFailure(mapped)) return { error: mapped.error };
  return voxelsAroundNodes(grid, active, mapped.nodes, Math.max(1, Math.round(region.depthVoxels)));
}

/** Union mask and the per-region voxel counts (a region with 0 is outside the domain). */
export function regionMasks(
  doc: CadDocument,
  grid: TopologyGrid,
  active: Uint8Array,
  regions: readonly TopologyRegion[],
): { readonly mask: Uint8Array; readonly counts: readonly number[] } | { readonly error: string; readonly index: number } {
  const sets = nodeSets(grid, active);
  const mask = new Uint8Array(grid.count);
  const counts: number[] = [];
  for (const [index, region] of regions.entries()) {
    const own = regionMask(doc, grid, active, sets, region);
    if ('error' in own) return { error: own.error, index };
    counts.push(own.reduce((sum, flag) => sum + flag, 0));
    own.forEach((flag, voxel) => {
      if (flag === 1) mask[voxel] = 1;
    });
  }
  return { mask, counts };
}

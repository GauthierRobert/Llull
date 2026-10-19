/** Voxel grid of a topology study (TR-TOP-02): placement over the design domain AABB and ray-parity voxelisation of closed triangle meshes. */

import type { SymmetryPlane, TopologyArtifactGrid, TopologyStudy } from '@core/model/topology';
import { entityToTriangles } from '@core/geometry/entityTriangles';
import type { Triangle } from '@core/geometry/triangles';
import { is3D, type CadDocument, type Vec3 } from '@core/model/types';
import { TOPOLOGY_VOXEL_CAP } from './defaults';

/** World axes (x = 0, y = 1, z = 2) of grid directions i, j, k. A 2D study's k is the out-of-plane axis (one layer). */
type GridAxes = readonly [number, number, number];

const PLANE_AXES: Readonly<Record<SymmetryPlane, GridAxes>> = { XY: [0, 1, 2], XZ: [0, 2, 1], YZ: [1, 2, 0] };

export interface TopologyGrid {
  readonly dimension: 2 | 3;
  readonly plane?: SymmetryPlane;
  readonly voxel: number;
  readonly axes: GridAxes;
  /** World minimum corner of the grid (document units). */
  readonly origin: Vec3;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /** 2D: out-of-plane extent of the design domain; 3D: the voxel size. */
  readonly thickness: number;
  readonly count: number;
}

export interface GridRefusal {
  readonly code: 'TOP_DOMAIN_INVALID' | 'TOP_GRID_TOO_LARGE';
  readonly message: string;
  readonly ids: readonly string[];
}

export const isGridRefusal = (value: TopologyGrid | GridRefusal): value is GridRefusal => 'code' in value;

/** World-space triangles of the design-domain entities (all solids), or the ids that are not solids. */
export function domainTriangles(doc: CadDocument, entityIds: readonly string[]): Triangle[] | GridRefusal {
  const triangles: Triangle[] = [];
  for (const id of entityIds) {
    const entity = Object.hasOwn(doc.entities, id) ? doc.entities[id] : undefined;
    if (entity === undefined || !is3D(entity))
      return { code: 'TOP_DOMAIN_INVALID', message: `'${id}' is not an existing 3D solid`, ids: [id] };
    const own = entityToTriangles(entity, doc);
    if (own.length === 0) return { code: 'TOP_DOMAIN_INVALID', message: `'${id}' has no faceted surface`, ids: [id] };
    triangles.push(...own);
  }
  return triangles.length === 0 ? { code: 'TOP_DOMAIN_INVALID', message: 'the design domain is empty', ids: [] } : triangles;
}

function extent(triangles: readonly Triangle[]): { readonly min: Vec3; readonly max: Vec3 } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const triangle of triangles)
    for (const point of triangle)
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis] ?? Infinity, point[axis] ?? Infinity);
        max[axis] = Math.max(max[axis] ?? -Infinity, point[axis] ?? -Infinity);
      }
  return { min, max };
}

const cells = (length: number, voxel: number): number => Math.max(1, Math.ceil(length / voxel - 1e-9));
const roundUp3 = (value: number): number => Number(value.toPrecision(3)) * (Number(value.toPrecision(3)) < value ? 1.01 : 1);

/**
 * Grid over the AABB of `triangles`: `voxel` spacing, 2D studies sample the mid plane of the out-of-plane extent.
 * @failure voxel count above the cap -> TOP_GRID_TOO_LARGE with the voxel size that would fit
 */
export function gridOver(
  study: Pick<TopologyStudy, 'dimension' | 'plane' | 'voxel'>,
  triangles: readonly Triangle[],
): TopologyGrid | GridRefusal {
  const { min, max } = extent(triangles);
  const plane = study.dimension === 2 ? (study.plane ?? 'XY') : undefined;
  const axes: GridAxes = plane === undefined ? [0, 1, 2] : PLANE_AXES[plane];
  const length = (axis: number): number => (max[axis] ?? 0) - (min[axis] ?? 0);
  const nx = cells(length(axes[0]), study.voxel);
  const ny = cells(length(axes[1]), study.voxel);
  const nz = plane === undefined ? cells(length(axes[2]), study.voxel) : 1;
  const count = nx * ny * nz;
  if (count > TOPOLOGY_VOXEL_CAP) {
    const suggested = roundUp3(study.voxel * (count / TOPOLOGY_VOXEL_CAP) ** (1 / study.dimension));
    return {
      code: 'TOP_GRID_TOO_LARGE',
      message: `${nx} x ${ny}${plane === undefined ? ` x ${nz}` : ''} = ${count} voxels exceed the cap of ${TOPOLOGY_VOXEL_CAP}; use voxel >= ${suggested}`,
      ids: [],
    };
  }
  return {
    dimension: study.dimension,
    ...(plane !== undefined ? { plane } : {}),
    voxel: study.voxel,
    axes,
    origin: [min[0] ?? 0, min[1] ?? 0, min[2] ?? 0],
    nx,
    ny,
    nz,
    thickness: plane === undefined ? study.voxel : length(axes[2]),
    count,
  };
}

/** Grid placement as stored in the artifact. */
export const artifactGrid = (grid: TopologyGrid, counts: { active: number; keepIn: number; keepOut: number }): TopologyArtifactGrid => ({
  nx: grid.nx,
  ny: grid.ny,
  nz: grid.nz,
  ...counts,
  dimension: grid.dimension,
  ...(grid.plane !== undefined ? { plane: grid.plane } : {}),
  voxel: grid.voxel,
  origin: grid.origin,
  thickness: grid.thickness,
});

/** World centre of voxel (i, j, k); a 2D grid's out-of-plane coordinate is the mid plane. */
function voxelCentre(grid: TopologyGrid, i: number, j: number, k: number): Vec3 {
  const centre: [number, number, number] = [0, 0, 0];
  const [ai, aj, ak] = grid.axes;
  centre[ai] = (grid.origin[ai] ?? 0) + (i + 0.5) * grid.voxel;
  centre[aj] = (grid.origin[aj] ?? 0) + (j + 0.5) * grid.voxel;
  centre[ak] = (grid.origin[ak] ?? 0) + (grid.dimension === 2 ? grid.thickness / 2 : (k + 0.5) * grid.voxel);
  return centre;
}

/** World position of node (i, j, k) (0..n); the out-of-plane coordinate of a 2D grid is the mid plane. */
export function nodePosition(grid: TopologyGrid, i: number, j: number, k: number): Vec3 {
  const position: [number, number, number] = [0, 0, 0];
  const [ai, aj, ak] = grid.axes;
  position[ai] = (grid.origin[ai] ?? 0) + i * grid.voxel;
  position[aj] = (grid.origin[aj] ?? 0) + j * grid.voxel;
  position[ak] = (grid.origin[ak] ?? 0) + (grid.dimension === 2 ? grid.thickness / 2 : k * grid.voxel);
  return position;
}

/** Deterministic sub-voxel offsets of the ray rows: they keep rays off mesh edges that lie on voxel mid planes. */
const ROW_OFFSET_J = 1.37e-7;
const ROW_OFFSET_K = 2.11e-7;

/**
 * Voxels whose centre lies inside the closed mesh (even-odd rule along the grid i direction, so a closed, consistently oriented or not,
 * triangle surface is enough). Index = i + nx (j + ny k).
 * @invariant rows are cast through the voxel centres shifted by a fixed sub-voxel offset, so an edge lying exactly on a centre row never counts twice
 */
export function insideMask(triangles: readonly Triangle[], grid: TopologyGrid): Uint8Array {
  const { nx, ny, nz, voxel } = grid;
  const [ai, aj, ak] = grid.axes;
  const oj = (grid.origin[aj] ?? 0) + (0.5 + ROW_OFFSET_J) * voxel;
  const ok =
    grid.dimension === 2
      ? (grid.origin[ak] ?? 0) + grid.thickness / 2 + ROW_OFFSET_K * voxel
      : (grid.origin[ak] ?? 0) + (0.5 + ROW_OFFSET_K) * voxel;
  const crossings: Array<number[] | undefined> = new Array<number[] | undefined>(ny * nz);
  for (const [p, q, r] of triangles) {
    const [pj, qj, rj] = [p[aj] ?? 0, q[aj] ?? 0, r[aj] ?? 0];
    const [pk, qk, rk] = [p[ak] ?? 0, q[ak] ?? 0, r[ak] ?? 0];
    const denominator = (qj - pj) * (rk - pk) - (rj - pj) * (qk - pk);
    if (Math.abs(denominator) < 1e-24) continue;
    const jFirst = Math.max(0, Math.ceil((Math.min(pj, qj, rj) - oj) / voxel));
    const jLast = Math.min(ny - 1, Math.floor((Math.max(pj, qj, rj) - oj) / voxel));
    const kFirst = grid.dimension === 2 ? 0 : Math.max(0, Math.ceil((Math.min(pk, qk, rk) - ok) / voxel));
    const kLast = grid.dimension === 2 ? 0 : Math.min(nz - 1, Math.floor((Math.max(pk, qk, rk) - ok) / voxel));
    for (let k = kFirst; k <= kLast; k += 1)
      for (let j = jFirst; j <= jLast; j += 1) {
        const dj = oj + j * voxel - pj;
        const dk = ok + k * voxel - pk;
        const v = (dj * (rk - pk) - (rj - pj) * dk) / denominator;
        const w = ((qj - pj) * dk - dj * (qk - pk)) / denominator;
        if (v < 0 || w < 0 || v + w > 1) continue;
        const row = j + ny * k;
        (crossings[row] ??= []).push((p[ai] ?? 0) + v * ((q[ai] ?? 0) - (p[ai] ?? 0)) + w * ((r[ai] ?? 0) - (p[ai] ?? 0)));
      }
  }
  const inside = new Uint8Array(nx * ny * nz);
  for (let row = 0; row < ny * nz; row += 1) {
    const hits = crossings[row]?.sort((a, b) => a - b);
    if (hits === undefined) continue;
    let passed = 0;
    for (let i = 0; i < nx; i += 1) {
      const centre = (grid.origin[ai] ?? 0) + (i + 0.5) * voxel;
      while (passed < hits.length && (hits[passed] ?? Infinity) < centre) passed += 1;
      if (passed % 2 === 1) inside[i + nx * row] = 1;
    }
  }
  return inside;
}

/** Voxels whose centre lies in the box [min, max] (world, document units); a 2D grid compares the in-plane axes only and needs the slab to overlap. */
export function boxMask(grid: TopologyGrid, min: Vec3, max: Vec3): Uint8Array {
  const mask = new Uint8Array(grid.count);
  const [, , ak] = grid.axes;
  const slabLow = grid.origin[ak] ?? 0;
  const slabOverlaps = grid.dimension === 3 || ((max[ak] ?? 0) >= slabLow && (min[ak] ?? 0) <= slabLow + grid.thickness);
  if (!slabOverlaps) return mask;
  for (let k = 0; k < grid.nz; k += 1)
    for (let j = 0; j < grid.ny; j += 1)
      for (let i = 0; i < grid.nx; i += 1) {
        const centre = voxelCentre(grid, i, j, k);
        const inBox = [0, 1, 2].every((axis) =>
          axis === ak && grid.dimension === 2 ? true : (centre[axis] ?? 0) >= (min[axis] ?? 0) && (centre[axis] ?? 0) <= (max[axis] ?? 0),
        );
        if (inBox) mask[i + grid.nx * (j + grid.ny * k)] = 1;
      }
  return mask;
}

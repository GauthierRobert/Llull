/** Rebuild aids of a recorded field: section contours for `suggest_rebuild` and the voxel comparison of a rebuilt solid with the optimum. */

import type { FeTopologyArtifact, SymmetryPlane, TopologyStudy } from '@core/model/topology';
import { entityToTriangles } from '@core/geometry/entityTriangles';
import { eulerFromMat } from '@lib/axisRotation';
import { toMm } from '@core/model/units';
import { is3D, type CadDocument, type Vec3 } from '@core/model/types';
import { contourLoops, nodeGridOfVoxels, padNodeGrid, type Contour, type NodeGrid } from './contours';
import { axesOfGrid, symmetrise } from '@core/model/topologyGrid';
import { domainTriangles, insideMask, type TopologyGrid } from './voxel';

const NORMAL_AXIS: Readonly<Record<SymmetryPlane, number>> = { XY: 2, XZ: 1, YZ: 0 };
const PLANE_AXES: Readonly<Record<SymmetryPlane, readonly [number, number]>> = { XY: [0, 1], XZ: [0, 2], YZ: [1, 2] };

/** Grid of an artifact as the voxelisation helpers use it. */
function gridOfArtifact(artifact: FeTopologyArtifact): TopologyGrid {
  const { grid } = artifact;
  return {
    dimension: grid.dimension,
    ...(grid.plane !== undefined ? { plane: grid.plane } : {}),
    voxel: grid.voxel,
    axes: axesOfGrid(grid),
    origin: grid.origin,
    nx: grid.nx,
    ny: grid.ny,
    nz: grid.nz,
    thickness: grid.thickness,
    count: grid.nx * grid.ny * grid.nz,
  };
}

/** Field value at a world point by trilinear interpolation between voxel centres; voxels outside the grid count as 0. */
function sample(field: Float32Array, grid: FeTopologyArtifact['grid'], point: Vec3): number {
  const at = [0, 1, 2].map((axis) => ((point[axis] ?? 0) - (grid.origin[axis] ?? 0)) / grid.voxel - 0.5);
  const base = at.map(Math.floor);
  const frac = at.map((value, axis) => value - (base[axis] ?? 0));
  let total = 0;
  for (let corner = 0; corner < 8; corner += 1) {
    const offset = [corner & 1, (corner >> 1) & 1, (corner >> 2) & 1];
    const [i, j, k] = offset.map((o, axis) => (base[axis] ?? 0) + o);
    const weight = offset.reduce((product, o, axis) => product * (o === 1 ? (frac[axis] ?? 0) : 1 - (frac[axis] ?? 0)), 1);
    if ((i ?? -1) >= 0 && (j ?? -1) >= 0 && (k ?? -1) >= 0 && (i ?? 0) < grid.nx && (j ?? 0) < grid.ny && (k ?? 0) < grid.nz)
      total += weight * (field[(i ?? 0) + grid.nx * ((j ?? 0) + grid.ny * (k ?? 0))] ?? 0);
  }
  return total;
}

export interface Section {
  readonly plane: SymmetryPlane;
  /** World axes of the section's local x and y. */
  readonly axes: readonly [number, number];
  /** Coordinate of the section plane along its normal. */
  readonly level: number;
  readonly nodes: NodeGrid;
  /** World position of local (0, 0) and the node spacing. */
  readonly origin: readonly [number, number];
  readonly voxel: number;
  /** Area of the section covered by the design domain (2D studies: active voxels; 3D: the bounding section). */
  readonly domainArea: number;
}

/**
 * Node-sampled field on a plane: a 2D study's own plane, or a plane through a 3D study (default XY through the grid centre).
 * @failure a 2D study sectioned on another plane -> a message
 */
export function sectionOf(
  artifact: FeTopologyArtifact,
  field: Float32Array,
  plane: SymmetryPlane | undefined,
  offset: number | undefined,
): Section | string {
  const { grid } = artifact;
  if (grid.dimension === 2) {
    const own = grid.plane ?? 'XY';
    if (plane !== undefined && plane !== own) return `this is a 2D study on plane ${own}: omit plane or pass ${own}`;
    const axes = axesOfGrid(grid);
    return {
      plane: own,
      axes: [axes[0], axes[1]],
      level: grid.origin[axes[2]] ?? 0,
      nodes: nodeGridOfVoxels(field, grid.nx, grid.ny),
      origin: [grid.origin[axes[0]] ?? 0, grid.origin[axes[1]] ?? 0],
      voxel: grid.voxel,
      domainArea: grid.active * grid.voxel ** 2,
    };
  }
  const chosen = plane ?? 'XY';
  const axes = PLANE_AXES[chosen];
  const normal = NORMAL_AXIS[chosen];
  const lengths = [grid.nx, grid.ny, grid.nz].map((count) => count * grid.voxel);
  const level = offset ?? (grid.origin[normal] ?? 0) + (lengths[normal] ?? 0) / 2;
  const cols = Math.round((lengths[axes[0]] ?? 0) / grid.voxel) + 1;
  const rows = Math.round((lengths[axes[1]] ?? 0) / grid.voxel) + 1;
  const values = new Float64Array(cols * rows);
  for (let j = 0; j < rows; j += 1)
    for (let i = 0; i < cols; i += 1) {
      const point: [number, number, number] = [0, 0, 0];
      point[axes[0]] = (grid.origin[axes[0]] ?? 0) + i * grid.voxel;
      point[axes[1]] = (grid.origin[axes[1]] ?? 0) + j * grid.voxel;
      point[normal] = level;
      values[i + cols * j] = sample(field, grid, point);
    }
  return {
    plane: chosen,
    axes,
    level,
    nodes: padNodeGrid({ cols, rows, values }),
    origin: [grid.origin[axes[0]] ?? 0, grid.origin[axes[1]] ?? 0],
    voxel: grid.voxel,
    domainArea: (cols - 1) * (rows - 1) * grid.voxel ** 2,
  };
}

/** Euler angles and extrusion direction that make `extrude_profile` build a profile of this plane's local (x, y) coordinates in place. */
export function placementOf(
  section: Section,
  depth: number | null,
): { readonly position: Vec3; readonly rotation: Vec3; readonly extrusion: string } {
  const level = section.level;
  if (section.plane === 'XY') return { position: [0, 0, level], rotation: [0, 0, 0], extrusion: '+z' };
  if (section.plane === 'XZ')
    return {
      position: [0, level + (depth ?? 0), 0],
      rotation: [Math.PI / 2, 0, 0],
      extrusion: '-y (position.y is the +y face of the extruded part)',
    };
  const yz = eulerFromMat([0, 0, 1, 1, 0, 0, 0, 1, 0]);
  return { position: [level, 0, 0], rotation: [yz[0], yz[1], yz[2]], extrusion: '+x' };
}

export interface SectionContours {
  readonly contours: Contour[];
  readonly dropped: number;
}

export function contoursOf(section: Section, threshold: number, tolerance: number, minArea: number): SectionContours {
  return contourLoops(section.nodes, threshold, { origin: section.origin, scale: section.voxel }, tolerance, minArea);
}

export interface Comparison {
  readonly iou: number;
  readonly volumeRatio: number | null;
  readonly rebuildVoxels: number;
  readonly optimumVoxels: number;
}

/**
 * Voxel comparison of the solid `entityId` with the thresholded field on the study grid: the rebuilt voxels are those whose centre lies inside
 * the solid (ray parity) and in the design domain.
 * @failure unknown / non-solid entity or a domain that no longer voxelises -> a message
 */
export function compareRebuild(
  doc: CadDocument,
  study: TopologyStudy,
  artifact: FeTopologyArtifact,
  field: Float32Array,
  entityId: string,
): Comparison | string {
  const entity = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId] : undefined;
  if (entity === undefined || !is3D(entity)) return `'${entityId}' is not an existing 3D solid`;
  const grid = gridOfArtifact(artifact);
  const domain = domainTriangles(doc, study.designDomain);
  if (!Array.isArray(domain)) return domain.message;
  const active = insideMask(domain, grid);
  const rebuilt = insideMask(entityToTriangles(entity, doc), grid);
  const optimum = symmetrise(field, artifact.grid, study.manufacturing.symmetry);
  let both = 0;
  let either = 0;
  let rebuildVoxels = 0;
  let optimumVoxels = 0;
  for (let voxel = 0; voxel < grid.count; voxel += 1) {
    const a = rebuilt[voxel] === 1 && active[voxel] === 1;
    const b = (optimum[voxel] ?? 0) >= study.settings.threshold.value;
    if (a) rebuildVoxels += 1;
    if (b) optimumVoxels += 1;
    if (a && b) both += 1;
    if (a || b) either += 1;
  }
  return {
    iou: either === 0 ? 0 : both / either,
    volumeRatio: optimumVoxels === 0 ? null : rebuildVoxels / optimumVoxels,
    rebuildVoxels,
    optimumVoxels,
  };
}

/** Square millimetres in one square document unit. */
export const mm2PerUnit2 = (doc: CadDocument): number => toMm(doc, 1) ** 2;

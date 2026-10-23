/**
 * Iso-surface of a recorded density field (TR-TOP-08): an extruded marching-squares contour for 2D studies, marching tetrahedra for 3D
 * ones, on node values averaged from the adjacent voxels and padded with 0 so the surface is closed. Deterministic and welded.
 */

import type { FeTopologyArtifact, SymmetryPlane } from '@core/model/topology';
import type { MeshData, Vec3 } from '@core/model/types';
import { pointInPolygon } from '@lib/polygon';
import { quantizedKey } from '@lib/quantize';
import { marchingTetrahedra } from '@lib/isosurface/tetra';
import { triangulatePolygon } from '@lib/triangulate';
import { marchingSquares, nodeGridOfVoxels, type Point } from './contours';

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

/** Vertices welded by exact position; triangles are index triples. */
class MeshBuilder {
  readonly positions: number[] = [];
  readonly indices: number[] = [];
  private readonly byKey = new Map<string, number>();

  vertex(point: Vec3): number {
    const key = quantizedKey(point, 1e-9);
    const known = this.byKey.get(key);
    if (known !== undefined) return known;
    const index = this.positions.length / 3;
    this.positions.push(...point);
    this.byKey.set(key, index);
    return index;
  }

  triangle(a: Vec3, b: Vec3, c: Vec3, flip: boolean): void {
    const [ia, ib, ic] = [this.vertex(a), this.vertex(b), this.vertex(c)];
    if (ia === ib || ib === ic || ia === ic) return;
    this.indices.push(ia, flip ? ic : ib, flip ? ib : ic);
  }

  mesh(): MeshData {
    return { positions: this.positions, indices: this.indices };
  }
}

/** Odd permutations of (x, y, z) as (u, v, w) are left-handed: the triangle winding is mirrored. */
const oddPermutation = ([a, b, c]: Axes): boolean => ((a > b ? 1 : 0) + (a > c ? 1 : 0) + (b > c ? 1 : 0)) % 2 === 1;

function extrudedContour(grid: FeTopologyArtifact['grid'], field: Float32Array, threshold: number): MeshData {
  const axes = axesOfGrid(grid);
  const builder = new MeshBuilder();
  const flip = oddPermutation(axes);
  const loops = marchingSquares(nodeGridOfVoxels(field, grid.nx, grid.ny), threshold);
  const [u0, v0, w0] = [grid.origin[axes[0]] ?? 0, grid.origin[axes[1]] ?? 0, grid.origin[axes[2]] ?? 0];
  const world = (p: Point, w: number): Vec3 => {
    const out: [number, number, number] = [0, 0, 0];
    out[axes[0]] = u0 + p[0] * grid.voxel;
    out[axes[1]] = v0 + p[1] * grid.voxel;
    out[axes[2]] = w;
    return out;
  };
  const area = (loop: readonly Point[]): number =>
    loop.reduce(
      (sum, p, i) => sum + (p[0] * (loop[(i + 1) % loop.length] as Point)[1] - (loop[(i + 1) % loop.length] as Point)[0] * p[1]),
      0,
    ) / 2;
  const outers = loops.filter((loop) => area(loop) > 0);
  const holes = loops.filter((loop) => area(loop) < 0);
  for (const loop of loops)
    loop.forEach((p, i) => {
      const q = loop[(i + 1) % loop.length] as Point;
      builder.triangle(world(p, w0), world(q, w0), world(q, w0 + grid.thickness), flip);
      builder.triangle(world(p, w0), world(q, w0 + grid.thickness), world(p, w0 + grid.thickness), flip);
    });
  for (const outer of outers) {
    const inside = holes.filter((hole) => pointInPolygon(hole[0] as Point as [number, number], outer as Array<[number, number]>));
    const { vertices, triangles } = triangulatePolygon(outer as Array<[number, number]>, inside as Array<Array<[number, number]>>);
    for (const [a, b, c] of triangles) {
      const [pa, pb, pc] = [vertices[a], vertices[b], vertices[c]] as [Point, Point, Point];
      builder.triangle(world(pa, w0 + grid.thickness), world(pb, w0 + grid.thickness), world(pc, w0 + grid.thickness), flip);
      builder.triangle(world(pa, w0), world(pc, w0), world(pb, w0), flip);
    }
  }
  return builder.mesh();
}

/** Node values this close to the threshold are moved just below it: no vertex lands on a node, so no zero-area triangles (node values are multiples of 1/8, 0.5 is common). */
const THRESHOLD_SNAP = 1e-3;

/** Marching tetrahedra (lib/isosurface/tetra) on node values averaged from the adjacent voxels, padded with 0 so the surface closes. */
function marchingTetrahedraOfVoxels(grid: FeTopologyArtifact['grid'], field: Float32Array, threshold: number): MeshData {
  const { nx, ny, nz } = grid;
  const voxel = (i: number, j: number, k: number): number =>
    i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz ? (field[i + nx * (j + ny * k)] ?? 0) : 0;
  const nodes: [number, number, number] = [nx + 3, ny + 3, nz + 3];
  const values = new Float64Array(nodes[0] * nodes[1] * nodes[2]);
  for (let k = 0; k < nodes[2]; k += 1)
    for (let j = 0; j < nodes[1]; j += 1)
      for (let i = 0; i < nodes[0]; i += 1) {
        let sum = 0;
        for (let dk = -1; dk <= 0; dk += 1)
          for (let dj = -1; dj <= 0; dj += 1) for (let di = -1; di <= 0; di += 1) sum += voxel(i - 1 + di, j - 1 + dj, k - 1 + dk);
        const value = sum / 8;
        values[i + nodes[0] * (j + nodes[1] * k)] = Math.abs(value - threshold) < THRESHOLD_SNAP ? threshold - THRESHOLD_SNAP : value;
      }
  const origin: Vec3 = [(grid.origin[0] ?? 0) - grid.voxel, (grid.origin[1] ?? 0) - grid.voxel, (grid.origin[2] ?? 0) - grid.voxel];
  return marchingTetrahedra({ nodes, origin, voxel: grid.voxel, values, threshold, insideAbove: true }) ?? { positions: [], indices: [] };
}

/**
 * Closed, welded iso-surface of `field` at `threshold` (document coordinates), consistently oriented (normals point out of the material).
 * @invariant a 2D study gives the contour extruded over the thickness; vertex and triangle order depend on the field only
 */
export function deriveTopologyMesh(
  artifact: FeTopologyArtifact,
  field: Float32Array,
  threshold: number,
  planes: readonly SymmetryPlane[],
): MeshData {
  const symmetric = symmetrise(field, artifact.grid, planes);
  return artifact.grid.dimension === 2
    ? extrudedContour(artifact.grid, symmetric, threshold)
    : marchingTetrahedraOfVoxels(artifact.grid, symmetric, threshold);
}

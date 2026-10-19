/**
 * Iso-surface of a recorded density field (TR-TOP-08): an extruded marching-squares contour for 2D studies, marching tetrahedra for 3D
 * ones, on node values averaged from the adjacent voxels and padded with 0 so the surface is closed. Deterministic and welded.
 */

import type { FeTopologyArtifact, SymmetryPlane } from '@core/model/topology';
import type { MeshData, Vec3 } from '@core/model/types';
import { elementAt } from '@lib/elementAt';
import { pointInPolygon } from '@lib/polygon';
import { cross3 as cross, dot3 as dot, sub3 as sub } from '@lib/vec3';
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
    const key = point.map((value) => Math.round(value * 1e9)).join(',');
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

/** Corner offsets of the six Kuhn tetrahedra of a cube (paths from corner 000 to 111). */
const KUHN: ReadonlyArray<readonly [Vec3, Vec3, Vec3, Vec3]> = [
  [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [1, 1, 1],
  ],
  [
    [0, 0, 0],
    [1, 0, 0],
    [1, 0, 1],
    [1, 1, 1],
  ],
  [
    [0, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
    [1, 1, 1],
  ],
  [
    [0, 0, 0],
    [0, 1, 0],
    [0, 1, 1],
    [1, 1, 1],
  ],
  [
    [0, 0, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
  ],
  [
    [0, 0, 0],
    [0, 0, 1],
    [0, 1, 1],
    [1, 1, 1],
  ],
];

interface Corner {
  readonly at: Vec3;
  readonly value: number;
}

const average = (points: readonly Vec3[]): Vec3 => [
  points.reduce((sum, p) => sum + p[0], 0) / points.length,
  points.reduce((sum, p) => sum + p[1], 0) / points.length,
  points.reduce((sum, p) => sum + p[2], 0) / points.length,
];

function marchingTetrahedra(grid: FeTopologyArtifact['grid'], field: Float32Array, threshold: number): MeshData {
  const { nx, ny, nz } = grid;
  const builder = new MeshBuilder();
  const voxel = (i: number, j: number, k: number): number =>
    i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz ? (field[i + nx * (j + ny * k)] ?? 0) : 0;
  const nodeValue = (i: number, j: number, k: number): number => {
    let sum = 0;
    for (let dk = -1; dk <= 0; dk += 1)
      for (let dj = -1; dj <= 0; dj += 1) for (let di = -1; di <= 0; di += 1) sum += voxel(i + di, j + dj, k + dk);
    return sum / 8;
  };
  const place = ([i, j, k]: Vec3): Vec3 => [
    (grid.origin[0] ?? 0) + i * grid.voxel,
    (grid.origin[1] ?? 0) + j * grid.voxel,
    (grid.origin[2] ?? 0) + k * grid.voxel,
  ];
  const rank = ([i, j, k]: Vec3): number => i + 1 + (nx + 3) * (j + 1 + (ny + 3) * (k + 1));
  const cut = (a: Corner, b: Corner): Vec3 => {
    const [low, high] = rank(a.at) < rank(b.at) ? [a, b] : [b, a];
    const t = high.value === low.value ? 0.5 : (threshold - low.value) / (high.value - low.value);
    const [p, q] = [place(low.at), place(high.at)];
    return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
  };
  for (let k = -1; k <= nz; k += 1)
    for (let j = -1; j <= ny; j += 1)
      for (let i = -1; i <= nx; i += 1)
        for (const tetrahedron of KUHN) {
          const corners = tetrahedron.map(
            ([di, dj, dk]): Corner => ({ at: [i + di, j + dj, k + dk], value: nodeValue(i + di, j + dj, k + dk) }),
          );
          const inside = corners.filter((corner) => corner.value >= threshold);
          const outside = corners.filter((corner) => corner.value < threshold);
          if (inside.length === 0 || outside.length === 0) continue;
          const from = average(inside.map((corner) => place(corner.at)));
          const to = average(outside.map((corner) => place(corner.at)));
          const emit = (a: Vec3, b: Vec3, c: Vec3): void => {
            const normal = cross(sub(b, a), sub(c, a));
            builder.triangle(a, b, c, dot(normal, sub(to, from)) < 0);
          };
          if (inside.length === 2) {
            const [a, b, c, d] = [elementAt(inside, 0), elementAt(inside, 1), elementAt(outside, 0), elementAt(outside, 1)];
            emit(cut(a, c), cut(a, d), cut(b, d));
            emit(cut(a, c), cut(b, d), cut(b, c));
          } else {
            const [apex, base] = inside.length === 1 ? [elementAt(inside, 0), outside] : [elementAt(outside, 0), inside];
            emit(cut(apex, elementAt(base, 0)), cut(apex, elementAt(base, 1)), cut(apex, elementAt(base, 2)));
          }
        }
  return builder.mesh();
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
    : marchingTetrahedra(artifact.grid, symmetric, threshold);
}

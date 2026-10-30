/**
 * Sampled scalar data as an operand of the tape (`sample_field`, 05 IMP 14.11): a density grid read by trilinear interpolation, or a tetrahedral mesh with
 * node values read by barycentric interpolation. Domain-free: the implicit plugin turns a topology result or an FE result into one of these.
 * @invariant a grid is cell-centred (value i at origin + (i + 1/2) voxel) and holds its edge values outside (nearest); a tetrahedral mesh gives the
 *   barycentric blend inside the first tetrahedron (lowest index) that contains the point and the value of the nearest node (lowest index on a tie) outside
 * @invariant every value is a convex combination of the data, clamped to [lo, hi] (the extreme data values: the tolerance of the point location and rounding cannot leave it), so [lo, hi] bounds every sample; a non finite coordinate gives NaN
 * @invariant only + - * / floor and comparisons: the native twin (`solver/crates/llull-field/src/sampled.rs`) is bit-identical
 */

import type { Vec3 } from '../../model/types';

export interface GridSamples {
  readonly kind: 'grid';
  /** Voxels per axis. */
  readonly nodes: readonly [number, number, number];
  /** World minimum corner of voxel (0, 0, 0). */
  readonly origin: Vec3;
  readonly voxel: number;
  /** x fastest, then y, then z. */
  readonly values: readonly number[];
  /** Identity of the data (the content hashes of the artifacts it was read from and the choices that shaped it): the content hash of a body takes it instead of the numbers. */
  readonly source?: string;
}

export interface TetSamples {
  readonly kind: 'tets';
  /** Node coordinates, three per node. */
  readonly points: readonly number[];
  /** Node indices, four per tetrahedron. */
  readonly tets: readonly number[];
  /** One value per node. */
  readonly values: readonly number[];
  /** Identity of the data, as for a grid. */
  readonly source?: string;
}

export type SampledField = GridSamples | TetSamples;

export interface SampledEvaluator {
  value(x: number, y: number, z: number): number;
  /** Smallest and largest data value. */
  readonly lo: number;
  readonly hi: number;
}

const OUTSIDE_TOLERANCE = -1e-9;
const MAX_BUCKETS_PER_AXIS = 64;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clampIndex = (i: number, n: number): number => (i < 0 ? 0 : i > n - 1 ? n - 1 : i);

/** Smallest and largest data value of `field` (no evaluator is built). */
export function sampledRange(field: SampledField): { lo: number; hi: number } {
  return extremes(field.values);
}

function extremes(values: readonly number[]): { lo: number; hi: number } {
  let [lo, hi] = [Infinity, -Infinity];
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return { lo, hi };
}

function prepareGrid(grid: GridSamples): SampledEvaluator {
  const [nx, ny, nz] = grid.nodes;
  const { origin, voxel, values } = grid;
  const at = (i: number, j: number, k: number): number => values[i + nx * (j + ny * k)] as number;
  const { lo, hi } = extremes(values);
  return {
    lo,
    hi,
    value(x, y, z) {
      const [ux, uy, uz] = [(x - origin[0]) / voxel - 0.5, (y - origin[1]) / voxel - 0.5, (z - origin[2]) / voxel - 0.5];
      if (!(Number.isFinite(ux) && Number.isFinite(uy) && Number.isFinite(uz))) return NaN;
      const [fx, fy, fz] = [Math.floor(ux), Math.floor(uy), Math.floor(uz)];
      const [tx, ty, tz] = [ux - fx, uy - fy, uz - fz];
      const [ia, ib] = [clampIndex(fx, nx), clampIndex(fx + 1, nx)];
      const [ja, jb] = [clampIndex(fy, ny), clampIndex(fy + 1, ny)];
      const [ka, kb] = [clampIndex(fz, nz), clampIndex(fz + 1, nz)];
      const c00 = lerp(at(ia, ja, ka), at(ib, ja, ka), tx);
      const c10 = lerp(at(ia, jb, ka), at(ib, jb, ka), tx);
      const c01 = lerp(at(ia, ja, kb), at(ib, ja, kb), tx);
      const c11 = lerp(at(ia, jb, kb), at(ib, jb, kb), tx);
      return Math.min(Math.max(lerp(lerp(c00, c10, ty), lerp(c01, c11, ty), tz), lo), hi);
    },
  };
}

function prepareTets(mesh: TetSamples): SampledEvaluator {
  const { points, tets, values } = mesh;
  const { lo: dataLo, hi: dataHi } = extremes(values);
  const tetCount = tets.length / 4;
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let n = 0; n < points.length; n += 3)
    for (let axis = 0; axis < 3; axis += 1) {
      low[axis] = Math.min(low[axis] as number, points[n + axis] as number);
      high[axis] = Math.max(high[axis] as number, points[n + axis] as number);
    }
  const resolution = Math.max(1, Math.min(MAX_BUCKETS_PER_AXIS, Math.ceil(Math.cbrt(tetCount))));
  const size = [0, 1, 2].map((axis) => Math.max(((high[axis] as number) - (low[axis] as number)) / resolution, 1e-300));
  const cellOf = (axis: number, v: number): number => {
    const c = Math.floor((v - (low[axis] as number)) / (size[axis] as number));
    return c < 0 ? 0 : c > resolution - 1 ? resolution - 1 : c;
  };
  const buckets: number[][] = Array.from({ length: resolution ** 3 }, () => []);
  for (let t = 0; t < tetCount; t += 1) {
    const [lo, hi] = [
      [Infinity, Infinity, Infinity],
      [-Infinity, -Infinity, -Infinity],
    ] as [number[], number[]];
    for (let v = 0; v < 4; v += 1)
      for (let axis = 0; axis < 3; axis += 1) {
        const coordinate = points[3 * (tets[4 * t + v] as number) + axis] as number;
        lo[axis] = Math.min(lo[axis] as number, coordinate);
        hi[axis] = Math.max(hi[axis] as number, coordinate);
      }
    for (let k = cellOf(2, lo[2] as number); k <= cellOf(2, hi[2] as number); k += 1)
      for (let j = cellOf(1, lo[1] as number); j <= cellOf(1, hi[1] as number); j += 1)
        for (let i = cellOf(0, lo[0] as number); i <= cellOf(0, hi[0] as number); i += 1)
          (buckets[i + resolution * (j + resolution * k)] as number[]).push(t);
  }
  const blend = (t: number, x: number, y: number, z: number): number | null => {
    const [a, b, c, d] = [0, 1, 2, 3].map((v) => 3 * (tets[4 * t + v] as number));
    const p = (n: number, axis: number): number => points[n + axis] as number;
    const e1 = [
      p(b as number, 0) - p(a as number, 0),
      p(b as number, 1) - p(a as number, 1),
      p(b as number, 2) - p(a as number, 2),
    ] as const;
    const e2 = [
      p(c as number, 0) - p(a as number, 0),
      p(c as number, 1) - p(a as number, 1),
      p(c as number, 2) - p(a as number, 2),
    ] as const;
    const e3 = [
      p(d as number, 0) - p(a as number, 0),
      p(d as number, 1) - p(a as number, 1),
      p(d as number, 2) - p(a as number, 2),
    ] as const;
    const q = [x - p(a as number, 0), y - p(a as number, 1), z - p(a as number, 2)] as const;
    const cross = (u: readonly number[], v: readonly number[]): readonly [number, number, number] => [
      (u[1] as number) * (v[2] as number) - (u[2] as number) * (v[1] as number),
      (u[2] as number) * (v[0] as number) - (u[0] as number) * (v[2] as number),
      (u[0] as number) * (v[1] as number) - (u[1] as number) * (v[0] as number),
    ];
    const dot = (u: readonly number[], v: readonly number[]): number =>
      (u[0] as number) * (v[0] as number) + (u[1] as number) * (v[1] as number) + (u[2] as number) * (v[2] as number);
    const det = dot(e1, cross(e2, e3));
    if (det === 0) return null;
    const l1 = dot(q, cross(e2, e3)) / det;
    const l2 = dot(e1, cross(q, e3)) / det;
    const l3 = dot(e1, cross(e2, q)) / det;
    const l0 = 1 - l1 - l2 - l3;
    if (!(l0 >= OUTSIDE_TOLERANCE && l1 >= OUTSIDE_TOLERANCE && l2 >= OUTSIDE_TOLERANCE && l3 >= OUTSIDE_TOLERANCE)) return null;
    const v = (n: number): number => values[n / 3] as number;
    return Math.min(Math.max(l0 * v(a as number) + l1 * v(b as number) + l2 * v(c as number) + l3 * v(d as number), dataLo), dataHi);
  };
  const nearestNode = (x: number, y: number, z: number): number => {
    let [best, bestD] = [0, Infinity];
    for (let n = 0; n < points.length; n += 3) {
      const [dx, dy, dz] = [x - (points[n] as number), y - (points[n + 1] as number), z - (points[n + 2] as number)];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) [best, bestD] = [n / 3, d];
    }
    return values[best] as number;
  };
  return {
    lo: dataLo,
    hi: dataHi,
    value(x, y, z) {
      if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) return NaN;
      const inside =
        x >= (low[0] as number) &&
        x <= (high[0] as number) &&
        y >= (low[1] as number) &&
        y <= (high[1] as number) &&
        z >= (low[2] as number) &&
        z <= (high[2] as number);
      if (inside) {
        const bucket = buckets[cellOf(0, x) + resolution * (cellOf(1, y) + resolution * cellOf(2, z))] as number[];
        for (const t of bucket) {
          const hit = blend(t, x, y, z);
          if (hit !== null) return hit;
        }
      }
      return nearestNode(x, y, z);
    },
  };
}

/** Evaluator of one sampled field. */
export function prepareSampledField(field: SampledField): SampledEvaluator {
  return field.kind === 'grid' ? prepareGrid(field) : prepareTets(field);
}

/** Why `field` is not well formed, or null. */
export function sampledFieldError(field: SampledField): string | null {
  if (field.kind === 'grid') {
    const [nx, ny, nz] = field.nodes;
    if (![nx, ny, nz].every((n) => Number.isInteger(n) && n >= 1)) return 'grid needs integer node counts >= 1';
    if (!(Number.isFinite(field.voxel) && field.voxel > 0) || !field.origin.every(Number.isFinite))
      return 'grid needs a finite origin and voxel > 0';
    if (field.values.length !== nx * ny * nz) return `grid holds ${field.values.length} values for ${nx * ny * nz} voxels`;
    return field.values.every(Number.isFinite) ? null : 'grid holds a non finite value';
  }
  const nodeCount = field.points.length / 3;
  if (!Number.isInteger(nodeCount) || nodeCount < 1 || !Number.isInteger(field.tets.length / 4))
    return 'tets need 3 coordinates per node and 4 nodes per tetrahedron';
  if (field.values.length !== nodeCount) return `tets hold ${field.values.length} values for ${nodeCount} nodes`;
  if (!field.points.every(Number.isFinite) || !field.values.every(Number.isFinite)) return 'tets hold a non finite number';
  return field.tets.every((n) => Number.isInteger(n) && n >= 0 && n < nodeCount) ? null : 'a tetrahedron names a node out of range';
}

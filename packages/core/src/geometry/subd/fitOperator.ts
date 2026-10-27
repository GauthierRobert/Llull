/**
 * The limit surface of a Catmull-Clark cage sampled at the vertices of its level-k refinement, as a sparse matrix: row i holds the weights of
 * the cage vertices that make limit point i (S^k followed by the limit mask), so `limit = A * cage` for any cage positions. Creases, semi-sharp
 * edges and boundaries follow the same rules as `subdivide`. Pure.
 */

import type { MeshData, Vec3 } from '../../model/types';
import { type Cage, type RefinableCage, VEC3_OPS, refineOnce } from '../subdivision';
import { limitMasks } from './limitMasks';
import { fullSettleLevels } from './settle';
import { type Stencil, stencilOps, unitStencil } from './stencil';

/** Compressed sparse rows of the limit operator, with the quads of the sampled level. */
export interface FitOperator {
  readonly rows: number;
  readonly cols: number;
  readonly rowStart: Int32Array;
  readonly colIdx: Int32Array;
  readonly value: Float64Array;
  /** Four vertex (row) indices per quad of the level-k mesh. */
  readonly quads: Int32Array;
}

/** Refined level of `cage` after `level` steps over any vertex algebra. */
function refined<T>(cage: RefinableCage<T>, level: number, ops: Parameters<typeof refineOnce<T>>[1]): RefinableCage<T> {
  let current = cage;
  for (let step = 0; step < level; step++) current = refineOnce(current, ops);
  return current;
}

function quadIndices(faces: ReadonlyArray<ReadonlyArray<number>>): Int32Array {
  const quads = new Int32Array(faces.length * 4);
  faces.forEach((face, f) => face.forEach((v, k) => (quads[f * 4 + k] = v)));
  return quads;
}

/**
 * Refinement steps that make the limit masks valid: at least 1 (every face a quad) and `fullSettleLevels(cage)`, the exact count with no cap (below
 * it a finite sharpness is still left on some edge and the crease mask would be applied to an edge `refineOnce` makes smooth later).
 */
export const sampleLevel = (cage: Cage, level: number): number => Math.max(level, 1, fullSettleLevels(cage));

/** Operator of the limit points of the level-`sampleLevel(cage, level)` mesh of `cage`. */
export function buildFitOperator(cage: Cage, level: number): FitOperator {
  const ops = stencilOps(cage.vertices.length);
  const start: RefinableCage<Stencil> = { ...cage, vertices: cage.vertices.map((_, i) => unitStencil(i)) };
  const mesh = refined(start, sampleLevel(cage, level), ops);
  const masks = limitMasks(mesh);
  const rowStart = new Int32Array(masks.length + 1);
  const columns: Int32Array[] = [];
  const values: Float64Array[] = [];
  masks.forEach((mask, i) => {
    const row = ops.combine(mask.idx.map((v, k) => [mesh.vertices[v] as Stencil, mask.w[k] as number] as const));
    columns.push(row.idx);
    values.push(row.w);
    rowStart[i + 1] = (rowStart[i] as number) + row.idx.length;
  });
  const colIdx = new Int32Array(rowStart[masks.length] as number);
  const value = new Float64Array(colIdx.length);
  columns.forEach((cols, i) => {
    colIdx.set(cols, rowStart[i] as number);
    value.set(values[i] as Float64Array, rowStart[i] as number);
  });
  return { rows: masks.length, cols: cage.vertices.length, rowStart, colIdx, value, quads: quadIndices(mesh.faces) };
}

/** `out = A * x` for one coordinate (x has one value per cage vertex, out one per row). */
export function applyOperator(a: FitOperator, x: Float64Array, out: Float64Array): void {
  for (let r = 0; r < a.rows; r++) {
    let total = 0;
    for (let k = a.rowStart[r] as number; k < (a.rowStart[r + 1] as number); k++)
      total += (a.value[k] as number) * (x[a.colIdx[k] as number] as number);
    out[r] = total;
  }
}

/** `out = A^T * y` (y one value per row, out one per cage vertex). */
export function applyTranspose(a: FitOperator, y: Float64Array, out: Float64Array): void {
  out.fill(0);
  for (let r = 0; r < a.rows; r++) {
    const yr = y[r] as number;
    if (yr === 0) continue;
    for (let k = a.rowStart[r] as number; k < (a.rowStart[r + 1] as number); k++)
      out[a.colIdx[k] as number] = (out[a.colIdx[k] as number] as number) + (a.value[k] as number) * yr;
  }
}

/** The triangle mesh of limit points `positions` (flat xyz) over the quads of `a` (each split along its first diagonal). */
export function limitTriangles(a: FitOperator, positions: ReadonlyArray<number>): MeshData {
  const indices: number[] = [];
  for (let q = 0; q < a.quads.length; q += 4)
    indices.push(
      a.quads[q] as number,
      a.quads[q + 1] as number,
      a.quads[q + 2] as number,
      a.quads[q] as number,
      a.quads[q + 2] as number,
      a.quads[q + 3] as number,
    );
  return { positions, indices };
}

/**
 * Limit surface of `cage` as a triangle mesh, computed on points only (no operator): for verification at levels too fine for a matrix. The mesh is of level
 * `sampleLevel(cage, level)`, returned as `level` so that callers see when semi-sharp creases raised the asked level.
 */
export function limitSurfaceMesh(cage: Cage, level: number): { mesh: MeshData; level: number } {
  const sampled = sampleLevel(cage, level);
  const mesh = refined<Vec3>(cage, sampled, VEC3_OPS);
  const masks = limitMasks(mesh);
  const positions: number[] = [];
  for (const mask of masks) {
    let [x, y, z] = [0, 0, 0];
    mask.idx.forEach((v, k) => {
      const p = mesh.vertices[v] as Vec3;
      const w = mask.w[k] as number;
      x += w * p[0];
      y += w * p[1];
      z += w * p[2];
    });
    positions.push(x, y, z);
  }
  const indices: number[] = [];
  for (const face of mesh.faces)
    indices.push(face[0] as number, face[1] as number, face[2] as number, face[0] as number, face[2] as number, face[3] as number);
  return { mesh: { positions, indices }, level: sampled };
}

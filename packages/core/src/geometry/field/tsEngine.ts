/**
 * Default TypeScript field engine (05 IMP TR-IMP-02): tape interpreter + interval-pruned grid sampling + marching tetrahedra (`@lib/isosurface`).
 * The runtime path without the native binary and the oracle of the native engine.
 * @invariant deterministic: same program and grid give the same samples, mesh and measures (fixed scan order, no randomness)
 * @invariant budgets are checked before any sample is evaluated (IMP_GRID_BUDGET); NaN / infinite samples count as outside and are reported
 */

import type { MeshData, Vec3 } from '../../model/types';
import { isClosedManifold } from '../../lib/isosurface/measures';
import { marchingTetrahedra } from '../../lib/isosurface/tetra';
import { dualContour } from './dualContour';
import { signComponents } from './components';
import {
  type FieldEngine,
  type FieldGrid,
  type FieldProvenance,
  type FieldRefusal,
  type FieldSamples,
  type MeasureRequest,
  type MeshOptions,
  gridCells,
} from './engineTypes';
import { evaluateWithGradient } from './gradient';
import { evaluateAt, prepareProgram } from './interpret';
import { evaluateInterval } from './interval';
import { type FieldProgram, programError } from './program';

const MAX_SAMPLES = 2 ** 21;
const MAX_TRIANGLES = 5_000_000;
const TILE = 8;
const OUTSIDE = 1e30;
/**
 * Samples closer to the surface than this fraction of a voxel are moved to +ZERO_SNAP voxels (outside): no vertex lands exactly on a grid node,
 * so no zero-area triangles. Connectivity (components) uses the closed set {f < 2 ZERO_SNAP voxel}, so bodies that only touch are one solid.
 */
const ZERO_SNAP = 1e-3;
const PHI3 = 1.2207440846057596;

const provenance = (voxel: number): FieldProvenance => ({ engine: 'ts', device: 'cpu', deterministic: true, voxel });

const refuse = (code: FieldRefusal['code'], message: string, samples?: number, limit?: number): FieldRefusal => ({
  ok: false,
  code,
  message,
  ...(samples === undefined ? {} : { samples }),
  ...(limit === undefined ? {} : { limit }),
});

function evaluate(program: FieldProgram, points: Float64Array, withGradient: boolean): FieldSamples {
  const count = Math.floor(points.length / 3);
  const values = new Float64Array(count);
  const gradients = withGradient ? new Float64Array(count * 3) : null;
  if (programError(program) !== null) return { values: values.fill(NaN), gradients: gradients?.fill(NaN) ?? null, nonFinite: count };
  const prepared = prepareProgram(program);
  const registers = new Float64Array(program.instructions.length);
  let nonFinite = 0;
  for (let p = 0; p < count; p += 1) {
    const [x, y, z] = [points[3 * p] as number, points[3 * p + 1] as number, points[3 * p + 2] as number];
    if (gradients === null) values[p] = evaluateAt(prepared, registers, x, y, z);
    else {
      const dual = evaluateWithGradient(prepared, x, y, z);
      values[p] = dual.value;
      gradients.set(dual.gradient, 3 * p);
    }
    if (!Number.isFinite(values[p])) nonFinite += 1;
  }
  return { values, gradients, nonFinite };
}

interface SampledGrid {
  readonly values: Float64Array;
  readonly nodes: [number, number, number];
  readonly evaluated: number;
  readonly nonFinite: number;
}

/** Node values of `program` on `grid`; tiles whose interval excludes 0 are filled with their sign without sampling. */
function sampleGrid(program: FieldProgram, grid: FieldGrid): SampledGrid {
  const cells = gridCells(grid);
  const nodes: [number, number, number] = [cells[0] + 1, cells[1] + 1, cells[2] + 1];
  const values = new Float64Array(nodes[0] * nodes[1] * nodes[2]);
  const prepared = prepareProgram(program);
  const registers = new Float64Array(program.instructions.length);
  const tiles = [Math.ceil(cells[0] / TILE), Math.ceil(cells[1] / TILE), Math.ceil(cells[2] / TILE)] as const;
  const at = (axis: 0 | 1 | 2, index: number): number => grid.min[axis] + index * grid.voxel;
  const done = new Uint8Array(values.length);
  const snap = ZERO_SNAP * grid.voxel;
  let evaluated = 0;
  let nonFinite = 0;
  for (let tk = 0; tk < tiles[2]; tk += 1)
    for (let tj = 0; tj < tiles[1]; tj += 1)
      for (let ti = 0; ti < tiles[0]; ti += 1) {
        const lo = [ti * TILE, tj * TILE, tk * TILE] as const;
        const hi = [Math.min(lo[0] + TILE, cells[0]), Math.min(lo[1] + TILE, cells[1]), Math.min(lo[2] + TILE, cells[2])] as const;
        const box = { min: [at(0, lo[0]), at(1, lo[1]), at(2, lo[2])] as Vec3, max: [at(0, hi[0]), at(1, hi[1]), at(2, hi[2])] as Vec3 };
        const [low, high] = evaluateInterval(prepared, box);
        const sign = high < 0 ? -OUTSIDE : low > 0 ? OUTSIDE : 0;
        for (let k = lo[2]; k <= hi[2]; k += 1)
          for (let j = lo[1]; j <= hi[1]; j += 1)
            for (let i = lo[0]; i <= hi[0]; i += 1) {
              const id = i + nodes[0] * (j + nodes[1] * k);
              if (done[id] === 1) continue;
              if (sign !== 0) {
                if (done[id] === 0) values[id] = sign;
                continue;
              }
              const value = evaluateAt(prepared, registers, at(0, i), at(1, j), at(2, k));
              evaluated += 1;
              done[id] = 1;
              if (Number.isFinite(value)) values[id] = Math.abs(value) < snap ? snap : value;
              else {
                values[id] = OUTSIDE;
                nonFinite += 1;
              }
            }
      }
  return { values, nodes, evaluated, nonFinite };
}

function mesh(program: FieldProgram, grid: FieldGrid, options: MeshOptions): ReturnType<FieldEngine['mesh']> {
  const bad = programError(program);
  if (bad !== null) return refuse('IMP_ENGINE_FAILED', `invalid field program: ${bad}`);
  const cells = gridCells(grid);
  const total = (cells[0] + 1) * (cells[1] + 1) * (cells[2] + 1);
  if (total > MAX_SAMPLES)
    return refuse('IMP_GRID_BUDGET', `${total} grid samples exceed the ts engine limit of ${MAX_SAMPLES}`, total, MAX_SAMPLES);
  const sampled = sampleGrid(program, grid);
  const prepared = prepareProgram(program);
  const contoured =
    options.mesher === 'dual_contouring'
      ? dualContour(prepared, { nodes: sampled.nodes, origin: grid.min, voxel: grid.voxel, values: sampled.values }, options.maxTriangles)
      : null;
  const extracted =
    contoured ??
    marchingTetrahedra({
      nodes: sampled.nodes,
      origin: grid.min,
      voxel: grid.voxel,
      values: sampled.values,
      threshold: 0,
      insideAbove: false,
    });
  if (extracted === null) return refuse('IMP_GRID_BUDGET', 'the grid has too many nodes for exact edge keys', total, MAX_SAMPLES);
  const triangles = extracted.indices.length / 3;
  if (triangles > options.maxTriangles)
    return refuse(
      'IMP_TRIANGLE_BUDGET',
      `${triangles} triangles exceed the budget of ${options.maxTriangles}`,
      triangles,
      options.maxTriangles,
    );
  const registers = new Float64Array(program.instructions.length);
  let residual = 0;
  for (let v = 0; v < extracted.positions.length; v += 3) {
    const value = evaluateAt(
      prepared,
      registers,
      extracted.positions[v] as number,
      extracted.positions[v + 1] as number,
      extracted.positions[v + 2] as number,
    );
    if (Number.isFinite(value)) residual = Math.max(residual, Math.abs(value));
  }
  const result: MeshData = { positions: extracted.positions, indices: extracted.indices };
  return {
    ok: true,
    mesh: result,
    closedManifold: isClosedManifold(extracted),
    samples: total,
    evaluatedSamples: sampled.evaluated,
    prunedFraction: total === 0 ? 0 : 1 - sampled.evaluated / total,
    maxVertexResidual: residual,
    nonFiniteSamples: sampled.nonFinite,
    mesher: contoured === null ? 'tetra' : 'dual_contouring',
    mesherFallback: options.mesher === 'dual_contouring' && contoured === null,
    splitCells: contoured?.splitCells ?? 0,
    provenance: provenance(grid.voxel),
  };
}

/** Sample points of the grid cell centres (`midpoint`) or the R3 sequence (`lowdiscrepancy`), same count. */
function quadraturePoints(grid: FieldGrid, sampling: 'midpoint' | 'lowdiscrepancy'): Float64Array {
  const cells = gridCells(grid);
  const count = cells[0] * cells[1] * cells[2];
  const points = new Float64Array(count * 3);
  const extent = [grid.max[0] - grid.min[0], grid.max[1] - grid.min[1], grid.max[2] - grid.min[2]] as const;
  if (sampling === 'midpoint') {
    let p = 0;
    for (let k = 0; k < cells[2]; k += 1)
      for (let j = 0; j < cells[1]; j += 1)
        for (let i = 0; i < cells[0]; i += 1) {
          points[p++] = grid.min[0] + ((i + 0.5) * extent[0]) / cells[0];
          points[p++] = grid.min[1] + ((j + 0.5) * extent[1]) / cells[1];
          points[p++] = grid.min[2] + ((k + 0.5) * extent[2]) / cells[2];
        }
    return points;
  }
  const alpha = [1 / PHI3, 1 / PHI3 ** 2, 1 / PHI3 ** 3];
  for (let n = 0; n < count; n += 1)
    for (const axis of [0, 1, 2] as const) {
      const u = (0.5 + (n + 1) * (alpha[axis] as number)) % 1;
      points[3 * n + axis] = grid.min[axis] + u * (extent[axis] as number);
    }
  return points;
}

function measure(
  program: FieldProgram,
  grid: FieldGrid,
  region: FieldProgram | null,
  request: MeasureRequest,
): ReturnType<FieldEngine['measure']> {
  const bad = programError(program) ?? (region === null ? null : programError(region));
  if (bad !== null) return refuse('IMP_ENGINE_FAILED', `invalid field program: ${bad}`);
  const cells = gridCells(grid);
  const count =
    request.kind === 'components' || request.kind === 'nodes'
      ? (cells[0] + 1) * (cells[1] + 1) * (cells[2] + 1)
      : cells[0] * cells[1] * cells[2];
  if (count > MAX_SAMPLES)
    return refuse('IMP_GRID_BUDGET', `${count} samples exceed the ts engine limit of ${MAX_SAMPLES}`, count, MAX_SAMPLES);
  if (request.kind === 'components' || request.kind === 'nodes') {
    const sampled = sampleGrid(program, grid);
    const regional = region === null ? null : sampleGrid(region, grid);
    const inside = new Uint8Array(sampled.values.length);
    const closed = 2 * ZERO_SNAP * grid.voxel;
    for (let id = 0; id < inside.length; id += 1)
      inside[id] = (sampled.values[id] ?? OUTSIDE) < closed && (regional === null || (regional.values[id] ?? OUTSIDE) < closed) ? 1 : 0;
    if (request.kind === 'nodes')
      return { ok: true, kind: 'nodes', inside, nodes: sampled.nodes, samples: count, provenance: provenance(grid.voxel) };
    const parts = signComponents(inside, sampled.nodes, grid.voxel, grid.min);
    return { ok: true, kind: 'components', ...parts, samples: count, provenance: provenance(grid.voxel) };
  }
  const points = quadraturePoints(grid, request.kind === 'volume' ? request.sampling : 'midpoint');
  const main = evaluate(program, points, false);
  if (request.kind === 'quantile') {
    const kept = Array.from(main.values, (value) => (request.absolute ? Math.abs(value) : value)).filter((value) => !Number.isNaN(value));
    const sorted = Float64Array.from(kept).sort();
    const values = request.probabilities.map(
      (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))] as number,
    );
    return { ok: true, kind: 'quantile', values, samples: count, provenance: provenance(grid.voxel) };
  }
  const clip = region === null ? null : evaluate(region, points, false);
  let solid = 0;
  let inRegion = 0;
  for (let p = 0; p < count; p += 1) {
    if (clip !== null && !((clip.values[p] as number) <= 0)) continue;
    inRegion += 1;
    if ((main.values[p] as number) <= 0) solid += 1;
  }
  const boxVolume = (grid.max[0] - grid.min[0]) * (grid.max[1] - grid.min[1]) * (grid.max[2] - grid.min[2]);
  const unit = count === 0 ? 0 : boxVolume / count;
  return {
    ok: true,
    kind: 'volume',
    volume: solid * unit,
    regionVolume: inRegion * unit,
    samples: count,
    nonFiniteSamples: main.nonFinite + (clip?.nonFinite ?? 0),
    provenance: provenance(grid.voxel),
  };
}

export const tsFieldEngine: FieldEngine = {
  name: 'ts',
  limits: { maxSamples: MAX_SAMPLES, maxTriangles: MAX_TRIANGLES },
  evaluate,
  mesh,
  measure,
};

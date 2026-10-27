/**
 * The linear systems of the cage fit (`subdFit`): the weighted two-sided least-squares round with a fairing on the cage displacement, and the exact pin
 * of the cage-vertex limit points. Matrix-free conjugate gradient over the limit operator `subd/fitOperator`. Pure; deterministic.
 */

import type { Vec3 } from '../../model/types';
import { conjugateGradient } from '../../lib/conjugateGradient';
import { type FitOperator, applyOperator, applyTranspose } from '../subd/fitOperator';

const CG_TOLERANCE = 1e-8;
const CG_MAX_ITERATIONS = 500;
/** The pin system is square and well conditioned (limit masks): it is solved to round-off. */
const PIN_TOLERANCE = 1e-13;
const PIN_MAX_ITERATIONS = 4000;

/** Closest-point data of one measured round: the rows the backward samples are written over (three limit rows and barycentric weights each). */
export interface RoundRows {
  /** Closest target point of each limit row. */
  readonly closest: Vec3[];
  readonly rowsOf: Int32Array;
  readonly weightOf: Float64Array;
}

export interface CgReport {
  readonly iterations: number;
  readonly converged: boolean;
  /** Worst final ||residual|| / ||b|| over the solves. */
  readonly relativeResidual: number;
}

export interface Solved {
  readonly cage: Float64Array[];
  readonly cg: CgReport;
  readonly ok: boolean;
}

/** (L x)_v = x_v - mean of the neighbours of v. */
function laplacian(adjacent: ReadonlyArray<ReadonlyArray<number>>, x: Float64Array, out: Float64Array): void {
  adjacent.forEach((around, v) => {
    let total = 0;
    for (const w of around) total += x[w] as number;
    out[v] = (x[v] as number) - (around.length > 0 ? total / around.length : 0);
  });
}

/** out = L^T y. */
function laplacianTranspose(adjacent: ReadonlyArray<ReadonlyArray<number>>, y: Float64Array, out: Float64Array): void {
  out.fill(0);
  adjacent.forEach((around, v) => {
    out[v] = (out[v] as number) + (y[v] as number);
    for (const w of around) out[w] = (out[w] as number) - (y[v] as number) / around.length;
  });
}

const merge = (a: CgReport, iterations: number, converged: boolean, residual: number): CgReport => ({
  iterations: a.iterations + iterations,
  converged: a.converged && converged,
  relativeResidual: Math.max(a.relativeResidual, residual),
});

export const NO_CG: CgReport = { iterations: 0, converged: true, relativeResidual: 0 };

/**
 * One weighted least-squares solve for the cage positions: forward rows `forwardTargets` (one per limit row), backward samples `samples` over the rows
 * of `round`, and the fairing alpha/N * ||L (C - start)||^2. Each of the forward and the backward group has total weight 1.
 */
export function solveRound(
  op: FitOperator,
  adjacent: ReadonlyArray<ReadonlyArray<number>>,
  current: Float64Array[],
  start: Float64Array[],
  round: RoundRows,
  samples: ReadonlyArray<Vec3>,
  smoothing: number,
): Solved {
  const n = op.cols;
  const backward = samples.length;
  const wf = 1 / op.rows;
  const wb = backward > 0 ? 1 / backward : 0;
  const alpha = smoothing / n;
  const diagonal = new Float64Array(n);
  const rowWeight = new Float64Array(op.rows).fill(wf);
  for (let j = 0; j < backward; j++)
    for (let k = 0; k < 3; k++) {
      const r = round.rowsOf[3 * j + k] as number;
      rowWeight[r] = (rowWeight[r] as number) + wb * (round.weightOf[3 * j + k] as number) ** 2;
    }
  for (let r = 0; r < op.rows; r++)
    for (let k = op.rowStart[r] as number; k < (op.rowStart[r + 1] as number); k++)
      diagonal[op.colIdx[k] as number] =
        (diagonal[op.colIdx[k] as number] as number) + (rowWeight[r] as number) * (op.value[k] as number) ** 2;
  for (let v = 0; v < n; v++) diagonal[v] = (diagonal[v] as number) + alpha * (1 + 1 / Math.max(1, (adjacent[v] as number[]).length));

  const ax = new Float64Array(op.rows);
  const qy = new Float64Array(op.rows);
  const lx = new Float64Array(n);
  const back = new Float64Array(n);
  const sampleValue = new Float64Array(backward);
  const apply = (x: Float64Array, out: Float64Array): void => {
    applyOperator(op, x, ax);
    for (let r = 0; r < op.rows; r++) qy[r] = wf * (ax[r] as number);
    for (let j = 0; j < backward; j++) {
      let value = 0;
      for (let k = 0; k < 3; k++) value += (round.weightOf[3 * j + k] as number) * (ax[round.rowsOf[3 * j + k] as number] as number);
      sampleValue[j] = value;
    }
    for (let j = 0; j < backward; j++)
      for (let k = 0; k < 3; k++) {
        const r = round.rowsOf[3 * j + k] as number;
        qy[r] = (qy[r] as number) + wb * (round.weightOf[3 * j + k] as number) * (sampleValue[j] as number);
      }
    applyTranspose(op, qy, out);
    laplacian(adjacent, x, lx);
    laplacianTranspose(adjacent, lx, back);
    for (let v = 0; v < n; v++) out[v] = (out[v] as number) + alpha * (back[v] as number);
  };
  const solution: Float64Array[] = [];
  let cg = NO_CG;
  for (let axis = 0; axis < 3; axis++) {
    const rhsRows = new Float64Array(op.rows);
    for (let r = 0; r < op.rows; r++) rhsRows[r] = wf * ((round.closest[r] as Vec3)[axis] as number);
    for (let j = 0; j < backward; j++)
      for (let k = 0; k < 3; k++) {
        const r = round.rowsOf[3 * j + k] as number;
        rhsRows[r] = (rhsRows[r] as number) + wb * (round.weightOf[3 * j + k] as number) * ((samples[j] as Vec3)[axis] as number);
      }
    const rhs = new Float64Array(n);
    applyTranspose(op, rhsRows, rhs);
    laplacian(adjacent, start[axis] as Float64Array, lx);
    laplacianTranspose(adjacent, lx, back);
    for (let v = 0; v < n; v++) rhs[v] = (rhs[v] as number) + alpha * (back[v] as number);
    const result = conjugateGradient(apply, rhs, current[axis] as Float64Array, {
      maxIterations: CG_MAX_ITERATIONS,
      tolerance: CG_TOLERANCE,
      diagonal,
    });
    cg = merge(cg, result.iterations, result.converged, result.relativeResidual);
    if (!result.x.every(Number.isFinite)) return { cage: current, cg, ok: false };
    solution.push(result.x);
  }
  return { cage: solution, cg, ok: true };
}

export interface Pinned extends Solved {
  /** Largest |limit point of a cage vertex - its pin| over the three coordinates. */
  readonly residual: number;
}

/**
 * Cage positions whose limit points at the cage vertices (the first `cols` rows of the operator) equal `pins`. The system is square (hard
 * constraints leave nothing for a fairing term to decide), solved by CG on the normal equations to round-off.
 */
export function solvePins(op: FitOperator, current: Float64Array[], pins: ReadonlyArray<Vec3>): Pinned {
  const n = op.cols;
  const rowDot = (r: number, x: Float64Array): number => {
    let total = 0;
    for (let k = op.rowStart[r] as number; k < (op.rowStart[r + 1] as number); k++)
      total += (op.value[k] as number) * (x[op.colIdx[k] as number] as number);
    return total;
  };
  const transposeOf = (y: Float64Array, out: Float64Array): void => {
    out.fill(0);
    for (let r = 0; r < n; r++)
      for (let k = op.rowStart[r] as number; k < (op.rowStart[r + 1] as number); k++)
        out[op.colIdx[k] as number] = (out[op.colIdx[k] as number] as number) + (op.value[k] as number) * (y[r] as number);
  };
  const diagonal = new Float64Array(n);
  for (let r = 0; r < n; r++)
    for (let k = op.rowStart[r] as number; k < (op.rowStart[r + 1] as number); k++)
      diagonal[op.colIdx[k] as number] = (diagonal[op.colIdx[k] as number] as number) + (op.value[k] as number) ** 2;
  const y = new Float64Array(n);
  const apply = (x: Float64Array, out: Float64Array): void => {
    for (let r = 0; r < n; r++) y[r] = rowDot(r, x);
    transposeOf(y, out);
  };
  const solution: Float64Array[] = [];
  let cg = NO_CG;
  let residual = 0;
  for (let axis = 0; axis < 3; axis++) {
    const target = Float64Array.from(pins, (p) => p[axis] as number);
    const rhs = new Float64Array(n);
    transposeOf(target, rhs);
    const result = conjugateGradient(apply, rhs, current[axis] as Float64Array, {
      maxIterations: PIN_MAX_ITERATIONS,
      tolerance: PIN_TOLERANCE,
      diagonal,
    });
    cg = merge(cg, result.iterations, result.converged, result.relativeResidual);
    if (!result.x.every(Number.isFinite)) return { cage: current, cg, ok: false, residual: Infinity };
    for (let r = 0; r < n; r++) residual = Math.max(residual, Math.abs(rowDot(r, result.x) - (target[r] as number)));
    solution.push(result.x);
  }
  return { cage: solution, cg, ok: true, residual };
}

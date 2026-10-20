import { addAt, at, solveLinear } from './linalg';
import { cost, jacobian, residualVector, type Problem, type SparseRow } from './problem';

export interface LmResult {
  readonly x: Float64Array;
  /** Sum of squared residuals at `x`. */
  readonly cost: number;
  readonly iterations: number;
}

export interface LmOptions {
  /** Stop when the sum of squared residuals is below this. */
  readonly costTarget: number;
  /** Starting damping; larger values take shorter, safer steps. */
  readonly lambda?: number;
}

const MAX_ITERATIONS = 100;
/** Above this many unknowns the damped normal equations are solved matrix-free (sparse conjugate gradients) instead of by elimination. */
const DENSE_LIMIT = 64;

/** Solve `(JᵀJ + λI) δ = -g` by Jacobi-preconditioned conjugate gradients over sparse rows (inexact: relative residual about 1e-5). */
function conjugateStep(rows: readonly SparseRow[], gradient: Float64Array, lambda: number, n: number): Float64Array | null {
  const diagonal = new Float64Array(n).fill(lambda);
  for (const row of rows) for (let p = 0; p < row.idx.length; p++) addAt(diagonal, row.idx[p] as number, (row.val[p] as number) ** 2);
  const x = new Float64Array(n);
  const r = new Float64Array(n);
  const z = new Float64Array(n);
  const p = new Float64Array(n);
  const q = new Float64Array(n);
  let rz = 0;
  for (let i = 0; i < n; i++) {
    r[i] = -(gradient[i] as number);
    z[i] = (r[i] as number) / (diagonal[i] as number);
    p[i] = z[i] as number;
    rz += (r[i] as number) * (z[i] as number);
  }
  const stop = 1e-10 * rz;
  for (let iteration = 0; iteration < 2 * n && rz > stop; iteration++) {
    for (let i = 0; i < n; i++) q[i] = lambda * (p[i] as number);
    for (const row of rows) {
      const idx = row.idx;
      const val = row.val;
      let along = 0;
      for (let k = 0; k < idx.length; k++) along += (val[k] as number) * (p[idx[k] as number] as number);
      if (along === 0) continue;
      for (let k = 0; k < idx.length; k++) addAt(q, idx[k] as number, (val[k] as number) * along);
    }
    let pq = 0;
    for (let i = 0; i < n; i++) pq += (p[i] as number) * (q[i] as number);
    if (!(pq > 0)) break;
    const alpha = rz / pq;
    let next = 0;
    for (let i = 0; i < n; i++) {
      addAt(x, i, alpha * (p[i] as number));
      addAt(r, i, -(alpha * (q[i] as number)));
      z[i] = (r[i] as number) / (diagonal[i] as number);
      next += (r[i] as number) * (z[i] as number);
    }
    const beta = next / rz;
    for (let i = 0; i < n; i++) p[i] = (z[i] as number) + beta * (p[i] as number);
    rz = next;
  }
  return x.every(Number.isFinite) ? x : null;
}

/**
 * Damped Gauss–Newton (Levenberg–Marquardt, identity damping so unconstrained directions keep their length) over the active variables.
 * Rank-deficient systems are fine: the damping gives the minimum-norm step.
 */
export function levenbergMarquardt(problem: Problem, start: Float64Array, options: LmOptions): LmResult {
  const n = problem.active.length;
  let x = Float64Array.from(start);
  let current = cost(problem, x);
  let lambda = options.lambda ?? 1e-6;
  let iterations = 0;
  if (n === 0) return { x, cost: current, iterations };
  for (; iterations < MAX_ITERATIONS && current > options.costTarget; iterations++) {
    const residual = residualVector(problem, x);
    const rows = jacobian(problem, x);
    const gradient = new Float64Array(n);
    const dense = n <= DENSE_LIMIT;
    const hessian = new Float64Array(dense ? n * n : 0);
    rows.forEach((row, index) => {
      const r = at(residual, index);
      row.idx.forEach((i, p) => {
        const ji = at(row.val, p);
        gradient[i] = at(gradient, i) + ji * r;
        if (dense)
          row.idx.forEach((k, q) => {
            hessian[i * n + k] = at(hessian, i * n + k) + ji * at(row.val, q);
          });
      });
    });
    if (gradient.every((g) => Math.abs(g) < 1e-12 * (1 + current))) break;
    let accepted = false;
    for (let attempt = 0; attempt < 24 && !accepted; attempt++) {
      let step: Float64Array | null;
      if (dense) {
        const damped = Float64Array.from(hessian);
        for (let i = 0; i < n; i++) damped[i * n + i] = at(hessian, i * n + i) + lambda;
        step = solveLinear(
          damped,
          gradient.map((g) => -g),
          n,
        );
      } else step = conjugateStep(rows, gradient, lambda, n);
      if (!step) {
        lambda *= 10;
        continue;
      }
      const candidate = Float64Array.from(x);
      problem.active.forEach((variable, column) => {
        candidate[variable] = at(x, variable) + at(step, column);
      });
      const candidateCost = cost(problem, candidate);
      if (candidateCost < current) {
        x = candidate;
        current = candidateCost;
        lambda = Math.max(lambda / 3, 1e-12);
        accepted = true;
      } else lambda *= 4;
    }
    if (!accepted) break;
  }
  return { x, cost: current, iterations };
}

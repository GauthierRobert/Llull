import { at, solveLinear } from '../parametric/solver/linalg';

export interface LoopSolution {
  readonly x: number[];
  /** Euclidean norm of the residual at `x`. */
  readonly norm: number;
}

const MAX_ITERATIONS = 80;
const STEP = 1e-7;

const norm = (r: readonly number[]): number => Math.sqrt(r.reduce((sum, v) => sum + v * v, 0));

/** Finite-difference Jacobian of `f` at `x` (rows = residuals). */
function jacobian(f: (x: number[]) => number[], x: number[], r0: readonly number[]): number[][] {
  const columns = x.map((xi, i) => {
    const h = STEP * (1 + Math.abs(xi));
    const shifted = x.map((v, k) => (k === i ? v + h : v));
    return f(shifted).map((v, row) => (v - (r0[row] ?? 0)) / h);
  });
  return r0.map((_, row) => columns.map((column) => column[row] ?? 0));
}

/** Levenberg–Marquardt on `f(x) = 0` from `x0` (rank-deficient loops, e.g. planar ones, are fine: damping gives the minimum-norm step). */
function levenbergMarquardt(f: (x: number[]) => number[], x0: number[], tolerance: number): LoopSolution {
  let x = x0;
  let r = f(x);
  let lambda = 1e-3;
  for (let iteration = 0; iteration < MAX_ITERATIONS && norm(r) > tolerance; iteration++) {
    const jac = jacobian(f, x, r);
    const n = x.length;
    const hessian = new Float64Array(n * n);
    const gradient = new Float64Array(n);
    jac.forEach((row, k) => {
      for (let i = 0; i < n; i++) {
        gradient[i] = at(gradient, i) + (row[i] ?? 0) * (r[k] ?? 0);
        for (let j = 0; j < n; j++) hessian[i * n + j] = at(hessian, i * n + j) + (row[i] ?? 0) * (row[j] ?? 0);
      }
    });
    let accepted = false;
    for (let attempt = 0; attempt < 30 && !accepted; attempt++) {
      const damped = Float64Array.from(hessian);
      for (let i = 0; i < n; i++) damped[i * n + i] = at(hessian, i * n + i) + lambda;
      const step = solveLinear(
        damped,
        gradient.map((g) => -g),
        n,
      );
      const candidate = step === null ? null : x.map((v, i) => v + at(step, i));
      const next = candidate === null ? null : f(candidate);
      if (candidate !== null && next !== null && norm(next) < norm(r)) {
        x = candidate;
        r = next;
        lambda = Math.max(lambda / 5, 1e-12);
        accepted = true;
      } else lambda *= 5;
    }
    if (!accepted) break;
  }
  return { x, norm: norm(r) };
}

/** Deterministic spread of starting points around `x0` (angles over the circle, others scaled by `scale`). */
function restarts(x0: readonly number[], angular: readonly boolean[], scale: number): number[][] {
  let seed = 12345;
  const random = (): number => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  return Array.from({ length: 40 }, () =>
    x0.map((v, i) => (angular[i] === true ? (random() * 2 - 1) * Math.PI : v + (random() * 2 - 1) * scale)),
  );
}

/**
 * Root of the loop-closure residual `f` nearest to `x0` (assembly branch kept by continuation), else the best of 40 deterministic restarts.
 * @failure no start reaches `tolerance` -> `norm` > tolerance (the loop cannot close)
 */
export function solveLoop(
  f: (x: number[]) => number[],
  x0: number[],
  angular: readonly boolean[],
  scale: number,
  tolerance: number,
): LoopSolution {
  let best = levenbergMarquardt(f, x0, tolerance);
  if (best.norm <= tolerance) return best;
  for (const start of restarts(x0, angular, scale)) {
    const candidate = levenbergMarquardt(f, start, tolerance);
    if (candidate.norm < best.norm) best = candidate;
    if (best.norm <= tolerance) break;
  }
  return best;
}

import { at, solveLinear } from './linalg';
import { cost, jacobian, type Problem } from './problem';

export interface LmResult {
  readonly x: Float64Array;
  /** Sum of squared residuals at `x`. */
  readonly cost: number;
  readonly iterations: number;
}

const MAX_ITERATIONS = 100;
const COST_TARGET = 1e-22;

/**
 * Damped Gauss–Newton (Levenberg–Marquardt, identity damping, so unconstrained directions keep their length) over the active variables. Rank-deficient systems are fine: the
 * damping gives the minimum-norm step, so unconstrained directions stay where they are.
 */
export function levenbergMarquardt(problem: Problem, start: Float64Array): LmResult {
  const n = problem.active.length;
  let x = Float64Array.from(start);
  let current = cost(problem, x);
  let lambda = 1e-6;
  let iterations = 0;
  if (n === 0) return { x, cost: current, iterations };
  const residual = new Float64Array(problem.rows);
  for (; iterations < MAX_ITERATIONS && current > COST_TARGET; iterations++) {
    problem.compiled.forEach((c, index) => c.evaluate(x, residual, at(problem.rowStart, index)));
    const jac = jacobian(problem, x);
    const gradient = new Float64Array(n);
    const hessian = new Float64Array(n * n);
    for (let row = 0; row < problem.rows; row++) {
      const r = at(residual, row);
      for (let i = 0; i < n; i++) {
        const ji = at(jac, row * n + i);
        if (ji === 0) continue;
        gradient[i] = at(gradient, i) + ji * r;
        for (let k = 0; k < n; k++) hessian[i * n + k] = at(hessian, i * n + k) + ji * at(jac, row * n + k);
      }
    }
    if (gradient.every((g) => Math.abs(g) < 1e-15)) break;
    let accepted = false;
    for (let attempt = 0; attempt < 24 && !accepted; attempt++) {
      const damped = Float64Array.from(hessian);
      for (let i = 0; i < n; i++) damped[i * n + i] = at(hessian, i * n + i) + lambda;
      const step = solveLinear(
        damped,
        gradient.map((g) => -g),
        n,
      );
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

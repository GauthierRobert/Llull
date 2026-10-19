/**
 * Levenberg-Marquardt with Marquardt diagonal scaling and box bounds (PHY-02 §5.7, V2): classic damping λ0 = 1e-3, ×10 on a rejected step,
 * ÷10 on an accepted one; stop on a relative cost change < 1e-12 or 500 iterations. Central-difference Jacobian; steps are projected on
 * the bounds. Deterministic: no randomness, fixed evaluation order. Reports the conditioning of the scaled Jacobian at the solution.
 */

import { solveLeastSquares } from '../../lib/leastSquares';
import { solveLinear } from './linalg';

export type LmStop = 'cost_change' | 'exact' | 'gradient' | 'no_descent' | 'invalid_probe' | 'max_iterations' | 'invalid_start';

export interface LmOptions {
  readonly lower: readonly number[];
  readonly upper: readonly number[];
  readonly maxIterations?: number;
}

export interface LmResult {
  readonly params: readonly number[];
  /** ½ Σ r². */
  readonly cost: number;
  readonly iterations: number;
  readonly evaluations: number;
  readonly converged: boolean;
  readonly stop: LmStop;
  /** Condition number of the Jacobian with unit-diagonal column scaling (Infinity when rank deficient). */
  readonly conditionNumber: number;
  readonly finalDamping: number;
}

export const LM_DEFAULTS = { initialDamping: 1e-3, relativeCostTolerance: 1e-12, maxIterations: 500, exactCost: 1e-30 } as const;

export type Residuals = (params: readonly number[]) => number[] | null;

const halfSumSquares = (r: readonly number[]): number => 0.5 * r.reduce((sum, value) => sum + value * value, 0);

const clamp = (value: number, lower: number, upper: number): number => Math.min(upper, Math.max(lower, value));

/** Central-difference Jacobian (rows = residuals, columns = parameters); one-sided at a bound; null when a probe is invalid. */
function jacobian(residuals: Residuals, params: readonly number[], options: LmOptions, count: { evaluations: number }): number[][] | null {
  const columns: number[][] = [];
  for (let j = 0; j < params.length; j += 1) {
    const h = 1e-6 * Math.max(Math.abs(params[j] ?? 0), 1e-2);
    const high = Math.min((params[j] ?? 0) + h, options.upper[j] ?? Number.POSITIVE_INFINITY);
    const low = Math.max((params[j] ?? 0) - h, options.lower[j] ?? Number.NEGATIVE_INFINITY);
    if (high === low) {
      columns.push([]);
      continue;
    }
    const at = (value: number): number[] | null => {
      count.evaluations += 1;
      return residuals(params.map((p, k) => (k === j ? value : p)));
    };
    const plus = at(high);
    const minus = at(low);
    if (plus === null || minus === null) return null;
    columns.push(plus.map((value, i) => (value - (minus[i] ?? 0)) / (high - low)));
  }
  const rows = columns.find((column) => column.length > 0)?.length ?? 0;
  return Array.from({ length: rows }, (_, i) => columns.map((column) => column[i] ?? 0));
}

const gram = (j: readonly (readonly number[])[], n: number): number[][] =>
  Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => j.reduce((sum, row) => sum + (row[a] ?? 0) * (row[b] ?? 0), 0)));

/** Condition estimate max|R_ii|/min|R_ii| of the column-equilibrated Jacobian (Householder QR); Infinity when rank deficient. */
function scaledConditionNumber(j: readonly (readonly number[])[]): number {
  return solveLeastSquares(j, new Array<number>(j.length).fill(0)).conditionEstimate;
}

/**
 * Minimise ½‖r(p)‖² from `start`.
 * @failure invalid residuals at the start -> stop 'invalid_start' (converged false); 500 iterations -> stop 'max_iterations' (converged false)
 */
export function levenbergMarquardt(residuals: Residuals, start: readonly number[], options: LmOptions): LmResult {
  const n = start.length;
  const maxIterations = options.maxIterations ?? LM_DEFAULTS.maxIterations;
  const count = { evaluations: 1 };
  const lowerAt = (k: number): number => options.lower[k] ?? Number.NEGATIVE_INFINITY;
  const upperAt = (k: number): number => options.upper[k] ?? Number.POSITIVE_INFINITY;
  let params = start.map((value, k) => clamp(value, lowerAt(k), upperAt(k)));
  let r = residuals(params);
  if (r === null)
    return {
      params,
      cost: Number.POSITIVE_INFINITY,
      iterations: 0,
      evaluations: count.evaluations,
      converged: false,
      stop: 'invalid_start',
      conditionNumber: Number.POSITIVE_INFINITY,
      finalDamping: LM_DEFAULTS.initialDamping,
    };
  let cost = halfSumSquares(r);
  let damping: number = LM_DEFAULTS.initialDamping;
  let stop: LmStop = 'max_iterations';
  let iterations = 0;
  let lastJ: number[][] = [];
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    iterations = iteration;
    if (cost <= LM_DEFAULTS.exactCost) {
      stop = 'exact';
      break;
    }
    const j = jacobian(residuals, params, options, count);
    if (j === null) {
      stop = 'invalid_probe';
      break;
    }
    lastJ = j;
    const a = gram(j, n);
    const current = r;
    const g = Array.from({ length: n }, (_, c) => j.reduce((sum, row, i) => sum + (row[c] ?? 0) * (current[i] ?? 0), 0));
    if (Math.max(...g.map(Math.abs)) <= 1e-15 * Math.max(1, Math.sqrt(2 * cost))) {
      stop = 'gradient';
      break;
    }
    let accepted = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const damped = a.map((row, i) => row.map((value, k) => (i === k ? value + damping * Math.max(value, 1e-12) : value)));
      const step = solveLinear(
        damped,
        g.map((value) => -value),
      );
      const trial = step === null ? null : params.map((p, k) => clamp(p + (step[k] ?? 0), lowerAt(k), upperAt(k)));
      const trialR = trial === null ? null : residuals(trial);
      count.evaluations += 1;
      const trialCost = trialR === null ? Number.POSITIVE_INFINITY : halfSumSquares(trialR);
      if (trial !== null && trialR !== null && trialCost < cost) {
        const change = (cost - trialCost) / Math.max(cost, Number.MIN_VALUE);
        params = trial;
        r = trialR;
        cost = trialCost;
        damping = Math.max(damping / 10, 1e-12);
        accepted = true;
        if (change < LM_DEFAULTS.relativeCostTolerance) stop = 'cost_change';
        break;
      }
      damping = Math.min(damping * 10, 1e16);
    }
    if (!accepted) {
      stop = 'no_descent';
      break;
    }
    if (stop === 'cost_change') break;
  }
  const rowsJ = lastJ.length > 0 ? lastJ : (jacobian(residuals, params, options, count) ?? []);
  return {
    params,
    cost,
    iterations,
    evaluations: count.evaluations,
    converged: stop !== 'max_iterations' && stop !== 'invalid_probe',
    stop,
    conditionNumber: rowsJ.length > 0 ? scaledConditionNumber(rowsJ) : Number.POSITIVE_INFINITY,
    finalDamping: damping,
  };
}

/** Quadratic response surface in the standard normal space with its leave-one-out residual (PRESS via the hat matrix). Pure. */

import { invertDense } from '@lib/denseLinalg';

export interface QuadraticSurface {
  readonly dimension: number;
  /** Coefficients of [1, u_1..u_d, u_i u_j (i <= j)] in that order. */
  readonly coefficients: readonly number[];
  readonly evaluate: (u: readonly number[]) => number;
  /** 1 - SSE / SST of the fit on the design points. */
  readonly rSquared: number;
  /** Leave-one-out root-mean-square error, in the unit of the response. */
  readonly looRmse: number;
  /** Largest diagonal of the hat matrix (1 = one point alone determines its own fit). */
  readonly maxLeverage: number;
}

/** Number of terms of a full quadratic in `dimension` variables. */
export const quadraticTerms = (dimension: number): number => ((dimension + 1) * (dimension + 2)) / 2;

const at = (values: readonly number[], i: number): number => values[i] ?? 0;

function basis(u: readonly number[]): number[] {
  const terms = [1, ...u];
  for (let i = 0; i < u.length; i += 1) for (let j = i; j < u.length; j += 1) terms.push((u[i] ?? Number.NaN) * (u[j] ?? Number.NaN));
  return terms;
}

/**
 * Least-squares full quadratic through (points[k], values[k]) by the normal equations, with the leave-one-out residual e_k / (1 - h_kk).
 * @invariant exact (rSquared 1, looRmse ~ 0) when the response is itself quadratic and points exceed the term count
 * @failure fewer points than terms, or a singular design -> null
 */
export function fitQuadraticSurface(points: readonly (readonly number[])[], values: readonly number[]): QuadraticSurface | null {
  const dimension = (points[0] ?? []).length;
  const rows = points.map(basis);
  const terms = quadraticTerms(dimension);
  if (dimension === 0 || rows.length <= terms) return null;
  const normal = Array.from({ length: terms }, (_, a) =>
    Array.from({ length: terms }, (_, b) => rows.reduce((sum, row) => sum + at(row, a) * at(row, b), 0)),
  );
  const inverse = invertDense(normal);
  if (inverse === null) return null;
  const moment = Array.from({ length: terms }, (_, a) => rows.reduce((sum, row, k) => sum + at(row, a) * at(values, k), 0));
  const coefficients = inverse.map((line) => line.reduce((sum, c, b) => sum + c * (moment[b] ?? 0), 0));
  const evaluate = (u: readonly number[]): number => basis(u).reduce((sum, t, i) => sum + t * (coefficients[i] ?? 0), 0);
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  let sse = 0;
  let sst = 0;
  let press = 0;
  let maxLeverage = 0;
  rows.forEach((row, k) => {
    const residual = at(values, k) - row.reduce((sum, t, i) => sum + t * at(coefficients, i), 0);
    const leverage = row.reduce((sum, t, a) => sum + t * (inverse[a] ?? []).reduce((inner, c, b) => inner + c * (row[b] ?? 0), 0), 0);
    sse += residual * residual;
    sst += ((values[k] ?? 0) - mean) ** 2;
    press += (residual / (1 - leverage)) ** 2;
    maxLeverage = Math.max(maxLeverage, leverage);
  });
  return { dimension, coefficients, evaluate, rSquared: sst > 0 ? 1 - sse / sst : 1, looRmse: Math.sqrt(press / rows.length), maxLeverage };
}

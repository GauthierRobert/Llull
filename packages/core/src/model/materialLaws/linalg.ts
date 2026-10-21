/** Small dense linear algebra for the constitutive kernels: Gauss elimination with partial pivoting and a pivot-checked LDLᵀ. */

import { invertDense, solveDense } from '../../lib/denseLinalg';

export type Matrix = number[][];

/** Solve A x = b (A square); null when A is singular. Inputs are not modified. */
export function solveLinear(a: readonly (readonly number[])[], b: readonly number[]): number[] | null {
  return solveDense(a, b);
}

/** Inverse of a square matrix (column by column); null when singular. */
export function invertMatrix(a: readonly (readonly number[])[]): Matrix | null {
  return invertDense(a);
}

export interface PivotReport {
  readonly positiveDefinite: boolean;
  readonly pivots: readonly number[];
  /** Index of the first pivot at or below the floor, or null. */
  readonly failingPivot: number | null;
  readonly floor: number;
}

/**
 * Symmetric LDLᵀ without pivoting: positive definite ⇔ every pivot > floor (relative floor 1e-12 · max |A_ii|, TECHNICAL_SPEC §5.1).
 * Stops at the first failing pivot.
 */
export function pivotReport(a: readonly (readonly number[])[], relativeFloor = 1e-12): PivotReport {
  const n = a.length;
  const floor = relativeFloor * Math.max(...a.map((row, i) => Math.abs(row[i] ?? 0)), Number.MIN_VALUE);
  const lower: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const pivots: number[] = [];
  for (let k = 0; k < n; k += 1) {
    let d = a[k]?.[k] ?? 0;
    for (let j = 0; j < k; j += 1) d -= (lower[k]?.[j] ?? 0) ** 2 * (pivots[j] ?? 0);
    pivots.push(d);
    if (!(d > floor)) return { positiveDefinite: false, pivots, failingPivot: k, floor };
    for (let i = k + 1; i < n; i += 1) {
      let value = a[i]?.[k] ?? 0;
      for (let j = 0; j < k; j += 1) value -= (lower[i]?.[j] ?? 0) * (lower[k]?.[j] ?? 0) * (pivots[j] ?? 0);
      const row = lower[i];
      if (row !== undefined) row[k] = value / d;
    }
  }
  return { positiveDefinite: true, pivots, failingPivot: null, floor };
}

export const matVec = (a: readonly (readonly number[])[], x: readonly number[]): number[] =>
  a.map((row) => row.reduce((sum, value, j) => sum + value * (x[j] ?? 0), 0));

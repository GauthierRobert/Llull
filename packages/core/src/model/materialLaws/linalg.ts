/** Small dense linear algebra for the constitutive kernels: Gauss elimination with partial pivoting and a pivot-checked LDLᵀ. */

export type Matrix = number[][];

/** Solve A x = b (A square); null when A is singular. Inputs are not modified. */
export function solveLinear(a: readonly (readonly number[])[], b: readonly number[]): number[] | null {
  const n = b.length;
  const m: number[][] = a.map((row, i) => [...row, b[i] ?? 0]);
  for (let c = 0; c < n; c += 1) {
    let pivot = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(m[r]?.[c] ?? 0) > Math.abs(m[pivot]?.[c] ?? 0)) pivot = r;
    const pivotRow = m[pivot];
    const head = m[c];
    if (pivotRow === undefined || head === undefined) return null;
    const diagonal = pivotRow[c] ?? 0;
    if (Math.abs(diagonal) < 1e-300) return null;
    m[c] = pivotRow;
    m[pivot] = head;
    for (let r = c + 1; r < n; r += 1) {
      const row = m[r];
      if (row === undefined) return null;
      const factor = (row[c] ?? 0) / diagonal;
      if (factor !== 0) for (let k = c; k <= n; k += 1) row[k] = (row[k] ?? 0) - factor * (pivotRow[k] ?? 0);
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r -= 1) {
    const row = m[r];
    if (row === undefined) return null;
    let sum = row[n] ?? 0;
    for (let k = r + 1; k < n; k += 1) sum -= (row[k] ?? 0) * (x[k] ?? 0);
    x[r] = sum / (row[r] ?? 1);
  }
  return x;
}

/** Inverse of a square matrix (column by column); null when singular. */
export function invertMatrix(a: readonly (readonly number[])[]): Matrix | null {
  const n = a.length;
  const columns: number[][] = [];
  for (let j = 0; j < n; j += 1) {
    const column = solveLinear(
      a,
      Array.from({ length: n }, (_, i) => (i === j ? 1 : 0)),
    );
    if (column === null) return null;
    columns.push(column);
  }
  return Array.from({ length: n }, (_, i) => columns.map((column) => column[i] ?? 0));
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

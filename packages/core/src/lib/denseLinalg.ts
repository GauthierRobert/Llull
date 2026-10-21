/**
 * Dense linear algebra on row-major `Float64Array`: LU with partial pivoting (factor once, solve many right-hand sides), square solve,
 * inverse and Cholesky. Elimination order is the textbook Doolittle order, so one right-hand side gives the same bits as augmented
 * Gaussian elimination. Each caller states its own `pivotTolerance` (absolute pivot magnitude below which a matrix is singular).
 */

/** Pivot magnitude below which the matrix is singular, unless the caller states another. */
const DEFAULT_PIVOT_TOLERANCE = 1e-300;

export interface LuFactors {
  readonly n: number;
  /** L (unit diagonal, below) and U (on and above the diagonal), row-major, rows already permuted. */
  readonly lu: Float64Array;
  /** Row exchanged with row c at elimination step c. */
  readonly pivots: Int32Array;
}

/**
 * Factorises the n × n row-major matrix `a` (copied, not modified).
 * @failure a pivot whose magnitude is not >= `pivotTolerance` (singular matrix, or NaN) -> null
 */
export function luFactor(a: ArrayLike<number>, n: number, pivotTolerance: number = DEFAULT_PIVOT_TOLERANCE): LuFactors | null {
  const lu = Float64Array.from(a);
  const pivots = new Int32Array(n);
  for (let c = 0; c < n; c += 1) {
    let pivot = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(lu[r * n + c] as number) > Math.abs(lu[pivot * n + c] as number)) pivot = r;
    pivots[c] = pivot;
    if (pivot !== c) {
      for (let k = 0; k < n; k += 1) {
        const t = lu[c * n + k] as number;
        lu[c * n + k] = lu[pivot * n + k] as number;
        lu[pivot * n + k] = t;
      }
    }
    const diagonal = lu[c * n + c] as number;
    if (!(Math.abs(diagonal) >= pivotTolerance)) return null;
    for (let r = c + 1; r < n; r += 1) {
      const factor = (lu[r * n + c] as number) / diagonal;
      lu[r * n + c] = factor;
      if (factor !== 0) for (let k = c + 1; k < n; k += 1) lu[r * n + k] = (lu[r * n + k] as number) - factor * (lu[c * n + k] as number);
    }
  }
  return { n, lu, pivots };
}

/** x with A x = b for the factorised A (missing entries of `b` read 0). */
export function luSolve({ n, lu, pivots }: LuFactors, b: ArrayLike<number>): Float64Array {
  const x = Float64Array.from({ length: n }, (_, i) => b[i] ?? 0);
  for (let c = 0; c < n; c += 1) {
    const pivot = pivots[c] as number;
    const t = x[c] as number;
    x[c] = x[pivot] as number;
    x[pivot] = t;
  }
  for (let c = 0; c < n; c += 1) {
    const xc = x[c] as number;
    for (let r = c + 1; r < n; r += 1) {
      const factor = lu[r * n + c] as number;
      if (factor !== 0) x[r] = (x[r] as number) - factor * xc;
    }
  }
  for (let r = n - 1; r >= 0; r -= 1) {
    let sum = x[r] as number;
    for (let k = r + 1; k < n; k += 1) sum -= (lu[r * n + k] as number) * (x[k] as number);
    x[r] = sum / (lu[r * n + r] as number);
  }
  return x;
}

const flatten = (rows: readonly (readonly number[])[], n: number): Float64Array => {
  const flat = new Float64Array(n * n);
  rows.forEach((row, i) => row.forEach((value, j) => void (j < n && i < n && (flat[i * n + j] = value))));
  return flat;
};

/** Solve A x = b for a square A given as rows; null when singular. Inputs are not modified. */
export function solveDense(
  a: readonly (readonly number[])[],
  b: readonly number[],
  pivotTolerance: number = DEFAULT_PIVOT_TOLERANCE,
): number[] | null {
  const factors = luFactor(flatten(a, b.length), b.length, pivotTolerance);
  return factors === null ? null : Array.from(luSolve(factors, b));
}

/** Inverse of a square matrix, column by column from one factorisation; null when singular. */
export function invertDense(a: readonly (readonly number[])[], pivotTolerance: number = DEFAULT_PIVOT_TOLERANCE): number[][] | null {
  const n = a.length;
  const factors = luFactor(flatten(a, n), n, pivotTolerance);
  if (factors === null) return null;
  const columns = Array.from({ length: n }, (_, j) =>
    luSolve(
      factors,
      Array.from({ length: n }, (_, i) => (i === j ? 1 : 0)),
    ),
  );
  return Array.from({ length: n }, (_, i) => columns.map((column) => column[i] ?? 0));
}

/**
 * Lower Cholesky factor L (A = L Lᵀ) of a symmetric matrix.
 * @failure a diagonal term not > `diagonalFloor` (not positive definite) -> null
 */
export function cholesky(matrix: readonly (readonly number[])[], diagonalFloor = 1e-12): number[][] | null {
  const n = matrix.length;
  const lower = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    const row = lower[i] as number[];
    for (let j = 0; j <= i; j += 1) {
      let sum = matrix[i]?.[j] ?? 0;
      for (let k = 0; k < j; k += 1) sum -= (row[k] ?? 0) * (lower[j]?.[k] ?? 0);
      if (i === j) {
        if (!(sum > diagonalFloor)) return null;
        row[j] = Math.sqrt(sum);
      } else row[j] = sum / (lower[j]?.[j] ?? 1);
    }
  }
  return lower;
}

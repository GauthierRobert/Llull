/**
 * Dense LU factorisation with partial pivoting on a row-major `Float64Array` (Doolittle, the elimination order of
 * `@core/model/materialLaws/linalg` `solveLinear`, so one right-hand side gives the same bits), factorised once and reused for any number
 * of right-hand sides (RS1 §5: the panel method solves two).
 */

export interface LuFactors {
  readonly n: number;
  /** L (unit diagonal, below) and U (on and above the diagonal), row-major, rows already permuted. */
  readonly lu: Float64Array;
  /** Row exchanged with row c at elimination step c. */
  readonly pivots: Int32Array;
}

/**
 * Factorises the n × n row-major matrix `a` (copied, not modified).
 * @failure a pivot below 1e-300 in magnitude (singular matrix) -> null
 */
export function luFactor(a: Float64Array, n: number): LuFactors | null {
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
    if (!(Math.abs(diagonal) >= 1e-300)) return null;
    for (let r = c + 1; r < n; r += 1) {
      const factor = (lu[r * n + c] as number) / diagonal;
      lu[r * n + c] = factor;
      if (factor !== 0) for (let k = c + 1; k < n; k += 1) lu[r * n + k] = (lu[r * n + k] as number) - factor * (lu[c * n + k] as number);
    }
  }
  return { n, lu, pivots };
}

/** x with A x = b for the factorised A. */
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

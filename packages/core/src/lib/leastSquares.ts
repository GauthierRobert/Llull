/**
 * Weighted linear least squares by Householder QR (no column pivoting, deterministic order). Columns are equilibrated (divided by their
 * largest magnitude) before the factorisation; the condition estimate is max|R_ii| / min|R_ii| of the equilibrated system.
 */

export interface LeastSquaresSolution {
  readonly coefficients: readonly number[];
  readonly conditionEstimate: number;
}

/** Solve min Σ w_i (A_i · c − b_i)²; `rows` are the design-matrix rows. @failure rank-deficient -> conditionEstimate Infinity */
export function solveLeastSquares(
  rows: readonly (readonly number[])[],
  rhs: readonly number[],
  weights?: readonly number[],
): LeastSquaresSolution {
  const m = rows.length;
  const n = rows[0]?.length ?? 0;
  const sqrtW = rows.map((_, i) => Math.sqrt(weights?.[i] ?? 1));
  const a = rows.map((row, i) => row.map((value) => value * (sqrtW[i] ?? 1)));
  const b = rhs.map((value, i) => value * (sqrtW[i] ?? 1));
  const scale = Array.from({ length: n }, (_, j) => Math.max(...a.map((row) => Math.abs(row[j] ?? 0))) || 1);
  for (const row of a) for (let j = 0; j < n; j += 1) row[j] = (row[j] ?? 0) / (scale[j] ?? 1);
  const at = (i: number, j: number): number => a[i]?.[j] ?? 0;
  const set = (i: number, j: number, value: number): void => {
    const row = a[i];
    if (row !== undefined) row[j] = value;
  };
  for (let k = 0; k < n; k += 1) {
    let norm = 0;
    for (let i = k; i < m; i += 1) norm += at(i, k) ** 2;
    norm = Math.sqrt(norm);
    if (norm === 0) continue;
    const alpha = at(k, k) > 0 ? -norm : norm;
    const v = Array.from({ length: m - k }, (_, i) => at(k + i, k));
    v[0] = (v[0] ?? 0) - alpha;
    const vNorm2 = v.reduce((sum, x) => sum + x * x, 0);
    if (vNorm2 === 0) continue;
    for (let j = k; j < n; j += 1) {
      let dot = 0;
      for (let i = 0; i < v.length; i += 1) dot += (v[i] ?? 0) * at(k + i, j);
      const factor = (2 * dot) / vNorm2;
      for (let i = 0; i < v.length; i += 1) set(k + i, j, at(k + i, j) - factor * (v[i] ?? 0));
    }
    let dotB = 0;
    for (let i = 0; i < v.length; i += 1) dotB += (v[i] ?? 0) * (b[k + i] ?? 0);
    const factorB = (2 * dotB) / vNorm2;
    for (let i = 0; i < v.length; i += 1) b[k + i] = (b[k + i] ?? 0) - factorB * (v[i] ?? 0);
  }
  const diagonal = Array.from({ length: n }, (_, k) => Math.abs(at(k, k)));
  const minDiagonal = Math.min(...diagonal);
  const conditionEstimate = minDiagonal === 0 ? Number.POSITIVE_INFINITY : Math.max(...diagonal) / minDiagonal;
  const solution = new Array<number>(n).fill(0);
  if (Number.isFinite(conditionEstimate)) {
    for (let k = n - 1; k >= 0; k -= 1) {
      let sum = b[k] ?? 0;
      for (let j = k + 1; j < n; j += 1) sum -= at(k, j) * (solution[j] ?? 0);
      solution[k] = sum / at(k, k);
    }
  }
  return { coefficients: solution.map((c, j) => c / (scale[j] ?? 1)), conditionEstimate };
}

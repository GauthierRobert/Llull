/**
 * Cholesky factorisation and solve of a symmetric positive-definite BANDED matrix (lower band, row storage).
 * Entry (i, j), i - bandwidth <= j <= i, lives at `i * (bandwidth + 1) + (j - i + bandwidth)`.
 */

export const bandIndex = (i: number, j: number, bandwidth: number): number => i * (bandwidth + 1) + (j - i + bandwidth);

/**
 * Factorises `band` in place (A = L L^T, L overwrites the band).
 * @failure a non-positive pivot (singular or indefinite matrix) -> false, `band` is then undefined
 */
export function factorBanded(band: Float64Array, n: number, bandwidth: number): boolean {
  for (let i = 0; i < n; i += 1) {
    const first = Math.max(0, i - bandwidth);
    for (let j = first; j < i; j += 1) {
      let sum = band[bandIndex(i, j, bandwidth)] ?? 0;
      for (let k = Math.max(first, j - bandwidth); k < j; k += 1)
        sum -= (band[bandIndex(i, k, bandwidth)] ?? 0) * (band[bandIndex(j, k, bandwidth)] ?? 0);
      band[bandIndex(i, j, bandwidth)] = sum / (band[bandIndex(j, j, bandwidth)] ?? 1);
    }
    let pivot = band[bandIndex(i, i, bandwidth)] ?? 0;
    for (let k = first; k < i; k += 1) pivot -= (band[bandIndex(i, k, bandwidth)] ?? 0) ** 2;
    if (!(pivot > 0)) return false;
    band[bandIndex(i, i, bandwidth)] = Math.sqrt(pivot);
  }
  return true;
}

/** Solves L L^T x = rhs with the factor of `factorBanded`; `rhs` is not modified. */
export function solveBanded(factor: Float64Array, n: number, bandwidth: number, rhs: Float64Array): Float64Array {
  const x = Float64Array.from(rhs);
  for (let i = 0; i < n; i += 1) {
    let sum = x[i] ?? 0;
    for (let k = Math.max(0, i - bandwidth); k < i; k += 1) sum -= (factor[bandIndex(i, k, bandwidth)] ?? 0) * (x[k] ?? 0);
    x[i] = sum / (factor[bandIndex(i, i, bandwidth)] ?? 1);
  }
  for (let i = n - 1; i >= 0; i -= 1) {
    const xi = (x[i] ?? 0) / (factor[bandIndex(i, i, bandwidth)] ?? 1);
    x[i] = xi;
    for (let k = Math.max(0, i - bandwidth); k < i; k += 1) x[k] = (x[k] ?? 0) - (factor[bandIndex(i, k, bandwidth)] ?? 0) * xi;
  }
  return x;
}

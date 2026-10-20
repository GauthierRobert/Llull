/** Dense linear algebra for the sketch solver: row-major `Float64Array` matrices, sizes in the tens to low hundreds. */

/** Element read with the `noUncheckedIndexedAccess` fallback folded in (out of range reads 0). */
export function at(values: ArrayLike<number>, index: number): number {
  return values[index] ?? 0;
}

/** `target[index] += delta` with the `noUncheckedIndexedAccess` fallback folded in. */
export function addAt(target: Float64Array, index: number, delta: number): void {
  target[index] = (target[index] ?? 0) + delta;
}

/**
 * Solve the square system `A x = b` (`A` is n×n row-major) by Gaussian elimination with partial pivoting.
 * Returns null when a pivot is numerically zero.
 */
export function solveLinear(matrix: Float64Array, rhs: Float64Array, n: number): Float64Array | null {
  const a = Float64Array.from(matrix);
  const b = Float64Array.from(rhs);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(at(a, row * n + col)) > Math.abs(at(a, pivot * n + col))) pivot = row;
    if (Math.abs(at(a, pivot * n + col)) < 1e-300) return null;
    if (pivot !== col) {
      for (let k = 0; k < n; k++) {
        const tmp = at(a, col * n + k);
        a[col * n + k] = at(a, pivot * n + k);
        a[pivot * n + k] = tmp;
      }
      const tmpB = at(b, col);
      b[col] = at(b, pivot);
      b[pivot] = tmpB;
    }
    const diagonal = at(a, col * n + col);
    for (let row = col + 1; row < n; row++) {
      const factor = at(a, row * n + col) / diagonal;
      if (factor === 0) continue;
      for (let k = col; k < n; k++) a[row * n + k] = at(a, row * n + k) - factor * at(a, col * n + k);
      b[row] = at(b, row) - factor * at(b, col);
    }
  }
  const x = new Float64Array(n);
  for (let row = n - 1; row >= 0; row--) {
    let sum = at(b, row);
    for (let k = row + 1; k < n; k++) sum -= at(a, row * n + k) * at(x, k);
    x[row] = sum / at(a, row * n + row);
  }
  return x.every(Number.isFinite) ? x : null;
}

/** Dense linear algebra for the sketch solver: row-major `Float64Array` matrices, sizes in the tens to low hundreds. */

/** Element read with the `noUncheckedIndexedAccess` fallback folded in (out of range reads 0). */
export function at(values: ArrayLike<number>, index: number): number {
  return values[index] ?? 0;
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

/** Singular values (unsorted, length `cols`) and right singular vectors (`vectors[row * cols + k]` is component `row` of vector `k`). */
export interface Svd {
  readonly values: Float64Array;
  readonly vectors: Float64Array;
}

/**
 * One-sided Jacobi SVD of the `rows`×`cols` row-major matrix. Works for any shape; vectors of zero singular value span the null space.
 */
export function jacobiSvd(matrix: Float64Array, rows: number, cols: number): Svd {
  const u = Float64Array.from(matrix);
  const v = new Float64Array(cols * cols);
  for (let i = 0; i < cols; i++) v[i * cols + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let rotated = false;
    for (let p = 0; p < cols - 1; p++) {
      for (let q = p + 1; q < cols; q++) {
        let alpha = 0;
        let beta = 0;
        let gamma = 0;
        for (let r = 0; r < rows; r++) {
          const up = at(u, r * cols + p);
          const uq = at(u, r * cols + q);
          alpha += up * up;
          beta += uq * uq;
          gamma += up * uq;
        }
        if (Math.abs(gamma) <= 1e-15 * Math.sqrt(alpha * beta) || gamma === 0) continue;
        rotated = true;
        const zeta = (beta - alpha) / (2 * gamma);
        const t = Math.sign(zeta || 1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
        const c = 1 / Math.sqrt(1 + t * t);
        const s = c * t;
        for (let r = 0; r < rows; r++) {
          const up = at(u, r * cols + p);
          const uq = at(u, r * cols + q);
          u[r * cols + p] = c * up - s * uq;
          u[r * cols + q] = s * up + c * uq;
        }
        for (let r = 0; r < cols; r++) {
          const vp = at(v, r * cols + p);
          const vq = at(v, r * cols + q);
          v[r * cols + p] = c * vp - s * vq;
          v[r * cols + q] = s * vp + c * vq;
        }
      }
    }
    if (!rotated) break;
  }
  const values = new Float64Array(cols);
  for (let k = 0; k < cols; k++) {
    let sum = 0;
    for (let r = 0; r < rows; r++) sum += at(u, r * cols + k) ** 2;
    values[k] = Math.sqrt(sum);
  }
  return { values, vectors: v };
}

/** Singular values at or below this are numerically zero (relative to the largest, with an absolute floor). */
export function rankTolerance(values: Float64Array): number {
  let largest = 0;
  for (const value of values) largest = Math.max(largest, value);
  return Math.max(1e-7 * largest, 1e-9);
}

/** Transpose of a `rows`×`cols` row-major matrix. */
export function transpose(matrix: Float64Array, rows: number, cols: number): Float64Array {
  const out = new Float64Array(rows * cols);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out[c * rows + r] = at(matrix, r * cols + c);
  return out;
}

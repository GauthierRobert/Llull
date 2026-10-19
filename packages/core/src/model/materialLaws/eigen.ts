/** Symmetric eigen-decomposition by cyclic Jacobi rotations (small matrices: Jacobian conditioning, 3×3 deformation tensors). */

export interface SymmetricEigen {
  /** Eigenvalues in ascending order. */
  readonly values: readonly number[];
  /** `vectors[k]` is the unit eigenvector of `values[k]`. */
  readonly vectors: readonly (readonly number[])[];
}

/**
 * Eigenvalues and eigenvectors of a symmetric matrix (only the upper triangle is read).
 * @invariant deterministic sweep order; stops at an off-diagonal norm of 1e-15 of the diagonal or after 60 sweeps
 */
export function symmetricEigen(matrix: readonly (readonly number[])[]): SymmetricEigen {
  const n = matrix.length;
  const a: number[][] = matrix.map((row, i) => row.map((_, j) => (i <= j ? (row[j] ?? 0) : (matrix[j]?.[i] ?? 0))));
  const v: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  const at = (m: number[][], i: number, j: number): number => m[i]?.[j] ?? 0;
  const put = (m: number[][], i: number, j: number, value: number): void => {
    const row = m[i];
    if (row !== undefined) row[j] = value;
  };
  for (let sweep = 0; sweep < 60; sweep += 1) {
    let off = 0;
    let diag = 0;
    for (let i = 0; i < n; i += 1) {
      diag += at(a, i, i) ** 2;
      for (let j = i + 1; j < n; j += 1) off += at(a, i, j) ** 2;
    }
    if (off <= 1e-30 * Math.max(diag, Number.MIN_VALUE)) break;
    for (let p = 0; p < n; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        const apq = at(a, p, q);
        if (apq === 0) continue;
        const theta = (at(a, q, q) - at(a, p, p)) / (2 * apq);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k += 1) {
          const akp = at(a, k, p);
          const akq = at(a, k, q);
          put(a, k, p, c * akp - s * akq);
          put(a, k, q, s * akp + c * akq);
        }
        for (let k = 0; k < n; k += 1) {
          const apk = at(a, p, k);
          const aqk = at(a, q, k);
          put(a, p, k, c * apk - s * aqk);
          put(a, q, k, s * apk + c * aqk);
        }
        for (let k = 0; k < n; k += 1) {
          const vkp = at(v, k, p);
          const vkq = at(v, k, q);
          put(v, k, p, c * vkp - s * vkq);
          put(v, k, q, s * vkp + c * vkq);
        }
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => at(a, i, i) - at(a, j, j));
  return { values: order.map((i) => at(a, i, i)), vectors: order.map((i) => Array.from({ length: n }, (_, k) => at(v, k, i))) };
}

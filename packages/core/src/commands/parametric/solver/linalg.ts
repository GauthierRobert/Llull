/** Dense linear algebra for the sketch solver: row-major `Float64Array` matrices, sizes in the tens to low hundreds. */

import { luFactor, luSolve } from '../../../lib/denseLinalg';

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
 * Returns null when a pivot is numerically zero or the solution is not finite.
 */
export function solveLinear(matrix: Float64Array, rhs: Float64Array, n: number): Float64Array | null {
  const factors = luFactor(matrix, n);
  if (factors === null) return null;
  const x = luSolve(factors, rhs);
  return x.every(Number.isFinite) ? x : null;
}

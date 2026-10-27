/**
 * Sparse linear combinations of cage vertices (stencils) as a vertex algebra for `refineOnce`: refining a cage of stencils gives every vertex
 * of the refined level as a fixed linear combination of the original cage vertices (the subdivision matrix S^k, row by row). Pure.
 */

import type { RefineOps } from '../subdivision';

/** Sum over `idx` of `w[k] * cage[idx[k]]`; indices are distinct. */
export interface Stencil {
  readonly idx: Int32Array;
  readonly w: Float64Array;
}

/** The stencil that reads vertex `i` of a cage. */
export const unitStencil = (i: number): Stencil => ({ idx: Int32Array.of(i), w: Float64Array.of(1) });

/** Algebra over stencils of a cage with `size` vertices (one scratch accumulator is shared by its operations: not re-entrant). */
export function stencilOps(
  size: number,
): RefineOps<Stencil> & { readonly combine: (terms: ReadonlyArray<readonly [Stencil, number]>) => Stencil } {
  const accumulator = new Float64Array(size);
  const seen = new Uint8Array(size);
  const combine = (terms: ReadonlyArray<readonly [Stencil, number]>): Stencil => {
    const touched: number[] = [];
    for (const [stencil, factor] of terms)
      for (let k = 0; k < stencil.idx.length; k++) {
        const i = stencil.idx[k] as number;
        if (seen[i] === 0) {
          seen[i] = 1;
          touched.push(i);
        }
        accumulator[i] = (accumulator[i] as number) + factor * (stencil.w[k] as number);
      }
    const idx = Int32Array.from(touched);
    const w = new Float64Array(touched.length);
    touched.forEach((i, k) => {
      w[k] = accumulator[i] as number;
      accumulator[i] = 0;
      seen[i] = 0;
    });
    return { idx, w };
  };
  return {
    combine,
    add: (a, b) =>
      combine([
        [a, 1],
        [b, 1],
      ]),
    scale: (a, factor) => combine([[a, factor]]),
    centroid: (values) => combine(values.map((s) => [s, 1 / values.length] as const)),
    lerp: (a, b, t) =>
      combine([
        [a, 1 - t],
        [b, t],
      ]),
  };
}

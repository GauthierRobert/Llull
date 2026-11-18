/**
 * `x` to a small integer power by repeated multiplication, left to right: ((x·x)·x)·… ; a negative `n` is the reciprocal of that product.
 * Used instead of `x ** n` / `Math.pow(x, n)` because the result of the built-in power is not bit-identical across V8 versions (Node 22 vs 24,
 * the Electron renderer): IEEE products are, so documents, state hashes and golden snapshots do not depend on the runtime. `x ** 2` is exact
 * everywhere and stays as it is.
 */
export function powInt(x: number, n: number): number {
  if (n < 0) return 1 / powInt(x, -n);
  let product = 1;
  for (let k = 0; k < n; k++) product *= x;
  return product;
}

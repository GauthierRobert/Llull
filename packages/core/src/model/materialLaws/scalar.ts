/** Safeguarded scalar Newton on a decreasing function bracketed by f(lo) > 0 > f(hi). */

/**
 * Root of a decreasing function: Newton steps with a forward-difference slope, bisection whenever a step leaves the bracket.
 * @failure no convergence within 100 iterations -> null
 */
export function solveDecreasing(
  f: (x: number) => number,
  lo0: number,
  hi0: number,
  tolerance: number,
): { readonly x: number; readonly iterations: number } | null {
  let lo = lo0;
  let hi = hi0;
  let x = lo;
  for (let iteration = 1; iteration <= 100; iteration += 1) {
    const fx = f(x);
    if (Math.abs(fx) <= tolerance) return { x, iterations: iteration };
    if (fx > 0) lo = x;
    else hi = x;
    const h = Math.max(1e-7 * (hi - lo), 1e-14 * Math.max(1, Math.abs(x)));
    const slope = (f(x + h) - fx) / h;
    let next = slope < 0 ? x - fx / slope : Number.NaN;
    if (!(next > lo && next < hi)) next = 0.5 * (lo + hi);
    if (next === x || hi - lo <= 1e-16 * Math.max(1, hi)) return { x: next, iterations: iteration };
    x = next;
  }
  return null;
}

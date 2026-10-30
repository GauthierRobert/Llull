/**
 * Jacobi-preconditioned BiCGSTAB for a square, not necessarily symmetric operator given as a product, warm-started at `x0`. Pure; deterministic (fixed operation order).
 * Used where the operator is not symmetric (the mean-value weights of the harmonic map); `conjugateGradient` stays the solver of symmetric positive systems.
 */

import type { CgOptions, CgResult } from './conjugateGradient';

const dot = (a: Float64Array, b: Float64Array): number => {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += (a[i] as number) * (b[i] as number);
  return total;
};

/**
 * Solves A x = b with `apply(x, out)` writing A x into `out`. `options.diagonal` (entries > 0) is the preconditioner; `stallWindow` as in `conjugateGradient`.
 * @failure a breakdown (a zero inner product) or the iteration cap ends it with `converged` false and the best residual so far
 */
export function biCgStab(
  apply: (x: Float64Array, out: Float64Array) => void,
  b: Float64Array,
  x0: Float64Array,
  options: CgOptions,
): CgResult {
  const n = b.length;
  const x = Float64Array.from(x0);
  const norm = Math.sqrt(dot(b, b));
  if (norm === 0) return { x: new Float64Array(n), iterations: 0, relativeResidual: 0, converged: true };
  const inverse = (i: number): number => {
    const d = options.diagonal?.[i];
    return d !== undefined && d > 0 ? 1 / d : 1;
  };
  const [r, rHat, p, v, y, z, s, t] = Array.from({ length: 8 }, () => new Float64Array(n)) as [
    Float64Array,
    Float64Array,
    Float64Array,
    Float64Array,
    Float64Array,
    Float64Array,
    Float64Array,
    Float64Array,
  ];
  apply(x, t);
  for (let i = 0; i < n; i++) r[i] = (b[i] as number) - (t[i] as number);
  rHat.set(r);
  let [rho, alpha, omega] = [1, 1, 1];
  let residual = Math.sqrt(dot(r, r)) / norm;
  let [checkpoint, best] = [residual, residual];
  let iterations = 0;
  while (residual > options.tolerance && iterations < options.maxIterations) {
    const rhoNext = dot(rHat, r);
    if (rhoNext === 0 || omega === 0) break;
    const beta = (rhoNext / rho) * (alpha / omega);
    for (let i = 0; i < n; i++) p[i] = (r[i] as number) + beta * ((p[i] as number) - omega * (v[i] as number));
    for (let i = 0; i < n; i++) y[i] = (p[i] as number) * inverse(i);
    apply(y, v);
    const denominator = dot(rHat, v);
    if (denominator === 0) break;
    alpha = rhoNext / denominator;
    for (let i = 0; i < n; i++) s[i] = (r[i] as number) - alpha * (v[i] as number);
    iterations++;
    const sResidual = Math.sqrt(dot(s, s)) / norm;
    if (sResidual <= options.tolerance) {
      for (let i = 0; i < n; i++) x[i] = (x[i] as number) + alpha * (y[i] as number);
      residual = sResidual;
      break;
    }
    for (let i = 0; i < n; i++) z[i] = (s[i] as number) * inverse(i);
    apply(z, t);
    const tt = dot(t, t);
    if (tt === 0) break;
    omega = dot(t, s) / tt;
    for (let i = 0; i < n; i++) {
      x[i] = (x[i] as number) + alpha * (y[i] as number) + omega * (z[i] as number);
      r[i] = (s[i] as number) - omega * (t[i] as number);
    }
    rho = rhoNext;
    residual = Math.sqrt(dot(r, r)) / norm;
    best = Math.min(best, residual);
    if (options.stallWindow !== undefined && iterations % options.stallWindow === 0) {
      if (best >= 0.99 * checkpoint) break;
      checkpoint = best;
    }
  }
  return { x, iterations, relativeResidual: residual, converged: residual <= options.tolerance };
}

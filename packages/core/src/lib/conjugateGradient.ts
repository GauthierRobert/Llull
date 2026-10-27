/**
 * Jacobi-preconditioned conjugate gradient for a symmetric positive (semi-)definite operator given as a product, warm-started at `x0`.
 * Pure; deterministic (fixed operation order).
 */

export interface CgOptions {
  readonly maxIterations: number;
  /** Stop when ||residual|| <= tolerance * ||b||. */
  readonly tolerance: number;
  /** Diagonal of the operator (> 0 entries are used as the preconditioner); omitted: none. */
  readonly diagonal?: Float64Array | undefined;
}

export interface CgResult {
  readonly x: Float64Array;
  readonly iterations: number;
  /** Final ||residual|| / ||b|| (0 when b is 0). */
  readonly relativeResidual: number;
  readonly converged: boolean;
}

const dot = (a: Float64Array, b: Float64Array): number => {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += (a[i] as number) * (b[i] as number);
  return total;
};

/** Solves A x = b with `apply(x, out)` writing A x into `out`. */
export function conjugateGradient(
  apply: (x: Float64Array, out: Float64Array) => void,
  b: Float64Array,
  x0: Float64Array,
  options: CgOptions,
): CgResult {
  const n = b.length;
  const x = Float64Array.from(x0);
  const r = new Float64Array(n);
  const ap = new Float64Array(n);
  apply(x, ap);
  for (let i = 0; i < n; i++) r[i] = (b[i] as number) - (ap[i] as number);
  const norm = Math.sqrt(dot(b, b));
  if (norm === 0) return { x: new Float64Array(n), iterations: 0, relativeResidual: 0, converged: true };
  const inverse = (i: number): number => {
    const d = options.diagonal?.[i];
    return d !== undefined && d > 0 ? 1 / d : 1;
  };
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) z[i] = (r[i] as number) * inverse(i);
  const p = Float64Array.from(z);
  let rz = dot(r, z);
  let residual = Math.sqrt(dot(r, r)) / norm;
  let iterations = 0;
  while (residual > options.tolerance && iterations < options.maxIterations) {
    apply(p, ap);
    const curvature = dot(p, ap);
    if (!(curvature > 0)) break;
    const alpha = rz / curvature;
    for (let i = 0; i < n; i++) {
      x[i] = (x[i] as number) + alpha * (p[i] as number);
      r[i] = (r[i] as number) - alpha * (ap[i] as number);
    }
    for (let i = 0; i < n; i++) z[i] = (r[i] as number) * inverse(i);
    const next = dot(r, z);
    const beta = next / rz;
    rz = next;
    for (let i = 0; i < n; i++) p[i] = (z[i] as number) + beta * (p[i] as number);
    residual = Math.sqrt(dot(r, r)) / norm;
    iterations++;
  }
  return { x, iterations, relativeResidual: residual, converged: residual <= options.tolerance };
}

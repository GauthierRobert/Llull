/** Sobol variance-based sensitivity indices from model evaluations on the Saltelli sample matrices (pure estimators). */

import { createPrng } from './prng';

export interface Interval {
  readonly value: number;
  readonly ci95: readonly [number, number] | null;
}

export interface SobolIndices {
  readonly mean: number;
  readonly variance: number;
  readonly first: readonly Interval[];
  readonly total: readonly Interval[];
}

const DEFAULT_BOOTSTRAP_SEED = 20_100_611;

interface Raw {
  readonly mean: number;
  readonly variance: number;
  readonly first: number[];
  readonly total: number[];
}

/** Estimators on the rows `rows` (indices into the N base samples) of f(A), f(B) and f(AB_i); f(B) is centred on the mean so the noise scales with the spread, not the mean. */
function estimate(fA: Float64Array, fB: Float64Array, fAB: readonly Float64Array[], rows: ArrayLike<number>): Raw {
  const n = rows.length;
  let sum = 0;
  for (let k = 0; k < n; k += 1) sum += (fA[rows[k] ?? 0] ?? 0) + (fB[rows[k] ?? 0] ?? 0);
  const mean = sum / (2 * n);
  let squares = 0;
  for (let k = 0; k < n; k += 1) squares += ((fA[rows[k] ?? 0] ?? 0) - mean) ** 2 + ((fB[rows[k] ?? 0] ?? 0) - mean) ** 2;
  const variance = squares / (2 * n);
  const first: number[] = [];
  const total: number[] = [];
  for (const column of fAB) {
    let saltelli = 0;
    let jansen = 0;
    for (let k = 0; k < n; k += 1) {
      const row = rows[k] ?? 0;
      const a = fA[row] ?? 0;
      const ab = column[row] ?? 0;
      saltelli += ((fB[row] ?? 0) - mean) * (ab - a);
      jansen += (a - ab) * (a - ab);
    }
    first.push(saltelli / n / variance);
    total.push(jansen / (2 * n) / variance);
  }
  return { mean, variance, first, total };
}

/**
 * First-order S_i (Saltelli 2010) and total-effect ST_i (Jansen 1999) indices with a percentile bootstrap 95 % interval.
 * @invariant exact for the closed forms as N -> infinity; deterministic for (inputs, bootstrap, seed); ci95 is null when bootstrap = 0
 * @param fA f at the N rows of matrix A; fB at matrix B; fAB[i] at A with column i taken from B
 */
export function sobolIndices(
  fA: Float64Array,
  fB: Float64Array,
  fAB: readonly Float64Array[],
  bootstrap: number,
  seed: number = DEFAULT_BOOTSTRAP_SEED,
): SobolIndices {
  const n = fA.length;
  const base = estimate(
    fA,
    fB,
    fAB,
    Array.from({ length: n }, (_, k) => k),
  );
  const first = fAB.map(() => [] as number[]);
  const total = fAB.map(() => [] as number[]);
  const prng = createPrng(seed);
  const rows = new Uint32Array(n);
  for (let r = 0; r < bootstrap; r += 1) {
    for (let k = 0; k < n; k += 1) rows[k] = Math.min(Math.floor(prng.uniform() * n), n - 1);
    const draw = estimate(fA, fB, fAB, rows);
    draw.first.forEach((value, i) => first[i]?.push(value));
    draw.total.forEach((value, i) => total[i]?.push(value));
  }
  const interval = (value: number, draws: number[] | undefined): Interval => {
    if (bootstrap === 0 || draws === undefined) return { value, ci95: null };
    const sorted = Float64Array.from(draws).sort();
    const at = (p: number): number => sorted[Math.min(Math.floor(p * sorted.length), sorted.length - 1)] ?? 0;
    return { value, ci95: [at(0.025), at(0.975)] };
  };
  return {
    mean: base.mean,
    variance: base.variance,
    first: base.first.map((value, i) => interval(value, first[i])),
    total: base.total.map((value, i) => interval(value, total[i])),
  };
}

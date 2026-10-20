/**
 * Tolerance stack-up mathematics (03 GDT TECHNICAL_SPEC §5.7): linearised worst case, exact corners, RSS, sigma model, exact probabilities
 * (normal CDF, generalised Irwin-Hall) and seeded Monte Carlo. Pure: no document, no clock; lengths in one consistent unit.
 */

import { normalCdf } from './erfc';
import { createRandomStream } from './prng';

export type StackDistribution = 'normal' | 'uniform';

/** Limits are [nominal + lower, nominal + upper]. `sensitivity` is the partial derivative of the stack result with respect to this value. */
export interface StackContributor {
  readonly name: string;
  readonly nominal: number;
  readonly lower: number;
  readonly upper: number;
  readonly sensitivity: number;
  readonly distribution: StackDistribution;
}

/** Centre of the tolerance band. */
export const meanOf = (c: Pick<StackContributor, 'nominal' | 'lower' | 'upper'>): number => c.nominal + (c.lower + c.upper) / 2;

/** Half of the tolerance band. */
export const halfOf = (c: Pick<StackContributor, 'lower' | 'upper'>): number => (c.upper - c.lower) / 2;

/** Standard deviation: half / k (normal) or half / sqrt(3) (uniform). */
export const sigmaOf = (c: StackContributor, sigmaPerHalfTolerance: number): number =>
  c.distribution === 'normal' ? halfOf(c) / sigmaPerHalfTolerance : halfOf(c) / Math.sqrt(3);

/** Linearised worst-case half tolerance: sum |a_i| t_i. */
export const worstCaseHalf = (items: readonly StackContributor[]): number =>
  items.reduce((sum, c) => sum + Math.abs(c.sensitivity) * halfOf(c), 0);

/** RSS half tolerance: sqrt(sum (a_i t_i)^2). */
export const rssHalf = (items: readonly StackContributor[]): number =>
  Math.sqrt(items.reduce((sum, c) => sum + (c.sensitivity * halfOf(c)) ** 2, 0));

/** Standard deviation of the stack result: sqrt(sum (a_i sigma_i)^2). */
export const stackSigma = (items: readonly StackContributor[], sigmaPerHalfTolerance: number): number =>
  Math.sqrt(items.reduce((sum, c) => sum + (c.sensitivity * sigmaOf(c, sigmaPerHalfTolerance)) ** 2, 0));

export interface Contribution {
  readonly name: string;
  readonly wcPercent: number;
  readonly rssPercent: number;
}

/** Share of each contributor in the worst case (|a| t) and in the variance ((a sigma)^2), percent. */
export function contributions(items: readonly StackContributor[], sigmaPerHalfTolerance: number): Contribution[] {
  const wc = worstCaseHalf(items);
  const variance = items.reduce((sum, c) => sum + (c.sensitivity * sigmaOf(c, sigmaPerHalfTolerance)) ** 2, 0);
  return items.map((c) => ({
    name: c.name,
    wcPercent: wc > 0 ? (100 * Math.abs(c.sensitivity) * halfOf(c)) / wc : 0,
    rssPercent: variance > 0 ? (100 * (c.sensitivity * sigmaOf(c, sigmaPerHalfTolerance)) ** 2) / variance : 0,
  }));
}

/** Largest contributor count of the exact-corner enumeration (2^n evaluations). */
const MAX_CORNER_CONTRIBUTORS = 16;

/** Min and max of `f` over the 2^n limit combinations; null above MAX_CORNER_CONTRIBUTORS. */
export function exactCorners(
  items: readonly StackContributor[],
  f: (values: readonly number[]) => number,
): { min: number; max: number } | null {
  const n = items.length;
  if (n === 0 || n > MAX_CORNER_CONTRIBUTORS) return null;
  const values = items.map((c) => c.nominal + c.lower);
  let [min, max] = [Infinity, -Infinity];
  for (let mask = 0; mask < 2 ** n; mask++) {
    for (let i = 0; i < n; i++) {
      const c = items[i] as StackContributor;
      values[i] = c.nominal + ((mask >> i) & 1 ? c.upper : c.lower);
    }
    const y = f(values);
    if (y < min) min = y;
    if (y > max) max = y;
  }
  return { min, max };
}

/** Largest contributor count of the exact uniform-sum CDF (2^n subset terms). */
const MAX_IRWIN_HALL = 12;

/**
 * Exact P(sum <= x) of independent uniform terms on [-h_i, +h_i] (generalised Irwin-Hall, evaluated on centred terms):
 * (1 / (n! prod w_i)) sum over subsets S of (-1)^|S| (x + sum h_i - sum_{i in S} w_i)_+^n with w_i = 2 h_i. Zero-width terms are dropped.
 */
export function uniformSumCdf(halves: readonly number[], x: number): number {
  const widths = halves.filter((h) => h > 0).map((h) => 2 * h);
  const n = widths.length;
  if (n === 0) return x >= 0 ? 1 : 0;
  const span = widths.reduce((sum, w) => sum + w, 0);
  const shifted = x + span / 2;
  if (shifted <= 0) return 0;
  if (shifted >= span) return 1;
  // The terms alternate in sign: above the middle fold with the symmetry F(x) = 1 - F(-x), so only the small lower tail is summed.
  if (shifted > span / 2) return 1 - subsetSum(widths, span - shifted);
  return subsetSum(widths, shifted);
}

/** Inclusion-exclusion sum of the Irwin-Hall CDF at `shifted` (0 < shifted <= half the span). */
function subsetSum(widths: readonly number[], shifted: number): number {
  const n = widths.length;
  let total = 0;
  for (let mask = 0; mask < 2 ** n; mask++) {
    let arg = shifted;
    let bits = 0;
    for (let i = 0; i < n; i++)
      if ((mask >> i) & 1) {
        arg -= widths[i] as number;
        bits++;
      }
    if (arg > 0) total += (bits % 2 === 0 ? 1 : -1) * arg ** n;
  }
  let denominator = 1;
  for (let i = 2; i <= n; i++) denominator *= i;
  for (const w of widths) denominator *= w;
  return total / denominator;
}

export interface ExactProbabilities {
  readonly pBelow: number;
  readonly pAbove: number;
  readonly method: string;
}

/**
 * P(y < lower) and P(y > upper) of a linear stack. All normal: the normal CDF of the exact sum; all uniform (<= MAX_IRWIN_HALL terms):
 * the exact Irwin-Hall CDF; mixed or too many terms: null (Monte Carlo only).
 */
export function exactProbabilities(
  items: readonly StackContributor[],
  yMean: number,
  sigmaPerHalfTolerance: number,
  lower: number | undefined,
  upper: number | undefined,
): ExactProbabilities | null {
  if (items.length === 0) return null;
  const sigma = stackSigma(items, sigmaPerHalfTolerance);
  if (items.every((c) => c.distribution === 'normal') && sigma > 0) {
    return {
      pBelow: lower === undefined ? 0 : normalCdf((lower - yMean) / sigma),
      pAbove: upper === undefined ? 0 : normalCdf((yMean - upper) / sigma),
      method: 'normal CDF of the sum of independent normals',
    };
  }
  if (items.every((c) => c.distribution === 'uniform') && items.length <= MAX_IRWIN_HALL) {
    const halves = items.map((c) => Math.abs(c.sensitivity) * halfOf(c));
    return {
      pBelow: lower === undefined ? 0 : uniformSumCdf(halves, lower - yMean),
      pAbove: upper === undefined ? 0 : uniformSumCdf(halves, yMean - upper),
      method: 'exact generalised Irwin-Hall CDF of the sum of independent uniforms',
    };
  }
  return null;
}

export interface MonteCarloResult {
  readonly seed: number;
  readonly samples: number;
  readonly prng: string;
  readonly mean: number;
  readonly std: number;
  readonly min: number;
  readonly max: number;
  readonly pBelow?: number;
  readonly pAbove?: number;
  /** 5-sigma statistical acceptance half-widths around the analytic values (mean, std, probability floor 1e-5). */
  readonly acceptance: { readonly mean: number; readonly std: number };
}

export interface MonteCarloOptions {
  readonly seed: number;
  readonly samples: number;
  readonly sigmaPerHalfTolerance: number;
  readonly lower?: number;
  readonly upper?: number;
  /** Analytic sigma of the result, for the acceptance bounds. */
  readonly sigma: number;
}

/** 5-sigma acceptance half-width of an estimated probability `p` over `n` draws (absolute floor 1e-5). */
export const probabilityAcceptance = (p: number, n: number): number => Math.max(5 * Math.sqrt((p * (1 - p)) / n), 1e-5);

/**
 * Seeded Monte Carlo of `f` over independent contributors: normal = mean + sigma z, uniform = mean + half (2u - 1). Deterministic for
 * (seed, samples, inputs). Welford mean / unbiased variance, one scratch array for the whole run.
 */
export function monteCarlo(
  items: readonly StackContributor[],
  f: (values: readonly number[]) => number,
  options: MonteCarloOptions,
): MonteCarloResult {
  const { seed, samples, sigmaPerHalfTolerance, lower, upper } = options;
  const stream = createRandomStream(seed);
  const centres = items.map(meanOf);
  const spreads = items.map((c) => (c.distribution === 'normal' ? sigmaOf(c, sigmaPerHalfTolerance) : halfOf(c)));
  const normal = items.map((c) => c.distribution === 'normal');
  const values = [...centres];
  let [mean, m2, min, max, below, above] = [0, 0, Infinity, -Infinity, 0, 0];
  for (let s = 1; s <= samples; s++) {
    for (let i = 0; i < values.length; i++)
      values[i] = (centres[i] as number) + (spreads[i] as number) * (normal[i] === true ? stream.normal() : 2 * stream.uniform() - 1);
    const y = f(values);
    const delta = y - mean;
    mean += delta / s;
    m2 += delta * (y - mean);
    if (y < min) min = y;
    if (y > max) max = y;
    if (lower !== undefined && y < lower) below++;
    if (upper !== undefined && y > upper) above++;
  }
  return {
    seed,
    samples,
    prng: 'xoshiro128** seeded by SplitMix32; uniform from the top 24 bits; normal by Box-Muller',
    mean,
    std: samples > 1 ? Math.sqrt(m2 / (samples - 1)) : 0,
    min,
    max,
    ...(lower === undefined ? {} : { pBelow: below / samples }),
    ...(upper === undefined ? {} : { pAbove: above / samples }),
    acceptance: { mean: (5 * options.sigma) / Math.sqrt(samples), std: (5 * options.sigma) / Math.sqrt(2 * samples) },
  };
}

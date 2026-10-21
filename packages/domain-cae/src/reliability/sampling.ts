/** Seeded Monte Carlo / Latin hypercube sampling of the standard normal space, sample statistics, Pf estimate and FOSM moments. */

import { createPrng } from './prng';
import { normalCdf } from '@lib/specialFunctions';
import { normalInv } from './numerics';

export type SamplingMethod = 'mc' | 'lhs' | 'lhs_centred';

const QUANTILE_LEVELS = [0.001, 0.01, 0.05, 0.5, 0.95, 0.99, 0.999] as const;
const HISTOGRAM_BINS = 20;

/** `count` points of the `dimension`-dimensional standard normal space (row-major flat array), deterministic for (method, seed). */
export function standardNormalSamples(method: SamplingMethod, count: number, dimension: number, seed: number): Float64Array {
  const prng = createPrng(seed);
  const out = new Float64Array(count * dimension);
  if (method === 'mc') {
    for (let i = 0; i < out.length; i += 1) out[i] = prng.normal();
    return out;
  }
  for (let d = 0; d < dimension; d += 1) {
    const strata = Array.from({ length: count }, (_, i) => i);
    for (let i = count - 1; i > 0; i -= 1) {
      const j = Math.min(Math.floor(prng.uniform() * (i + 1)), i);
      [strata[i], strata[j]] = [strata[j] ?? 0, strata[i] ?? 0];
    }
    for (let i = 0; i < count; i += 1) {
      const offset = method === 'lhs' ? prng.uniform() : 0.5;
      out[i * dimension + d] = normalInv(((strata[i] ?? 0) + offset) / count);
    }
  }
  return out;
}

interface Histogram {
  readonly edges: number[];
  readonly counts: number[];
}

export interface SampleStats {
  readonly count: number;
  readonly mean: number;
  readonly sd: number;
  readonly min: number;
  readonly max: number;
  readonly quantiles: Record<string, number>;
  readonly histogram: Histogram;
}

/** Moments, min / max, quantiles (linear interpolation of the sorted values) and a 20-bin histogram. Needs at least one value. */
export function sampleStats(values: Float64Array): SampleStats {
  const sorted = Float64Array.from(values).sort();
  const count = sorted.length;
  let mean = 0;
  let m2 = 0;
  for (let i = 0; i < count; i += 1) {
    const delta = (sorted[i] ?? 0) - mean;
    mean += delta / (i + 1);
    m2 += delta * ((sorted[i] ?? 0) - mean);
  }
  const quantile = (p: number): number => {
    const position = p * (count - 1);
    const lower = Math.floor(position);
    const fraction = position - lower;
    return (sorted[lower] ?? 0) * (1 - fraction) + (sorted[Math.min(lower + 1, count - 1)] ?? 0) * fraction;
  };
  const min = sorted[0] ?? 0;
  const max = sorted[count - 1] ?? 0;
  const width = (max - min) / HISTOGRAM_BINS || 1;
  const counts = new Array<number>(HISTOGRAM_BINS).fill(0);
  for (const value of sorted) {
    const bin = Math.min(Math.floor((value - min) / width), HISTOGRAM_BINS - 1);
    counts[bin] = (counts[bin] ?? 0) + 1;
  }
  return {
    count,
    mean,
    sd: count > 1 ? Math.sqrt(m2 / (count - 1)) : 0,
    min,
    max,
    quantiles: Object.fromEntries(QUANTILE_LEVELS.map((p) => [String(p), quantile(p)])),
    histogram: { edges: Array.from({ length: HISTOGRAM_BINS + 1 }, (_, i) => min + i * width), counts },
  };
}

export interface PfEstimate {
  readonly pf: number;
  readonly standardError: number;
  readonly wilson95: [number, number];
  /** -Φ⁻¹(pf); null when no sample failed. */
  readonly betaEquivalent: number | null;
  /** Zero failures: only the rule-of-three upper bound 3/N is meaningful. */
  readonly belowResolution: boolean;
  readonly upperBound: number | null;
}

/** Failure probability from `failures` of `count` samples with binomial standard error and Wilson 95 % interval. */
export function estimatePf(failures: number, count: number): PfEstimate {
  const pf = failures / count;
  const z = 1.959963984540054;
  const denominator = 1 + (z * z) / count;
  const centre = (pf + (z * z) / (2 * count)) / denominator;
  const half = (z * Math.sqrt((pf * (1 - pf)) / count + (z * z) / (4 * count * count))) / denominator;
  return {
    pf,
    standardError: Math.sqrt((pf * (1 - pf)) / count),
    wilson95: [Math.max(centre - half, 0), Math.min(centre + half, 1)],
    betaEquivalent: failures === 0 || failures === count ? null : -normalInv(pf),
    belowResolution: failures === 0,
    upperBound: failures === 0 ? 3 / count : null,
  };
}

export interface FosmResult {
  readonly mean: number;
  readonly sd: number;
  /** Cornell index mean / sd (null when sd = 0). */
  readonly beta: number | null;
  readonly pf: number | null;
  /** dg/dx_i at the means. */
  readonly gradient: number[];
  /** Share of the variance of g due to each variable (sums to 1 for independent variables, may be negative when correlated). */
  readonly variance: number[];
}

/**
 * First-order second-moment: g linearised at the means, covariance from the sds and the x-space correlation.
 * @invariant exact mean / sd for g linear in x; Pf = Φ(-mean / sd) assumes g is normal
 */
export function runFosm(
  g: (x: number[]) => number,
  means: readonly number[],
  sds: readonly number[],
  correlation: (i: number, j: number) => number,
): FosmResult {
  const gradient = means.map((mean, i) => {
    const step = Math.max(1e-6 * Math.abs(mean), 1e-6 * (sds[i] ?? 1), 1e-12);
    const up = [...means];
    const down = [...means];
    up[i] = mean + step;
    down[i] = mean - step;
    return (g(up) - g(down)) / (2 * step);
  });
  const contribution = gradient.map((di, i) =>
    gradient.reduce((sum, dj, j) => sum + di * dj * (sds[i] ?? 0) * (sds[j] ?? 0) * (i === j ? 1 : correlation(i, j)), 0),
  );
  const variance = contribution.reduce((sum, c) => sum + c, 0);
  const sd = Math.sqrt(Math.max(variance, 0));
  const mean = g([...means]);
  const beta = sd > 0 ? mean / sd : null;
  return {
    mean,
    sd,
    beta,
    pf: beta === null ? null : normalCdf(-beta),
    gradient,
    variance: contribution.map((c) => (variance > 0 ? c / variance : 0)),
  };
}

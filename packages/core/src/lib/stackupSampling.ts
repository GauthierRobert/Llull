/**
 * Monte Carlo of a tolerance stack-up (GDT TR-GDT-11 / TR-GDT-22): sample i draws contributor k from Philox4x32-10 counter
 * (i mod 2^32, ⌊i / 2^32⌋, ⌊k/2⌋, 0) under the key of `seed` (words 2(k mod 2), 2(k mod 2)+1 of the block), so a sample never depends on
 * the others. Statistics are reduced per chunk of STACKUP_CHUNK samples (sum, then squared deviations from the chunk mean) and the chunks
 * are merged in index order (Chan et al. pairwise update). The native job `llull-compute stats` performs the same operations in the same
 * order, in parallel over chunks, so both give the same bits for any thread count.
 */

import { boxMuller, philox4x32, philoxKey, unitUniform } from './prng';

export const STACKUP_CHUNK = 4096;
const TWO_32 = 4294967296;

export interface SampledContributor {
  /** Mean c = nominal + (lower + upper)/2. */
  readonly centre: number;
  /** Half tolerance t = (upper − lower)/2 (uniform: x = c + t(2u − 1)). */
  readonly half: number;
  /** Standard deviation of a normal contributor (x = c + σ z). */
  readonly sigma: number;
  readonly distribution: 'normal' | 'uniform';
}

export interface SamplingInput {
  readonly contributors: readonly SampledContributor[];
  /** y = f(x) on the sampled contributor values (same order as `contributors`). */
  readonly evaluate: (x: ArrayLike<number>) => number;
  readonly samples: number;
  readonly seed: number;
  readonly lowerSpecLimit?: number;
  readonly upperSpecLimit?: number;
}

export interface SamplingStats {
  readonly samples: number;
  readonly mean: number;
  /** Unbiased (n − 1) standard deviation. */
  readonly std: number;
  readonly min: number;
  readonly max: number;
  /** Samples with y < lowerSpecLimit / y > upperSpecLimit. */
  readonly below: number;
  readonly above: number;
  /** Samples whose y is not finite (the statistics are then meaningless). */
  readonly nonFinite: number;
}

interface ChunkStats {
  n: number;
  mean: number;
  m2: number;
  min: number;
  max: number;
  below: number;
  above: number;
  nonFinite: number;
}

/** Chan et al. pairwise merge of chunk b into the running statistics a (same operation order as `llull-stats`). */
function merge(a: ChunkStats, b: ChunkStats): ChunkStats {
  const n = a.n + b.n;
  const delta = b.mean - a.mean;
  return {
    n,
    mean: a.mean + delta * (b.n / n),
    m2: a.m2 + b.m2 + delta * delta * ((a.n * b.n) / n),
    min: b.min < a.min ? b.min : a.min,
    max: b.max > a.max ? b.max : a.max,
    below: a.below + b.below,
    above: a.above + b.above,
    nonFinite: a.nonFinite + b.nonFinite,
  };
}

/** Draws the contributor values of sample `index` into `x`. */
function drawSample(input: SamplingInput, index: number, key: readonly [number, number], words: Uint32Array, x: Float64Array): void {
  const low = index % TWO_32;
  const high = Math.floor(index / TWO_32);
  const contributors = input.contributors;
  for (let k = 0; k < contributors.length; k += 1) {
    const contributor = contributors[k] as SampledContributor;
    const odd = k & 1;
    if (odd === 0) philox4x32(low, high, k >>> 1, 0, key[0], key[1], words);
    const w1 = words[2 * odd] as number;
    x[k] =
      contributor.distribution === 'normal'
        ? contributor.centre + contributor.sigma * boxMuller(w1, words[2 * odd + 1] as number)
        : contributor.centre + contributor.half * (2 * unitUniform(w1) - 1);
  }
}

function chunkStats(input: SamplingInput, start: number, end: number, key: readonly [number, number], buffer: Float64Array): ChunkStats {
  const words = new Uint32Array(4);
  const x = new Float64Array(input.contributors.length);
  const n = end - start;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let below = 0;
  let above = 0;
  let nonFinite = 0;
  for (let i = 0; i < n; i += 1) {
    drawSample(input, start + i, key, words, x);
    const y = input.evaluate(x);
    buffer[i] = y;
    if (!Number.isFinite(y)) nonFinite += 1;
    sum += y;
    if (y < min) min = y;
    if (y > max) max = y;
    if (input.lowerSpecLimit !== undefined && y < input.lowerSpecLimit) below += 1;
    if (input.upperSpecLimit !== undefined && y > input.upperSpecLimit) above += 1;
  }
  const mean = sum / n;
  let m2 = 0;
  for (let i = 0; i < n; i += 1) {
    const d = (buffer[i] as number) - mean;
    m2 += d * d;
  }
  return { n, mean, m2, min, max, below, above, nonFinite };
}

/** Monte Carlo statistics of y over `samples` (≥ 2) samples. */
export function sampleStackup(input: SamplingInput): SamplingStats {
  const key = philoxKey(input.seed);
  const buffer = new Float64Array(STACKUP_CHUNK);
  let total: ChunkStats | null = null;
  for (let start = 0; start < input.samples; start += STACKUP_CHUNK) {
    const chunk = chunkStats(input, start, Math.min(input.samples, start + STACKUP_CHUNK), key, buffer);
    total = total === null ? chunk : merge(total, chunk);
  }
  const t = total ?? { n: 0, mean: Number.NaN, m2: Number.NaN, min: Number.NaN, max: Number.NaN, below: 0, above: 0, nonFinite: 0 };
  return {
    samples: t.n,
    mean: t.mean,
    std: Math.sqrt(t.m2 / (t.n - 1)),
    min: t.min,
    max: t.max,
    below: t.below,
    above: t.above,
    nonFinite: t.nonFinite,
  };
}

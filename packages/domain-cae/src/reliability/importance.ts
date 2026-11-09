/** Importance sampling around the FORM design point: Pf = E[1(g < 0) w], u = u* + z, w = phi(u) / phi(z) = exp(-u* . z - |u*|^2 / 2). Pure. */

import { at } from './numerics';
import { standardNormalSamples } from './sampling';

export interface ImportanceEstimate {
  readonly pf: number;
  readonly standardError: number;
  /** Normal-approximation 95 % interval of Pf, clipped to [0, 1]. */
  readonly ci95: readonly [number, number];
  /** (sum w)^2 / sum w^2 over the FAILURE samples only (the ones that carry the estimate): equal-weight failures it is worth; small = the estimate rests on a few draws. */
  readonly effectiveFailureSamples: number;
  readonly failures: number;
  readonly validSamples: number;
}

/**
 * Importance-sampling estimate of P(g(u) < 0) with a unit-covariance normal density centred at `designPoint`.
 * @invariant unbiased for any centre; for a linear g and the exact design point the estimate converges to Φ(-beta) with a variance far below plain Monte Carlo; deterministic for the seed
 * @failure samples whose g is not finite are excluded and counted out of validSamples; no valid sample -> NaN estimate
 */
export function importanceSampling(
  g: (u: number[]) => number,
  designPoint: readonly number[],
  samples: number,
  seed: number,
): ImportanceEstimate {
  const d = designPoint.length;
  const z = standardNormalSamples('mc', samples, d, seed);
  const half = designPoint.reduce((sum, v) => sum + v * v, 0) / 2;
  let valid = 0;
  let failures = 0;
  let sum = 0;
  let sumSquares = 0;
  for (let k = 0; k < samples; k += 1) {
    const draw = Array.from(z.subarray(k * d, (k + 1) * d));
    const value = g(draw.map((zi, i) => zi + at(designPoint, i)));
    if (!Number.isFinite(value)) continue;
    valid += 1;
    const weight = Math.exp(-draw.reduce((acc, zi, i) => acc + zi * at(designPoint, i), 0) - half);
    if (value < 0) {
      failures += 1;
      sum += weight;
      sumSquares += weight * weight;
    }
  }
  if (valid === 0)
    return { pf: Number.NaN, standardError: Number.NaN, ci95: [0, 1], effectiveFailureSamples: 0, failures: 0, validSamples: 0 };
  const pf = sum / valid;
  const variance = Math.max(sumSquares / valid - pf * pf, 0) / valid;
  const standardError = Math.sqrt(variance);
  return {
    pf,
    standardError,
    ci95: [Math.max(pf - 1.959963984540054 * standardError, 0), Math.min(pf + 1.959963984540054 * standardError, 1)],
    effectiveFailureSamples: sumSquares > 0 ? (sum * sum) / sumSquares : 0,
    failures,
    validSamples: valid,
  };
}

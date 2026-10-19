/** Gaussian peak statistics (TR-DYN-42): exceedance probability of k sigma and the named 3-sigma peak factor default (AF-31). */

import type { PeakFactor } from '@core/model/structuralDynamics';

/**
 * erf(x) for x >= 0 by the all-positive series erf(x) = 2/sqrt(pi) exp(-x^2) sum_n 2^n x^(2n+1) / (1*3*...*(2n+1)) (no cancellation),
 * summed until the term is below 1e-17 of the sum (at most 400 terms).
 */
function erf(x: number): number {
  let term = x;
  let sum = x;
  for (let n = 1; n < 400 && term > sum * 1e-17; n += 1) {
    term *= (2 * x * x) / (2 * n + 1);
    sum += term;
  }
  return (2 / Math.sqrt(Math.PI)) * Math.exp(-x * x) * sum;
}

/** P(|x| > k sigma) of a zero-mean Gaussian = erfc(k / sqrt 2), for 0 <= k <= 8. */
export const gaussianExceedance = (k: number): number => 1 - erf(k / Math.SQRT2);

export const DEFAULT_PEAK_FACTOR: PeakFactor = {
  value: 3,
  source: 'llull named default',
  defaulted: true,
  rationale: 'Gaussian 3-sigma (P(|x| > 3 sigma) = 0.27 %)',
};

/** The peak factor of a request: the caller's value with its source, else the named default. */
export function peakFactorOf(value: number | undefined, source: string | undefined): PeakFactor {
  if (value === undefined) return DEFAULT_PEAK_FACTOR;
  return {
    value,
    source: source ?? 'set by the caller',
    defaulted: false,
    rationale: `P(|x| > ${value} sigma) = ${(gaussianExceedance(value) * 100).toPrecision(3)} % for a Gaussian response`,
  };
}

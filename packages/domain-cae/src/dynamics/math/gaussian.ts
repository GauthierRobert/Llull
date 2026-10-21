/** Gaussian peak statistics (TR-DYN-42): exceedance probability of k sigma and the named 3-sigma peak factor default (AF-31). */

import type { PeakFactor } from '@core/model/structuralDynamics';
import { erf } from '@lib/specialFunctions';

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

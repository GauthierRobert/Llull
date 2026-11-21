/** Extremes of an amplitude table. */

import type { Amplitude } from '@core/model/thermalBc';
import { maxOf, minOf } from '@lib/arrayExtrema';

/** [min, max] of the factors of `points` ([1, 1] for an empty table). */
export function amplitudeRange(points: Amplitude['points']): readonly [number, number] {
  const factors = points.map(([, factor]) => factor);
  return factors.length === 0 ? [1, 1] : [minOf(factors), maxOf(factors)];
}

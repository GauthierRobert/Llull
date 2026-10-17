/** Extremes of an amplitude table. */

import type { Amplitude } from '@core/model/analysis';

/** [min, max] of the factors of `points` ([1, 1] for an empty table). */
export function amplitudeRange(points: Amplitude['points']): readonly [number, number] {
  const factors = points.map(([, factor]) => factor);
  return factors.length === 0 ? [1, 1] : [Math.min(...factors), Math.max(...factors)];
}

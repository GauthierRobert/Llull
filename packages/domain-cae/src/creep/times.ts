/** Output times of a creep hold (`*TIME POINTS`, CalculiX step time = seconds from the hold start). */

import type { CreepStepSpec } from '@core/model/creep';
import { num } from '../decks/format';

/**
 * Strictly increasing output times in seconds, the last one exactly `durationS`. Log: `count` times from the first increment to the end; linear: every
 * `everyS`, then the end. Values equal after the deck's 12-digit rounding are written once.
 * @invariant deterministic; at most `count` (log) or 200 (linear) times; always ends at the duration
 */
export function outputTimesS(spec: Pick<CreepStepSpec, 'durationS' | 'initialIncrementS' | 'outputTimes'>): number[] {
  const { durationS, initialIncrementS, outputTimes } = spec;
  const times: number[] = [];
  if (outputTimes.kind === 'log') {
    const first = Math.min(initialIncrementS, durationS);
    for (let index = 0; index < outputTimes.count - 1; index += 1)
      times.push(first * (durationS / first) ** (index / (outputTimes.count - 1)));
  } else {
    for (let k = 1; k * outputTimes.everyS < durationS * (1 - 1e-12); k += 1) times.push(k * outputTimes.everyS);
  }
  times.push(durationS);
  const seen = new Set<string>();
  return times.filter((time) => {
    const key = num(time);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** CalculiX step number of the hold: 2 after a preload step, else 1. */
export const holdStepNumber = (preloadStep: boolean): number => (preloadStep ? 2 : 1);

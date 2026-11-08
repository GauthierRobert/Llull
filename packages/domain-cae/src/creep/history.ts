/** Hold result sets of a creep results artifact and the bounded selection of their points (PHY-11 TR-CRP-51, 52). */

import type { AnalysisCase, FeResultsArtifact } from '@core/model/analysis';
import type { ResultStep } from '../results/fields';
import { holdStepNumber } from './times';

/** Most history points one probe keeps in the document (TR-CRP-52). */
export const MAX_HISTORY_POINTS = 200;
/** Most probes whose histories the document keeps (TR-CRP-52). */
export const MAX_HISTORY_PROBES = 32;

/** The frd time column carries 10 significant digits: the hold time subtracts the preload period and keeps 9, so float noise never reaches a history. */
const HOLD_TIME_DIGITS = 9;

export interface HoldSet {
  readonly step: ResultStep;
  /** Seconds from the start of the hold: CalculiX total time minus the preload step. */
  readonly holdTimeS: number;
}

/**
 * The stored result sets of the hold step in time order, with their hold time.
 * @invariant a case without a creep step has none; sets of the preload step are never returned
 */
export function holdSets(analysis: AnalysisCase, results: FeResultsArtifact): HoldSet[] {
  const { creep } = analysis;
  if (creep === undefined) return [];
  const number = holdStepNumber(creep.preloadStep);
  return results.steps
    .filter((step) => step.step === number)
    .map((step) => ({ step, holdTimeS: Number((step.time - creep.preloadPeriodS).toPrecision(HOLD_TIME_DIGITS)) }))
    .sort((a, b) => a.holdTimeS - b.holdTimeS);
}

/**
 * At most `limit` indices of `times` (ascending): the first, the last and the points nearest to log-spaced target times in between.
 * @invariant deterministic, strictly increasing, includes the last index; all indices when there are no more than `limit` points
 */
export function selectIndices(times: readonly number[], limit: number = MAX_HISTORY_POINTS): number[] {
  const count = times.length;
  if (count <= limit) return times.map((_, index) => index);
  const positive = times.findIndex((time) => time > 0);
  const first = positive < 0 ? 0 : positive;
  const low = Math.max(times[first] ?? Number.MIN_VALUE, Number.MIN_VALUE);
  const high = times[count - 1] ?? low;
  const chosen = new Set<number>([0, count - 1]);
  for (let k = 1; k < limit - 1; k += 1) {
    const target = low * (high / low) ** (k / (limit - 1));
    const distance = (index: number): number => Math.abs((times[index] ?? Number.NaN) - target);
    let best = first;
    for (let index = first; index < count; index += 1) if (distance(index) < distance(best)) best = index;
    chosen.add(best);
  }
  return [...chosen].sort((a, b) => a - b);
}

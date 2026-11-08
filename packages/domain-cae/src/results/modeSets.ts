/** Mode k's result set of a modal / buckling results artifact: the one rule shared by the result view (plotSetup) and the imperfection deck. */

import type { FeResultsArtifact } from '@core/model/analysis';
import type { ResultStep } from './fields';

/**
 * Relative tolerance between a buckling mode set's time (its factor in the .frd, e.g. 4623.062281) and a factor read from the .dat table,
 * which ccx 2.21 prints to 7 significant digits (4623.062). Measured in the real PHY-05 VC-NLS-50 run.
 */
const FACTOR_MATCH = 1e-5;

/**
 * Mode sets in mode order. Modal: every set (time = frequency). Buckling: every set but the zero-time reference set; NEGATIVE factors (ccx
 * reports a load reversal) are kept, so set k is mode k + 1 in the order of the .dat factor table [the k-th set with a positive time shifted
 * every later mode by one when a factor was negative].
 */
export const modeSets = (results: FeResultsArtifact, type: 'modal' | 'buckling'): ResultStep[] =>
  type === 'buckling' ? results.steps.filter((set) => set.time !== 0) : [...results.steps];

/**
 * The set of mode `mode` (1-based). With a known buckling `factor` (from the .dat table or pinned by add_imperfection) the set must carry it
 * within FACTOR_MATCH, else the mode order of the artifact is not the order the factor came from.
 * @failure no such mode -> text; factor mismatch -> text naming both factors
 */
export function modeSet(
  results: FeResultsArtifact,
  type: 'modal' | 'buckling',
  mode: number,
  factor?: number,
): { readonly set: ResultStep; readonly count: number } | string {
  const sets = modeSets(results, type);
  const set = sets[mode - 1];
  if (set === undefined) return `the results hold ${sets.length} mode(s), not mode ${mode}`;
  if (factor !== undefined && !(Math.abs(set.time - factor) <= FACTOR_MATCH * Math.abs(factor)))
    return `mode ${mode} of the results has buckling factor ${set.time}, not ${factor}: the mode order does not match`;
  return { set, count: sets.length };
}

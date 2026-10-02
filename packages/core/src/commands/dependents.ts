/**
 * Parameter → feature dependencies: which history steps read which parameters, and
 * regeneration of only what a parameter change affects.
 *
 * @layer core/commands
 * @pure
 */

import type { CadDocument, FeatureStep, Parameter } from '../model/types';
import { extractReferences } from './expression';
import { replayHistory } from './history';
import { currentContext } from './context';

/** Parameter names referenced by `=expr` strings anywhere in `params`. */
export function parametersReadBy(params: unknown, into = new Set<string>()): Set<string> {
  if (typeof params === 'string') {
    if (params.startsWith('='))
      for (const name of extractReferences(params.slice(1))) into.add(name);
  } else if (Array.isArray(params)) {
    for (const item of params) parametersReadBy(item, into);
  } else if (params !== null && typeof params === 'object') {
    for (const value of Object.values(params)) parametersReadBy(value, into);
  }
  return into;
}

/** Names whose evaluated value (or existence) differs between two parameter tables. */
export function changedParameters(
  before: Record<string, Parameter>,
  after: Record<string, Parameter>,
): Set<string> {
  const changed = new Set<string>();
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[name]?.value !== after[name]?.value) changed.add(name);
  }
  return changed;
}

/** Live steps whose params read any of `names`. */
export function stepsReading(history: readonly FeatureStep[], names: Set<string>): FeatureStep[] {
  if (names.size === 0) return [];
  return history.filter(
    (step) => !step.suppressed && [...parametersReadBy(step.params)].some((n) => names.has(n)),
  );
}

/**
 * After a parameter-table edit (`before` → `after`), regenerate the model when any step reads a
 * changed parameter. Unchanged history prefixes come from the replay cache, so only the steps
 * from the first dependent onward re-run.
 * @returns the regenerated document and the number of dependent steps (0 → `after` untouched)
 */
export function regenerateParameterDependents(
  before: CadDocument,
  after: CadDocument,
): { document: CadDocument; dependentSteps: number } {
  const dependents = stepsReading(
    after.featureHistory,
    changedParameters(before.parameters, after.parameters),
  );
  if (dependents.length === 0) return { document: after, dependentSteps: 0 };
  const regenerated = replayHistory(after, after.featureHistory, currentContext().registry);
  return { document: regenerated, dependentSteps: dependents.length };
}

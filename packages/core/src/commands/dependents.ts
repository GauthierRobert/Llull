/**
 * Parameter → feature dependencies: which history steps read which parameters, and
 * regeneration of only what a parameter change affects.
 *
 * @layer core/commands
 * @pure
 */

import type { CadDocument, FeatureStep, Parameter } from '../model/types';
import { extractReferences } from './expression';
import { stringLeaves } from './regenerate';
import { replayHistory } from './replay';
import { currentContext } from './context';
import { kernelRefusal } from './kernelRefusal';

/** Parameter names referenced by `=expr` strings anywhere in `params`. */
export function parametersReadBy(params: unknown, into = new Set<string>()): Set<string> {
  for (const text of stringLeaves(params)) {
    if (text.startsWith('=')) for (const name of extractReferences(text.slice(1))) into.add(name);
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

/** Commands whose params hold bare (no `=`) dimensional expressions evaluated against parameters. */
const CONSTRAINT_COMMANDS: ReadonlySet<string> = new Set(['add_constraint', 'update_constraint']);

/** Identifiers in every string of `params`, `=` or not (conservative: an id may read as a name). */
function bareExpressionRefs(params: unknown, into: Set<string>): void {
  for (const text of stringLeaves(params)) {
    for (const name of extractReferences(text.startsWith('=') ? text.slice(1) : text)) {
      into.add(name);
    }
  }
}

/**
 * Parameters a step reads: its own `=expr` params, the steps of an instantiated recipe, and the
 * bare dimensional expressions of constraint steps.
 */
function parametersReadByStep(
  step: FeatureStep,
  doc: Pick<CadDocument, 'recipes'>,
  depth = 0,
): Set<string> {
  const names = parametersReadBy(step.params);
  if (CONSTRAINT_COMMANDS.has(step.name)) bareExpressionRefs(step.params, names);
  if (step.name === 'instantiate_recipe' && depth < 8) {
    const recipeName = (step.params as { name?: unknown } | null)?.name;
    const recipe = typeof recipeName === 'string' ? doc.recipes[recipeName] : undefined;
    for (const inner of recipe?.steps ?? []) {
      for (const name of parametersReadByStep(inner, doc, depth + 1)) names.add(name);
    }
  }
  return names;
}

/** Live steps that read any of `names` (directly, via a recipe, or via a constraint). */
export function stepsReading(
  history: readonly FeatureStep[],
  names: Set<string>,
  doc: Pick<CadDocument, 'recipes'> = { recipes: {} },
): FeatureStep[] {
  if (names.size === 0) return [];
  return history.filter(
    (step) =>
      !step.suppressed && [...parametersReadByStep(step, doc)].some((name) => names.has(name)),
  );
}

/**
 * After a parameter-table edit (`before` → `after`), regenerate the model when any step reads a
 * changed parameter. Unchanged history prefixes come from the replay cache, so only the steps
 * from the first dependent onward re-run.
 * @returns the regenerated document and the number of dependent steps (0 → `after` untouched)
 * @failure dependents need the geometry kernel and none is available -> `refusal` set, `after`
 *   returned unregenerated (the caller no-ops)
 */
export function regenerateParameterDependents(
  before: CadDocument,
  after: CadDocument,
): { document: CadDocument; dependentSteps: number; refusal?: string } {
  const dependents = stepsReading(
    after.featureHistory,
    changedParameters(before.parameters, after.parameters),
    after,
  );
  if (dependents.length === 0) return { document: after, dependentSteps: 0 };
  const refusal = kernelRefusal(after, after.featureHistory);
  if (refusal !== null) return { document: after, dependentSteps: dependents.length, refusal };
  const regenerated = replayHistory(after, after.featureHistory, currentContext().registry);
  return { document: regenerated, dependentSteps: dependents.length };
}

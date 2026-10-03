/**
 * Kernel readiness for history operations: a replay whose live steps (including the steps of
 * every instantiated recipe) need the geometry kernel cannot run without one — it would silently
 * drop that geometry. Callers refuse up front with an explicit summary instead.
 *
 * @layer core/commands
 * @pure
 */

import type { CadDocument, FeatureStep } from '../model/types';
import type { CommandLookup } from './context';
import { currentContext } from './context';

function recipeSteps(doc: Pick<CadDocument, 'recipes'>, step: FeatureStep): FeatureStep[] {
  if (step.name !== 'instantiate_recipe') return [];
  const name = (step.params as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? (doc.recipes[name]?.steps ?? []) : [];
}

/** Name of the first live step (recursing into recipes) that needs the kernel, else null. */
function kernelStepIn(
  doc: Pick<CadDocument, 'recipes'>,
  steps: readonly FeatureStep[],
  registry: CommandLookup,
  depth = 0,
): string | null {
  for (const step of steps) {
    if (step.suppressed) continue;
    if (registry(step.name)?.annotations?.requiresKernel === true) return step.name;
    if (depth < 8) {
      const nested = kernelStepIn(doc, recipeSteps(doc, step), registry, depth + 1);
      if (nested !== null) return nested;
    }
  }
  return null;
}

/**
 * Refusal text when replaying `steps` needs the kernel and the active context has none, else null.
 * @failure no kernel + a kernel step (top-level or inside a recipe) -> refusal summary
 */
export function kernelRefusal(
  doc: Pick<CadDocument, 'recipes'>,
  steps: readonly FeatureStep[],
  registry: CommandLookup = currentContext().registry,
): string | null {
  if (currentContext().kernel !== null) return null;
  const step = kernelStepIn(doc, steps, registry);
  return step === null
    ? null
    : `step '${step}' needs the geometry kernel, which is not available yet; document unchanged — retry once the kernel is ready.`;
}

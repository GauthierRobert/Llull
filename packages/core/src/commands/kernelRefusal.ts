/**
 * Refusal summaries for kernel-dependent work while no geometry kernel is installed: single commands (`kernelUnavailable`) and replays
 * whose live steps, recipes included, need the kernel (refusing beats silently dropping that geometry).
 */

import type { CadDocument, FeatureStep } from '../model/types';
import { currentContext } from './context';
import type { CommandLookup, ExecutionContext } from './types';

function recipeSteps(doc: Pick<CadDocument, 'recipes'>, step: FeatureStep): FeatureStep[] {
  if (step.name !== 'instantiate_recipe') return [];
  const name = (step.params as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? (doc.recipes[name]?.steps ?? []) : [];
}

/** Commands a recorded `build_project` step (a loop plan) will run, nested loops included. */
function plannedCommands(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(plannedCommands);
  if (value === null || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const own = typeof record['command'] === 'string' ? [record['command']] : [];
  return [...own, ...plannedCommands(record['actions']), ...plannedCommands(record['step'])];
}

/** Name of the first live step (recursing into recipes) that needs the kernel, else null. */
function kernelStepIn(doc: Pick<CadDocument, 'recipes'>, steps: readonly FeatureStep[], registry: CommandLookup, depth = 0): string | null {
  for (const step of steps) {
    if (step.suppressed) continue;
    if (registry(step.name)?.annotations?.requiresKernel === true) return step.name;
    if (step.name === 'build_project') {
      const planned = plannedCommands(step.params).find((name) => registry(name)?.annotations?.requiresKernel === true);
      if (planned !== undefined) return planned;
    }
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
  ctx: ExecutionContext = currentContext(),
): string | null {
  if (ctx.kernel !== null) return null;
  const step = kernelStepIn(doc, steps, ctx.registry);
  return step === null
    ? null
    : `step '${step}' needs the geometry kernel, which is not available yet; document unchanged — retry once the kernel is ready.`;
}

/** No-op summary of a kernel-dependent command invoked while no kernel is installed. */
export function kernelUnavailable(command: string): string {
  return `${command}: geometry kernel not available (still loading or not installed); document unchanged — retry once the kernel is ready.`;
}

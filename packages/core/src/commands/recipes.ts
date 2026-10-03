import type { CadDocument, FeatureStep, Recipe } from '../model/types';
import { kernelRefusal } from './kernelRefusal';
import { currentContext, runInContext } from './context';
import type { CommandDefinition, CommandResult } from './types';
import { defineCommand, z } from './schema';
import { noop } from './noop';
import { MAX_PROJECT_DEPTH, MAX_PROJECT_STEPS } from './limits';
import { resolveStepForReplay, runReplayStep } from './replayStep';

/**
 * Replay `steps` ADDITIVELY on top of `base` (not from createEmptyDocument).
 *
 * Fresh entity ids are assigned by the underlying commands (nextId calls). The
 * function maintains its own `idMap` so that id references within the recipe's
 * steps (e.g. a move_entity referencing a box created in a prior step) are
 * correctly rewritten to the new ids produced during this instantiation pass.
 *
 * `=expr` strings in params are resolved against `base.parameters` before each step.
 * Steps that name an unknown command or whose `run` throws are silently skipped
 * (graceful degradation — the recipe may reference commands available when it was
 * saved but not in the current registry).
 *
 * Returns `{ doc, allAffected }` where `allAffected` is the union of all
 * `result.affected` ids created across every step.
 *
 * @pure — never mutates `base`.
 */
function replayRecipeAdditive(
  base: CadDocument,
  steps: readonly FeatureStep[],
  getCommandFn: (name: string) => CommandDefinition<unknown> | undefined,
  resolveWarnings?: string[],
): { doc: CadDocument; allAffected: string[] } {
  let doc = base;
  const idMap = new Map<string, string>();
  const allAffected: string[] = [];
  // Entities that already existed before instantiation must not be reported as
  // "new" if a recipe step merely modifies them (e.g. a move on the just-created box).
  const baseIds = new Set(Object.keys(base.entities));
  const seen = new Set<string>();

  for (const step of steps) {
    if (step.suppressed) continue;
    const cmd = getCommandFn(step.name);
    if (!cmd) continue; // unknown command — skip gracefully

    const params = resolveStepForReplay(step, doc, idMap, resolveWarnings, 'recipe step');
    const result = runReplayStep(cmd, step, doc, params, idMap, currentContext(), false);
    if (!result) continue;
    doc = result.document;
    for (const id of result.affected) {
      if (!baseIds.has(id) && !seen.has(id)) {
        seen.add(id);
        allAffected.push(id);
      }
    }
  }

  return { doc, allAffected };
}

/**
 * @command save_recipe
 * @pure
 * @layer core/commands
 * @affects adds or replaces an entry in CadDocument.recipes; does NOT change geometry
 * @invariant featureHistory is not modified; existing recipes with other names are untouched
 * @failure blank/whitespace-only name → no-op, affected:[]
 */
export const saveRecipe = defineCommand({
  name: 'save_recipe',
  description:
    'Snapshot the current featureHistory into a named recipe stored in the document. ' +
    'A recipe is a saved constructive sequence that can be re-instantiated any number of ' +
    'times (on this or any document) via instantiate_recipe, each time producing independent ' +
    'entities with fresh ids. Saving does NOT change any geometry. ' +
    'If a recipe with the same name already exists it is replaced.',
  params: z.object({
    name: z
      .string()
      .describe(
        'Unique lookup key for the recipe, e.g. "bracket_v1", "wheel_assembly". ' +
          'Must be a non-empty, non-whitespace-only string. ' +
          'Used as both the display name and the key for instantiate_recipe.',
      ),
    label: z
      .string()
      .optional()
      .describe(
        'Optional human/AI note describing the recipe\'s purpose, e.g. "L-bracket with 3 holes".',
      ),
  }),
  // Does not change geometry → metaHistory so execute() does not append a FeatureStep.
  // idempotent: saving the same recipe name twice with the same history yields the same result.
  annotations: { metaHistory: true, idempotent: true },
  run: (doc, { name, label }): CommandResult => {
    if (name.trim() === '') {
      return noop(doc, 'save_recipe failed: name must be a non-empty, non-whitespace-only string.');
    }

    // Deep-copy the steps so mutations to the live featureHistory cannot corrupt saved recipes.
    const steps: FeatureStep[] = doc.featureHistory.map((s) => ({ ...s }));

    const recipe: Recipe = {
      name,
      steps,
      ...(label !== undefined ? { label } : {}),
    };

    const newDoc: CadDocument = {
      ...doc,
      recipes: {
        ...doc.recipes,
        [name]: recipe,
      },
    };

    const stepCount = steps.length;
    const emptySuffix = stepCount === 0 ? ' (empty recipe — no steps in featureHistory)' : '';
    return {
      document: newDoc,
      summary: `save_recipe '${name}': saved ${stepCount} step${stepCount === 1 ? '' : 's'}${emptySuffix}.`,
      affected: [],
    };
  },
});

/**
 * @command instantiate_recipe
 * @pure
 * @layer core/commands
 * @affects all entity ids created by replaying the recipe's steps (returned in affected)
 * @invariant existing entities are untouched; recipe steps are applied additively
 * @failure unknown recipe name → no-op, affected:[]
 */
export const instantiateRecipe = defineCommand({
  name: 'instantiate_recipe',
  description:
    "Replay a named recipe's steps ADDITIVELY on top of the current document, " +
    'assigning fresh entity ids each time. Existing entities are never removed or changed. ' +
    'Each call is independent — instantiating the same recipe twice produces two separate ' +
    'copies, each with their own unique ids. ' +
    'The recipe must already exist (call save_recipe first). ' +
    'The step is recorded in featureHistory so replaying the history re-expands the recipe.',
  params: z.object({
    name: z
      .string()
      .describe(
        'Name of the recipe to instantiate. Must match an existing recipe created by ' +
          'save_recipe (case-sensitive). Example: "bracket_v1", "wheel_assembly".',
      ),
  }),
  // Normal constructive command — execute() appends a FeatureStep automatically.
  // No metaHistory, no readOnly, not idempotent (each call creates new entities).
  run: (doc, params, ctx): CommandResult => {
    const context = ctx ?? currentContext();
    if (context.recipeDepth >= MAX_PROJECT_DEPTH) {
      return noop(
        doc,
        `instantiate_recipe failed: nesting depth exceeds MAX_PROJECT_DEPTH (${MAX_PROJECT_DEPTH}).`,
      );
    }
    return runInContext({ ...context, recipeDepth: context.recipeDepth + 1 }, () =>
      instantiateRecipeOnce(doc, params.name),
    );
  },
});

function instantiateRecipeOnce(doc: CadDocument, name: string): CommandResult {
  if (name.trim() === '') {
    return noop(doc, 'instantiate_recipe failed: name must be a non-empty string.');
  }

  const recipe = doc.recipes[name];
  if (!recipe) {
    const available = Object.keys(doc.recipes);
    const hint =
      available.length > 0
        ? ` Available recipes: ${available.join(', ')}.`
        : ' No recipes have been saved yet (call save_recipe first).';
    return noop(doc, `instantiate_recipe failed: recipe '${name}' not found.${hint}`);
  }

  const refused = kernelRefusal(doc, recipe.steps);
  if (refused !== null) {
    return noop(doc, `instantiate_recipe: ${refused}`);
  }

  if (recipe.steps.length > MAX_PROJECT_STEPS) {
    return noop(
      doc,
      `instantiate_recipe failed: recipe '${name}' has ${recipe.steps.length} steps, exceeding MAX_PROJECT_STEPS (${MAX_PROJECT_STEPS}).`,
    );
  }

  const warnings: string[] = [];
  const { doc: newDoc, allAffected } = replayRecipeAdditive(
    doc,
    recipe.steps,
    currentContext().registry,
    warnings,
  );

  const warnSuffix =
    warnings.length > 0
      ? ` Unresolved expressions (${warnings.length}): ${warnings.join('; ')}.`
      : '';

  return {
    document: newDoc,
    summary:
      `instantiate_recipe '${name}': replayed ${recipe.steps.length} step${recipe.steps.length === 1 ? '' : 's'}, ` +
      `created ${allAffected.length} entit${allAffected.length === 1 ? 'y' : 'ies'} ` +
      `(ids: ${allAffected.join(', ')}).${warnSuffix}`,
    affected: allAffected,
  };
}

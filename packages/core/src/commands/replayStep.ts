/**
 * The single replay-step runner shared by `replayHistory` (history.ts) and recipe
 * instantiation (recipes.ts): resolve `=expr` params, remap stale ids, run, extend the id map.
 *
 * @layer core/commands
 */

import type { CadDocument, FeatureStep } from '../model/types';
import { stepIdSource, stepKeyOf } from '../lib/id';
import { type ExecutionContext, runInContext } from './context';
import type { CommandDefinition, CommandResult } from './types';
import { buildParamEnv, extendIdMap, remapIds, resolveStepParams } from './regenerate';

/**
 * Params a recorded `step` receives when replayed on `doc`: `=expr` resolved against
 * `doc.parameters` (failures pushed to `warnings` as `<warningLabel> '<name>' param ...`),
 * then ids remapped through `idMap`.
 *
 * @pure
 */
export function resolveStepForReplay(
  step: FeatureStep,
  doc: CadDocument,
  idMap: ReadonlyMap<string, string>,
  warnings: string[] | undefined,
  warningLabel: string,
): unknown {
  const { resolved, errors } = resolveStepParams(step.params, buildParamEnv(doc.parameters));
  for (const e of errors) {
    warnings?.push(
      `${warningLabel} '${step.name}' param '${e.path}': ${e.expression} — ${e.reason}`,
    );
  }
  return remapIds(resolved, idMap);
}

/** Summary suffix listing the `warnings` collected by `resolveStepForReplay`; empty when none. */
export function unresolvedExpressionsNote(warnings: readonly string[]): string {
  return warnings.length > 0
    ? ` Unresolved expressions (${warnings.length}): ${warnings.join('; ')}.`
    : '';
}

/**
 * Run `cmd` for a replayed `step`; a throw yields `null` (step skipped). On success the id map
 * is extended by zipping the step's recorded `affected` with the result's.
 *
 * @param scopeIds true ⇒ ids are minted from the step's own scope (history replay); false ⇒ the
 *   caller's context is used unchanged (recipes mint from the enclosing `instantiate_recipe` step)
 * @invariant never throws
 */
export function runReplayStep(
  cmd: CommandDefinition<unknown>,
  step: FeatureStep,
  doc: CadDocument,
  params: unknown,
  idMap: Map<string, string>,
  context: ExecutionContext,
  scopeIds: boolean,
): CommandResult | null {
  try {
    let result: CommandResult;
    if (scopeIds) {
      const stepKey = stepKeyOf(step.id);
      const stepContext: ExecutionContext = { ...context, ids: stepIdSource(stepKey), stepKey };
      result = runInContext(stepContext, () => cmd.run(doc, params, stepContext));
    } else {
      result = cmd.run(doc, params, context);
    }
    extendIdMap(idMap, step.affected, result.affected);
    return result;
  } catch {
    return null;
  }
}

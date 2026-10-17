/**
 * Runner of nestable plan loops (`{ repeat | for, actions }`). A loop that starts a top-level plan item is recorded in featureHistory as
 * ONE `build_project` step holding the loop itself (outer `$alias` refs frozen to ids), so replay re-expands it against the current
 * parameters: changing the loop count or any `=expr` input regenerates the geometry (architecture L8).
 */

import { stepIdSource } from '../../lib/id';
import { isRecord } from '../../lib/isRecord';
import { withoutConfirmations } from '../../lib/withoutConfirmations';
import type { FeatureStep } from '../../model/types';
import { currentContext, runInContext } from '../context';
import { MAX_LOOP_ITERATIONS, MAX_PROJECT_STEPS } from '../limits';
import { execStep, failStep, type PlanRun } from './exec';
import { PLAN_FIX } from './planErrors';
import { isLoopNode, resolveLoopHeader } from './loopHeader';
import { buildEnv, budgetFailure, interpolate, isPlanAction, REF, resolveRef } from './resolve';
import { type ActionItem, type LoopNode } from './types';
import { mapStringLeaves } from '../history/regenerate';

type Vars = Record<string, number>;

/** Runs the actions of one loop body; true when the run must abort. */
function runBody(run: PlanRun, index: number, items: ActionItem[], path: string, vars: Vars): boolean {
  for (let j = 0; j < items.length; j++) {
    const item = items[j] as ActionItem;
    const itemPath = `${path} › step ${j}`;
    if (++run.executedSteps > MAX_PROJECT_STEPS) {
      run.steps.push(budgetFailure(index));
      return true;
    }
    if (runItem(run, index, item, itemPath, vars)) return true;
  }
  return false;
}

function runItem(run: PlanRun, index: number, item: ActionItem, path: string, vars: Vars): boolean {
  if (isLoopNode(item)) return runLoopNode(run, index, item, path, vars);
  if (!isPlanAction(item)) {
    const legacy = isRecord(item) && (isRecord(item['repeat']) || isRecord(item['for_each']));
    const why = legacy
      ? 'a repeat/for_each with "step" cannot be nested; write { repeat, actions: [...] }'
      : 'not a valid action (needs a string "command")';
    return failStep(run, index, '(invalid)', `${path}: ${why}`, PLAN_FIX.invalidAction, path);
  }
  const env = buildEnv(run.current, vars);
  let alias: string | undefined;
  if (item.as !== undefined) {
    const filled = interpolate(item.as, env);
    if (filled.error !== null) return failStep(run, index, item.command, `${path}: ${filled.error}`, PLAN_FIX.unresolvedParam, path);
    alias = filled.text;
  }
  const r = execStep(run, index, item.command, item.params ?? {}, run.bindings, env, path, path);
  if (r.ok) {
    if (alias) run.bindings[alias] = r.affected;
    return false;
  }
  return run.onError === 'abort';
}

/** Expands one loop (header evaluated now, over the current document); true when the run must abort. */
function runLoopNode(run: PlanRun, index: number, node: LoopNode, path: string, vars: Vars): boolean {
  const header = resolveLoopHeader(node, buildEnv(run.current, vars));
  if (header.error !== null) return failStep(run, index, 'loop', `${path}: ${header.error}`, PLAN_FIX.loopHeader, path);
  if (run.loopIterations + header.values.length > MAX_LOOP_ITERATIONS)
    return failStep(
      run,
      index,
      'loop',
      `${path}: loops expand to more than MAX_LOOP_ITERATIONS (${MAX_LOOP_ITERATIONS}) iterations`,
      PLAN_FIX.loopLimit,
      path,
    );
  run.loopIterations += header.values.length;
  for (const [alias, ids] of Object.entries(node.bind ?? {}))
    if (Array.isArray(ids) && ids.every((id) => typeof id === 'string')) run.bindings[alias] ??= ids;
  for (let k = 0; k < header.values.length; k++) {
    const scope = { ...vars, [header.variable]: header.values[k] as number };
    if (runBody(run, index, node.actions, `${path} › iter ${k}`, scope)) return true;
  }
  return false;
}

/** `as` names a loop body binds (literal ones), so freezing never rewrites an inner alias. */
function innerAliases(items: readonly unknown[], into = new Set<string>()): Set<string> {
  for (const item of items) {
    if (!isRecord(item)) continue;
    if (typeof item['as'] === 'string') into.add(item['as']);
    if (Array.isArray(item['actions'])) innerAliases(item['actions'], into);
  }
  return into;
}

/** The loop with `$alias` refs to aliases bound BEFORE it replaced by their ids (replay has no aliases); outer aliases the body rebinds are seeded via `bind`. */
function freezeOuterRefs(node: LoopNode, bindings: Record<string, string[]>): LoopNode {
  const inner = innerAliases(node.actions);
  const frozen = mapStringLeaves(node, (text) => {
    const m = REF.exec(text);
    const name = m?.[1];
    if (name === undefined || inner.has(name) || bindings[name] === undefined) return text;
    const ref = resolveRef(text, bindings);
    return ref.error === null ? ref.value : text;
  }) as LoopNode;
  const rebound = Object.entries(bindings).filter(([name]) => inner.has(name));
  return rebound.length > 0 ? { ...frozen, bind: Object.fromEntries(rebound) } : frozen;
}

/**
 * Runs a loop that is a top-level plan item and records it as one replayable history step.
 * Inside an already running step (replay) the loop just runs, joining that step.
 * @invariant ids minted by the loop are step-scoped, so replay re-mints identical ids
 */
export function runLoopItem(run: PlanRun, index: number, node: LoopNode): boolean {
  const path = `step ${index}`;
  const context = currentContext();
  if (context.stepKey !== undefined) return runLoopNode(run, index, node, path, {});
  const before = run.current;
  const stepNumber = before.nextStepNumber ?? 1;
  const stepKey = String(stepNumber);
  const stepContext = { ...context, ids: stepIdSource(stepKey), stepKey };
  const firstAffected = run.allAffected.length;
  const outerBindings = { ...run.bindings };
  const abort = runInContext(stepContext, () => runLoopNode(run, index, node, path, {}));
  if (run.current !== before) {
    const step: FeatureStep = {
      id: `step-${stepKey}`,
      name: 'build_project',
      params: withoutConfirmations({
        actions: [freezeOuterRefs(node, outerBindings)],
        ...(run.onError === 'continue' ? { onError: 'continue' } : {}),
      }),
      suppressed: false,
      affected: run.allAffected.slice(firstAffected),
    };
    run.current = {
      ...run.current,
      featureHistory: [...run.current.featureHistory, step],
      nextStepNumber: Math.max(run.current.nextStepNumber ?? 1, stepNumber + 1),
    };
  }
  return abort;
}

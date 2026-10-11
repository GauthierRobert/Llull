import type { CadDocument } from '../../model/types';
import type { CommandResult } from '../types';
import { currentContext } from '../context';
import { computeSceneSnapshot } from '../inspect/scene';
import { MAX_PROJECT_ACTIONS, MAX_PROJECT_STEPS } from '../limits';
import { type ActionItem, type BuildProjectParams } from './types';
import { execStep, failStep, type PlanRun } from './exec';
import { runLoopItem } from './loop';
import { isLoopNode } from './loopHeader';
import { validatePlan } from './validate';
import {
  isPlanAction,
  isRepeatStep,
  isForEachStep,
  budgetFailure,
  rejectPlan,
  buildEnv,
  resolveCount,
  resolveForEachValues,
} from './resolve';

/** Runs a loop body `count` times; true when the run must abort. */
function runLoop(
  run: PlanRun,
  index: number,
  step: { command: string; params?: Record<string, unknown> },
  count: number,
  label: string,
  alias: string | undefined,
  iteration: (iter: number) => {
    extras: Record<string, number>;
    bindings: Record<string, string[]>;
  },
): boolean {
  let loopAffected: string[] = [];
  for (let iter = 0; iter < count; iter++) {
    if (++run.executedSteps > MAX_PROJECT_STEPS) {
      run.steps.push(budgetFailure(index));
      return true;
    }
    const { extras, bindings } = iteration(iter);
    const env = buildEnv(run.current, { i: iter, ...extras });
    const r = execStep(
      run,
      index,
      step.command,
      step.params ?? {},
      bindings,
      env,
      `${label}[${iter}]`,
    );
    loopAffected = r.affected;
    if (!r.ok && run.onError === 'abort') return true;
  }
  if (alias) run.bindings[alias] = loopAffected;
  return false;
}

/** Runs one top-level action item; true when the run must abort. */
function runAction(run: PlanRun, raw: ActionItem, index: number): boolean {
  if (isLoopNode(raw)) return runLoopItem(run, index, raw);
  if (isRepeatStep(raw)) {
    const countResult = resolveCount(raw.repeat.count, run.current);
    if (countResult.error !== null) return failStep(run, index, 'repeat', countResult.error);
    const count = Math.round(countResult.count);
    if (count < 0)
      return failStep(run, index, 'repeat', `repeat: count must be >= 0 (got ${count}).`);
    return runLoop(run, index, raw.step, count, 'repeat', raw.repeat.as, () => ({
      extras: {},
      bindings: run.bindings,
    }));
  }
  if (isForEachStep(raw)) {
    const valResult = resolveForEachValues(raw.for_each.values, run.current);
    if (valResult.error !== null) return failStep(run, index, 'for_each', valResult.error);
    const { values } = valResult;
    const alias = raw.for_each.as;
    return runLoop(run, index, raw.step, values.length, 'for_each', alias, (iter) => {
      const elem = values[iter];
      return {
        extras: typeof elem === 'number' ? { [alias]: elem } : {},
        bindings: { ...run.bindings, [alias]: [String(elem)] },
      };
    });
  }
  if (!isPlanAction(raw)) return failStep(run, index, '(invalid)', 'Not a valid action.');
  const env = buildEnv(run.current, {});
  const r = execStep(run, index, raw.command, raw.params ?? {}, run.bindings, env);
  if (r.ok) {
    if (raw.as) run.bindings[raw.as] = r.affected;
    return false;
  }
  return run.onError === 'abort';
}

/** Upper-bound count of executed commands a plan expands to (repeat/for_each multiply). */
function estimateSteps(actions: ActionItem[], doc: CadDocument): number {
  let total = 0;
  for (const raw of actions) {
    if (isRepeatStep(raw)) {
      const c = resolveCount(raw.repeat.count, doc);
      total += c.error === null && Number.isFinite(c.count) ? Math.max(0, Math.round(c.count)) : 1;
    } else if (isForEachStep(raw)) {
      const v = resolveForEachValues(raw.for_each.values, doc);
      total += v.error === null ? v.values.length : 1;
    } else {
      total += 1;
    }
  }
  return total;
}

export function runProject(
  doc: CadDocument,
  { actions, onError = 'abort', validate = false }: BuildProjectParams,
): CommandResult {
  const rejected = (summary: string): CommandResult =>
    rejectPlan(
      doc,
      { ok: false, validated: validate, stepCount: 0, steps: [], failedAt: null },
      summary,
    );
  if (actions.length === 0) return rejected('build_project: no actions provided.');
  if (actions.length > MAX_PROJECT_ACTIONS) {
    return rejected(
      `build_project: ${actions.length} actions exceeds MAX_PROJECT_ACTIONS (${MAX_PROJECT_ACTIONS}).`,
    );
  }
  const estimatedSteps = estimateSteps(actions, doc);
  if (estimatedSteps > MAX_PROJECT_STEPS) {
    return rejected(
      `build_project: plan expands to ${estimatedSteps} steps, exceeding MAX_PROJECT_STEPS (${MAX_PROJECT_STEPS}).`,
    );
  }
  if (validate) return validatePlan(doc, actions);

  const run: PlanRun = {
    current: doc,
    bindings: {},
    steps: [],
    allAffected: [],
    onError,
    executedSteps: 0,
    loopIterations: 0,
  };
  const { steps } = run;
  let failedAt: number | null = null;

  for (let i = 0; i < actions.length; i++) {
    if (++run.executedSteps > MAX_PROJECT_STEPS) {
      steps.push(budgetFailure(i));
      failedAt = steps.length - 1;
      break;
    }
    if (runAction(run, actions[i] as ActionItem, i)) {
      failedAt = i;
      break;
    }
  }

  const aborted = failedAt !== null;
  const finalDoc = aborted ? doc : run.current;
  const affected = aborted ? [] : run.allAffected;
  const allOk = !aborted && steps.every((s) => s.ok);
  // Replaying a recorded plan step (inside a running step) needs no snapshot.
  const scene = currentContext().stepKey === undefined ? computeSceneSnapshot(finalDoc) : undefined;

  let summary: string;
  if (failedAt !== null) {
    const f = steps.find((x) => x.summary.startsWith('step budget exceeded')) ?? steps.at(-1);
    summary = `Plan aborted at step ${failedAt} (${f?.command ?? '?'}): ${f?.summary ?? ''} — rolled back, document unchanged.`;
  } else {
    // Plan steps are the input actions; a repeat/for_each action expands to many executed commands.
    const failedActions = new Set(steps.filter((s) => !s.ok).map((s) => s.index));
    const okCount = actions.length - failedActions.size;
    const expanded = steps.length === actions.length ? '' : ` (${steps.length} commands executed)`;
    summary = `Plan complete: ${okCount}/${actions.length} plan step(s) ok${expanded}, ${affected.length} entit${affected.length === 1 ? 'y' : 'ies'} affected.`;
  }

  return {
    document: finalDoc,
    summary,
    affected,
    data: {
      ok: allOk,
      validated: false,
      stepCount: actions.length,
      steps,
      failedAt,
      ...(scene ? { scene } : {}),
    },
  };
}

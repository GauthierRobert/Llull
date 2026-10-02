import type { CadDocument } from '../model/types';
import type { CommandResult } from './types';
import { getCommand } from './registry';
import { executeRecorded } from './record';
import { computeSceneSnapshot } from './scene';
import { MAX_PROJECT_ACTIONS, MAX_PROJECT_STEPS } from './limits';
import { type ActionItem, type BuildProjectParams, type StepReport } from './projectTypes';
import {
  findUndefinedRef,
  isPlanAction,
  isRepeatStep,
  isForEachStep,
  budgetFailure,
  noop,
  buildEnv,
  resolveCount,
  resolveForEachValues,
  resolveExprInParam,
  recordableParams,
  STEP_PARAM_COMMANDS,
} from './projectResolve';

/**
 * Execute a single inner step (for repeat/for_each bodies) against the current doc.
 * Returns { doc, stepReport, aborted } where aborted=true means the caller should stop.
 */
export function runInnerStep(
  stepDef: { command: string; params?: Record<string, unknown> },
  current: CadDocument,
  bindings: Record<string, string[]>,
  env: Record<string, number>,
  stepLabel: string,
  steps: StepReport[],
  allAffected: string[],
  onError: 'abort' | 'continue',
  outerIndex: number,
): { doc: CadDocument; affected: string[]; aborted: boolean } {
  const { command, params = {} } = stepDef;

  if (!getCommand(command)) {
    steps.push({
      index: outerIndex,
      command,
      ok: false,
      summary: `Unknown command: ${command} (${stepLabel})`,
      affected: [],
    });
    return { doc: current, affected: [], aborted: onError === 'abort' };
  }

  const resolved = resolveExprInParam(params, bindings, env);
  if (resolved.error) {
    steps.push({
      index: outerIndex,
      command,
      ok: false,
      summary: `Param error in ${stepLabel}: ${resolved.error}`,
      affected: [],
    });
    return { doc: current, affected: [], aborted: onError === 'abort' };
  }

  const recorded = recordableParams(params, resolved.value, current.parameters);
  const result = executeRecorded(
    current,
    command,
    STEP_PARAM_COMMANDS.has(command) ? recorded : resolved.value,
    recorded,
  );
  const ok = result.affected.length > 0 || result.document !== current;
  steps.push({
    index: outerIndex,
    command,
    ok,
    summary: `${stepLabel}: ${result.summary}`,
    affected: result.affected,
  });

  if (ok) {
    allAffected.push(...result.affected);
    return { doc: result.document, affected: result.affected, aborted: false };
  }
  return { doc: current, affected: [], aborted: onError === 'abort' };
}
/** Upper-bound count of executed commands a plan expands to (repeat/for_each multiply). */
export function estimateSteps(actions: ActionItem[], doc: CadDocument): number {
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
  if (actions.length === 0) {
    return noop(
      doc,
      { ok: false, validated: validate, stepCount: 0, steps: [], failedAt: null },
      'build_project: no actions provided.',
    );
  }
  if (actions.length > MAX_PROJECT_ACTIONS) {
    return noop(
      doc,
      { ok: false, validated: validate, stepCount: 0, steps: [], failedAt: null },
      `build_project: ${actions.length} actions exceeds MAX_PROJECT_ACTIONS (${MAX_PROJECT_ACTIONS}).`,
    );
  }
  const estimatedSteps = estimateSteps(actions, doc);
  if (estimatedSteps > MAX_PROJECT_STEPS) {
    return noop(
      doc,
      { ok: false, validated: validate, stepCount: 0, steps: [], failedAt: null },
      `build_project: plan expands to ${estimatedSteps} steps, exceeding MAX_PROJECT_STEPS (${MAX_PROJECT_STEPS}).`,
    );
  }

  if (validate) {
    const defined = new Set<string>();
    const issues: string[] = [];
    actions.forEach((raw, i) => {
      if (isRepeatStep(raw) || isForEachStep(raw)) {
        // Basic structural validation for control-flow steps.
        defined.add(isRepeatStep(raw) ? (raw.repeat.as ?? '') : raw.for_each.as);
        return; // deeper validation of inner step expressions deferred to run-time
      }
      if (!isPlanAction(raw)) {
        issues.push(`step ${i}: not a valid action (needs a string "command")`);
        return;
      }
      const def = getCommand(raw.command);
      const params = raw.params ?? {};
      if (!def) {
        issues.push(`step ${i} (${raw.command}): unknown command`);
        return;
      }
      for (const req of def.paramsSchema.required) {
        if (!(req in params))
          issues.push(`step ${i} (${raw.command}): missing required param "${req}"`);
      }
      const refErr = findUndefinedRef(params, defined);
      if (refErr) issues.push(`step ${i} (${raw.command}): ${refErr}`);
      if (raw.as) defined.add(raw.as);
    });
    const ok = issues.length === 0;
    return {
      document: doc,
      summary: ok
        ? `Plan valid: ${actions.length} step(s) ready.`
        : `Plan invalid: ${issues.length} issue(s) — ${issues.join('; ')}.`,
      affected: [],
      data: { ok, validated: true, stepCount: actions.length, steps: [], failedAt: null, issues },
    };
  }

  const bindings: Record<string, string[]> = {};
  const steps: StepReport[] = [];
  const allAffected: string[] = [];
  let current = doc;
  let failedAt: number | null = null;
  let executedSteps = 0;

  for (let i = 0; i < actions.length; i++) {
    const raw = actions[i];
    if (++executedSteps > MAX_PROJECT_STEPS) {
      steps.push(budgetFailure(i));
      failedAt = steps.length - 1;
      break;
    }

    // ── repeat ──────────────────────────────────────────────────────────
    if (isRepeatStep(raw)) {
      const countResult = resolveCount(raw.repeat.count, current);
      if (countResult.error !== null) {
        steps.push({
          index: i,
          command: 'repeat',
          ok: false,
          summary: countResult.error,
          affected: [],
        });
        if (onError === 'abort') {
          failedAt = i;
          break;
        }
        continue;
      }
      const count = Math.round(countResult.count);
      if (count < 0) {
        steps.push({
          index: i,
          command: 'repeat',
          ok: false,
          summary: `repeat: count must be >= 0 (got ${count}).`,
          affected: [],
        });
        if (onError === 'abort') {
          failedAt = i;
          break;
        }
        continue;
      }
      let loopAffected: string[] = [];
      let aborted = false;
      for (let iter = 0; iter < count; iter++) {
        if (++executedSteps > MAX_PROJECT_STEPS) {
          steps.push(budgetFailure(i));
          aborted = true;
          break;
        }
        const env = buildEnv(current, { i: iter });
        const r = runInnerStep(
          raw.step,
          current,
          bindings,
          env,
          `repeat[${iter}]`,
          steps,
          allAffected,
          onError,
          i,
        );
        current = r.doc;
        loopAffected = r.affected;
        if (r.aborted) {
          aborted = true;
          break;
        }
      }
      if (aborted) {
        failedAt = i;
        break;
      }
      if (raw.repeat.as) bindings[raw.repeat.as] = loopAffected;
      continue;
    }

    // ── for_each ────────────────────────────────────────────────────────
    if (isForEachStep(raw)) {
      const valResult = resolveForEachValues(raw.for_each.values, current);
      if (valResult.error !== null) {
        steps.push({
          index: i,
          command: 'for_each',
          ok: false,
          summary: valResult.error,
          affected: [],
        });
        if (onError === 'abort') {
          failedAt = i;
          break;
        }
        continue;
      }
      if (!Array.isArray(valResult.values)) {
        steps.push({
          index: i,
          command: 'for_each',
          ok: false,
          summary: 'for_each: values did not resolve to an array.',
          affected: [],
        });
        if (onError === 'abort') {
          failedAt = i;
          break;
        }
        continue;
      }
      const alias = raw.for_each.as;
      let loopAffected: string[] = [];
      let aborted = false;
      for (let iter = 0; iter < valResult.values.length; iter++) {
        if (++executedSteps > MAX_PROJECT_STEPS) {
          steps.push(budgetFailure(i));
          aborted = true;
          break;
        }
        const elem = valResult.values[iter];
        // Inject $i and, if elem is numeric, $as as a number for expression resolution.
        const extras: Record<string, number> = { i: iter };
        if (typeof elem === 'number') extras[alias] = elem;
        const env = buildEnv(current, extras);
        // Also expose $alias as a string binding pointing to a numeric string for $alias refs.
        const iterBindings: Record<string, string[]> = {
          ...bindings,
          [alias]: [String(elem)],
        };
        const r = runInnerStep(
          raw.step,
          current,
          iterBindings,
          env,
          `for_each[${iter}]`,
          steps,
          allAffected,
          onError,
          i,
        );
        current = r.doc;
        loopAffected = r.affected;
        if (r.aborted) {
          aborted = true;
          break;
        }
      }
      if (aborted) {
        failedAt = i;
        break;
      }
      bindings[alias] = loopAffected;
      continue;
    }

    // ── plain action ────────────────────────────────────────────────────
    if (!isPlanAction(raw)) {
      steps.push({
        index: i,
        command: '(invalid)',
        ok: false,
        summary: 'Not a valid action.',
        affected: [],
      });
      if (onError === 'abort') {
        failedAt = i;
        break;
      }
      continue;
    }
    if (!getCommand(raw.command)) {
      steps.push({
        index: i,
        command: raw.command,
        ok: false,
        summary: `Unknown command: ${raw.command}`,
        affected: [],
      });
      if (onError === 'abort') {
        failedAt = i;
        break;
      }
      continue;
    }
    const env = buildEnv(current, {});
    const resolved = resolveExprInParam(raw.params ?? {}, bindings, env);
    if (resolved.error) {
      steps.push({
        index: i,
        command: raw.command,
        ok: false,
        summary: `Param error: ${resolved.error}`,
        affected: [],
      });
      if (onError === 'abort') {
        failedAt = i;
        break;
      }
      continue;
    }
    const recorded = recordableParams(raw.params ?? {}, resolved.value, current.parameters);
    const result = executeRecorded(
      current,
      raw.command,
      STEP_PARAM_COMMANDS.has(raw.command) ? recorded : resolved.value,
      recorded,
    );
    // A graceful no-op (no change + nothing affected) is a soft failure for a plan step.
    const ok = result.affected.length > 0 || result.document !== current;
    steps.push({
      index: i,
      command: raw.command,
      ok,
      summary: result.summary,
      affected: result.affected,
    });
    if (ok) {
      current = result.document;
      allAffected.push(...result.affected);
      if (raw.as) bindings[raw.as] = result.affected;
    } else if (onError === 'abort') {
      failedAt = i;
      break;
    }
  }

  const aborted = failedAt !== null;
  const finalDoc = aborted ? doc : current;
  const affected = aborted ? [] : allAffected;
  const allOk = !aborted && steps.every((s) => s.ok);
  const scene = computeSceneSnapshot(finalDoc);

  let summary: string;
  if (failedAt !== null) {
    const f = steps.find((x) => x.summary.startsWith('step budget exceeded')) ?? steps[failedAt];
    summary = `Plan aborted at step ${failedAt} (${f?.command ?? '?'}): ${f?.summary ?? ''} — rolled back, document unchanged.`;
  } else {
    const okCount = steps.filter((s) => s.ok).length;
    summary = `Plan complete: ${okCount}/${actions.length} step(s) ok, ${affected.length} entit${affected.length === 1 ? 'y' : 'ies'} affected.`;
  }

  return {
    document: finalDoc,
    summary,
    affected,
    data: { ok: allOk, validated: false, stepCount: actions.length, steps, failedAt, scene },
  };
}

import type { CadDocument } from '../../model/types';
import type { CommandResult, ExecutionContext } from '../types';
import { unknownCommandError } from '../noop';
import { PLAN_FIX, type PlanFix, planError } from './planErrors';
import { getCommand } from '../commandTable';
import { suggestCommandNames } from './unknownCommandHint';
import { executeRecorded } from '../history/record';
import { type StepReport } from './types';
import type { ResolveMemo } from '../resolveMemo';
import { resolveExprInParam, recordableParams, STEP_PARAM_COMMANDS } from './resolve';

export interface PlanRun {
  current: CadDocument;
  readonly bindings: Record<string, string[]>;
  readonly steps: StepReport[];
  readonly allAffected: string[];
  readonly onError: 'abort' | 'continue';
  executedSteps: number;
  /** Loop iterations expanded so far (capped by MAX_LOOP_ITERATIONS). */
  loopIterations: number;
  /** Commands started so far / commands the plan expands to, for `ExecutionContext.onStep`. */
  startedSteps: number;
  readonly totalSteps: number;
  readonly onStep: ExecutionContext['onStep'];
  /** The host's resolve memo when this plan runs as top-level recorded steps (ids minted per step, so a step's result is a function of its input document and params); else null. */
  readonly memo: ResolveMemo | null;
  /** Nesting depth of this plan (`ExecutionContext.projectDepth`): a step's result can depend on it (the nesting limit), so it is part of the memo key. */
  readonly depth: number;
}

/** Records a failed control-flow step (`fix` gives its code); true when the run must abort. */
export function failStep(run: PlanRun, index: number, command: string, summary: string, fix: PlanFix, path?: string): boolean {
  const error = planError(fix, path ?? `step ${index}`);
  run.steps.push({ index, command, ok: false, summary, affected: [], error, ...(path ? { path } : {}) });
  return run.onError === 'abort';
}

/** Mutating steps keep their `data` up to this many JSON characters (read-only answers are always kept). */
const MAX_STEP_DATA_CHARS = 4000;

/** The `data` / `dataOmittedChars` fields of a successful step report. */
function stepData(data: unknown, answered: boolean): Pick<StepReport, 'data' | 'dataOmittedChars'> {
  if (data === undefined) return {};
  if (answered) return { data };
  const size = JSON.stringify(data)?.length ?? 0;
  return size <= MAX_STEP_DATA_CHARS ? { data } : { dataOmittedChars: size };
}

/**
 * JSON for the memo key that tells apart every pair of values the commands can tell apart: NaN, Infinity, -Infinity and -0 (JSON.stringify prints the first
 * three as null and -0 as 0) are written as `n:<value>` and every real string as `s:<string>`, so no string can pose as a number.
 */
function stableJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'string') return `s:${item}`;
    if (typeof item === 'number' && (!Number.isFinite(item) || Object.is(item, -0))) return `n:${Object.is(item, -0) ? '-0' : item}`;
    return item;
  });
}

/** Numbers held by the meshes of the entities `result` created (new ids or replaced objects): what a kept step costs beyond its key. */
function createdMeshWeight(before: CadDocument, result: CommandResult): number {
  let weight = 0;
  for (const [id, entity] of Object.entries(result.document.entities))
    if (before.entities[id] !== entity && entity.kind === 'mesh') weight += entity.mesh.positions.length + entity.mesh.indices.length;
  return weight;
}

/**
 * `execute` of one step, served from the resolve memo when the same command ran with the same params on the very same input document in an earlier run
 * of this resolve (the host runs a plan again after each native job, 13.9). The memo never keeps a run that saw a deferred engine answer.
 * A nested `build_project` is never served whole: it runs again so its inner steps report to `onStep` on every run; they are memoized one by one.
 * @invariant the weight of a kept step is its key length plus the numbers of the meshes it created; the rest of a result shares structure with the documents and is bounded by the entry cap only
 */
function rememberedStep(run: PlanRun, command: string, given: unknown, recorded: unknown, execute: () => CommandResult): CommandResult {
  if (run.memo === null || command === 'build_project') return execute();
  let tag: string;
  try {
    const first = stableJson(given);
    tag = `step|${run.depth}|${command}|${first}|${recorded === given ? first : stableJson(recorded)}`;
  } catch {
    return execute();
  }
  const input = run.current;
  return run.memo.once(input, tag, execute, (result) => tag.length + createdMeshWeight(input, result));
}

/** Runs one command; `label` (loop bodies only) prefixes the step summaries. */
export function execStep(
  run: PlanRun,
  index: number,
  command: string,
  params: Record<string, unknown>,
  bindings: Record<string, string[]>,
  env: Record<string, number>,
  label?: string,
  path?: string,
): { ok: boolean; affected: string[] } {
  const location = path ?? `step ${index}`;
  const report = (
    ok: boolean,
    summary: string,
    affected: string[],
    extra: Pick<StepReport, 'error' | 'data' | 'dataOmittedChars'>,
  ): { ok: boolean; affected: string[] } => {
    run.steps.push({ index, command, ok, summary, affected, ...extra, ...(path ? { path } : {}) });
    return { ok, affected };
  };
  if (!getCommand(command)) {
    const hints = suggestCommandNames(command);
    const didYouMean = hints.length > 0 ? `. Did you mean: ${hints.join(', ')}?` : '';
    return report(false, `Unknown command: ${command}${label ? ` (${label})` : ''}${didYouMean}`, [], {
      error: unknownCommandError([location]),
    });
  }
  const resolved = resolveExprInParam(params, bindings, env);
  if (resolved.error)
    return report(false, `Param error${label ? ` in ${label}` : ''}: ${resolved.error}`, [], {
      error: planError(PLAN_FIX.unresolvedParam, location),
    });
  const recorded = recordableParams(params, resolved.value, run.current.parameters);
  const event = { ordinal: ++run.startedSteps, total: run.totalSteps, command, index };
  run.onStep?.({ phase: 'start', ...event });
  const given = STEP_PARAM_COMMANDS.has(command) ? recorded : resolved.value;
  const result = rememberedStep(run, command, given, recorded, () => executeRecorded(run.current, command, given, recorded));
  // A graceful no-op (no change + nothing affected) is a soft failure for a plan step; a read-only
  // query that answered (mass_properties, inspect_topology, …) is a success that changes nothing.
  const answered = getCommand(command)?.annotations?.readOnly === true && result.data !== undefined;
  const ok = result.affected.length > 0 || result.document !== run.current || answered;
  const extra = ok ? stepData(result.data, answered) : { error: result.error ?? planError(PLAN_FIX.noEffect, location) };
  report(ok, label ? `${label}: ${result.summary}` : result.summary, result.affected, extra);
  run.onStep?.({ phase: 'end', ...event, ok, stepPosition: run.steps.length - 1 });
  if (!ok) return { ok, affected: [] };
  run.current = result.document;
  run.allAffected.push(...result.affected);
  return { ok, affected: result.affected };
}

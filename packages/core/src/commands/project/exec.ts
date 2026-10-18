import type { CadDocument } from '../../model/types';
import type { ExecutionContext } from '../types';
import { unknownCommandError } from '../noop';
import { PLAN_FIX, type PlanFix, planError } from './planErrors';
import { getCommand } from '../commandTable';
import { suggestCommandNames } from './unknownCommandHint';
import { executeRecorded } from '../history/record';
import { type StepReport } from './types';
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
  const result = executeRecorded(run.current, command, STEP_PARAM_COMMANDS.has(command) ? recorded : resolved.value, recorded);
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

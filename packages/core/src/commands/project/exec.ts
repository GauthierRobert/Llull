import type { CadDocument } from '../../model/types';
import type { ExecutionContext } from '../types';
import { getCommand } from '../commandTable';
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

/** Records a failed control-flow step; true when the run must abort. */
export function failStep(run: PlanRun, index: number, command: string, summary: string, path?: string): boolean {
  run.steps.push({ index, command, ok: false, summary, affected: [], ...(path ? { path } : {}) });
  return run.onError === 'abort';
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
  const report = (ok: boolean, summary: string, affected: string[] = []): { ok: boolean; affected: string[] } => {
    run.steps.push({ index, command, ok, summary, affected, ...(path ? { path } : {}) });
    return { ok, affected };
  };
  if (!getCommand(command)) {
    return report(false, `Unknown command: ${command}${label ? ` (${label})` : ''}`);
  }
  const resolved = resolveExprInParam(params, bindings, env);
  if (resolved.error) {
    return report(false, `Param error${label ? ` in ${label}` : ''}: ${resolved.error}`);
  }
  const recorded = recordableParams(params, resolved.value, run.current.parameters);
  const event = { ordinal: ++run.startedSteps, total: run.totalSteps, command, index };
  run.onStep?.({ phase: 'start', ...event });
  const result = executeRecorded(run.current, command, STEP_PARAM_COMMANDS.has(command) ? recorded : resolved.value, recorded);
  // A graceful no-op (no change + nothing affected) is a soft failure for a plan step; a read-only
  // query that answered (mass_properties, inspect_topology, …) is a success that changes nothing.
  const answered = getCommand(command)?.annotations?.readOnly === true && result.data !== undefined;
  const ok = result.affected.length > 0 || result.document !== run.current || answered;
  report(ok, label ? `${label}: ${result.summary}` : result.summary, result.affected);
  run.onStep?.({ phase: 'end', ...event, ok, stepPosition: run.steps.length - 1 });
  if (!ok) return { ok, affected: [] };
  run.current = result.document;
  run.allAffected.push(...result.affected);
  return { ok, affected: result.affected };
}

/**
 * Per-step progress, timing and the whole-run deadline of a local `build_project` run, fed by the
 * registry's `ExecutionContext.onStep` (core stays clock- and I/O-free; this is the observer).
 */

import type { PlanStepEvent } from '@core/commands/types';
import { getCommand } from '@core/commands/registry';
import { isRecord } from '@lib/isRecord';
import type { JobProgress } from '../native/deferredRun';

/** A step slower than this earns a warning line, whatever the progress setting. */
const SLOW_STEP_MS = 10_000;

export interface StepObserverOptions {
  /** Millisecond clock (injected so tests are deterministic). */
  readonly now: () => number;
  /** One stderr line. */
  readonly print: (line: string) => void;
  /** Stream a line per step (`[12/189] boolean … 3.2s`). */
  readonly progress: boolean;
  /** Stop starting new steps this many seconds after creation. */
  readonly timeoutSeconds?: number;
  /** Stop starting new steps after this instant on the `now` clock instead (the supervisor's absolute deadline, counted from process start). */
  readonly deadlineAt?: number;
  readonly slowMs?: number;
}

/** Where a `--timeout` deadline stopped the run. */
interface TimeoutStop {
  readonly seconds: number;
  readonly ordinal: number;
  readonly total: number;
  readonly command: string;
}

export interface StepObserver {
  readonly onStep: (event: PlanStepEvent) => void;
  /** `data` of a plan report with `durationMs` added to each step that ran. */
  withDurations(data: unknown): unknown;
  /** A line from a long native job (solver iteration): printed with `--progress` (or a terminal), dropped otherwise. */
  note(line: string): void;
  /** Set when the deadline stopped the run. */
  timeout(): TimeoutStop | undefined;
}

/** `3.2s`, or `1m05s` from a minute on. */
export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(Math.floor(seconds % 60)).padStart(2, '0')}s`;
}

/** The report line a server streamed (`{ type: 'progress', ...JobProgress }`) as a line of text; unreadable fields are left out. */
export function formatStreamedProgress(event: Readonly<Record<string, unknown>>): string {
  const number = (name: string): number => (typeof event[name] === 'number' ? event[name] : 0);
  return formatJobProgress({
    op: typeof event['op'] === 'string' ? event['op'] : 'native job',
    stage: typeof event['stage'] === 'string' ? event['stage'] : '',
    message: typeof event['message'] === 'string' ? event['message'] : 'running',
    step: number('step'),
    total: number('total'),
    fraction: typeof event['fraction'] === 'number' ? event['fraction'] : null,
    elapsedMs: number('elapsedMs'),
    etaMs: typeof event['etaMs'] === 'number' ? event['etaMs'] : null,
    heartbeat: event['heartbeat'] === true,
  });
}

/** One stderr line of a native job report: `[quad_remesh] max flow 15% (stage 7/12) 16.5s elapsed, ~1m33s left`. */
export function formatJobProgress(event: Omit<JobProgress, 'op'> & { readonly op: string }): string {
  const share = event.fraction === null ? '' : ` ${Math.floor(event.fraction * 100)}%`;
  const stage = event.total > 0 ? ` (stage ${event.step}/${event.total})` : '';
  const left = event.etaMs === null ? '' : `, ~${formatDuration(event.etaMs)} left`;
  return `[${event.op}] ${event.message}${share}${stage}, ${formatDuration(event.elapsedMs)} elapsed${left}`;
}

export function createStepObserver(options: StepObserverOptions): StepObserver {
  const { now, print, progress, timeoutSeconds, slowMs = SLOW_STEP_MS } = options;
  const deadline = options.deadlineAt ?? (timeoutSeconds === undefined ? undefined : now() + timeoutSeconds * 1000);
  const startedAt = new Map<number, number>();
  const durations = new Map<number, number>();
  let stopped: TimeoutStop | undefined;

  const onStart = (event: PlanStepEvent): void => {
    if (deadline !== undefined && timeoutSeconds !== undefined && now() > deadline) {
      stopped = { seconds: timeoutSeconds, ordinal: event.ordinal, total: event.total, command: event.command };
      const abort = new Error(`--timeout ${timeoutSeconds}s exceeded before step ${event.ordinal}`);
      abort.stack = abort.message; // the registry logs a thrown error's stack: keep that to one line
      throw abort;
    }
    startedAt.set(event.ordinal, now());
    // Kernel commands (booleans, fillets) are the slow class: announce them before they block.
    if (progress && getCommand(event.command)?.annotations?.requiresKernel === true)
      print(`[${event.ordinal}/${event.total}] ${event.command} …`);
  };

  const onEnd = (event: PlanStepEvent): void => {
    const elapsed = now() - (startedAt.get(event.ordinal) ?? now());
    if (event.stepPosition !== undefined) durations.set(event.stepPosition, elapsed);
    const label = `[${event.ordinal}/${event.total}] ${event.command}`;
    if (progress) print(`${label} … ${formatDuration(elapsed)}${event.ok === false ? ' FAILED' : ''}`);
    if (elapsed >= slowMs) print(`llull: warning: slow step ${label} took ${formatDuration(elapsed)}`);
  };

  return {
    onStep: (event) => (event.phase === 'start' ? onStart(event) : onEnd(event)),
    withDurations(data) {
      if (!isRecord(data) || !Array.isArray(data['steps']) || durations.size === 0) return data;
      const steps = data['steps'].map((step: unknown, position) => {
        const durationMs = durations.get(position);
        return durationMs === undefined || !isRecord(step) ? step : { ...step, durationMs };
      });
      return { ...data, steps };
    },
    note: (line) => {
      if (progress) print(line);
    },
    timeout: () => stopped,
  };
}

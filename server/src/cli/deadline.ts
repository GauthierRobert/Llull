/** The signal of a local run: Ctrl-C (`parent`) and the `--timeout` deadline, whichever comes first. */

/** Set by the supervisor (`supervisor.ts`) in the child's environment: the absolute deadline of the run, in epoch milliseconds, counted from the supervisor's start. */
export const DEADLINE_ENV = 'LLULL_CLI_DEADLINE_MS';

/** The absolute deadline (epoch ms) the supervisor handed down, or undefined. */
export function deadlineFromEnv(env: Readonly<Record<string, string | undefined>>): number | undefined {
  const value = Number(env[DEADLINE_ENV]);
  return env[DEADLINE_ENV] !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * `parent`, or a signal that also aborts `seconds` after this call with the reason `{ code: 'MESH_TIMEOUT', message }`. The deadline can only fire while the
 * event loop is free, i.e. while a native mesh job is awaited: that is what stops a job the step-by-step deadline of `createStepObserver` never reaches. The
 * deadline counts from `deadlineAt` (epoch ms) when the supervisor gave one: a slow boot must not let it kill the child before this clean refusal. The
 * run then ends in a refusal on the unchanged document (nothing is saved); the supervisor of `bin.ts` handles a blocking step.
 */
export function withDeadline(parent: AbortSignal | undefined, seconds: number | undefined, deadlineAt?: number): AbortSignal | undefined {
  if (seconds === undefined) return parent;
  const controller = new AbortController();
  if (parent?.aborted === true) controller.abort(parent.reason);
  parent?.addEventListener('abort', () => controller.abort(parent.reason), { once: true });
  setTimeout(
    () =>
      controller.abort({
        code: 'MESH_TIMEOUT',
        message: `llull: timed out after ${seconds}s (--timeout); the native mesh job was stopped, nothing was applied.`,
      }),
    deadlineAt !== undefined ? Math.max(0, deadlineAt - Date.now()) : seconds * 1000,
  ).unref();
  return controller.signal;
}

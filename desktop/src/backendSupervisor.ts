/**
 * Keeps the local backend alive (A-10, FR-DSF-09). When the backend exits on its own after it started answering, it is started again (same
 * port, same token, so the renderer's reconnect finds it) with `LLULL_RECOVERY_RESUME=1`: the new process loads the recovery slot the old one
 * was working on, so the document comes back. Restarts are bounded by ATTEMPTS WITHIN A WINDOW (default 3 per 60 s, with a growing delay),
 * not by a lifetime count: a backend that crashes once a day is restarted forever, one that crash-loops is reported as failed.
 * Supervision only: no document logic here. The restarted process is a child exactly like the first (never detached), so it ends with the app;
 * `stop()` ends only the process this supervisor started, through `startBackend`'s own stop.
 */
import { errorMessage } from '@lib/errorMessage';
import { startBackend, type ForkBackend, type RunningBackend } from './backend';

export type BackendState =
  | { readonly state: 'running' }
  | { readonly state: 'restarting'; readonly attempt: number; readonly reason: string }
  | { readonly state: 'failed'; readonly reason: string };

interface SupervisorOptions {
  readonly fork: ForkBackend;
  readonly entry: string;
  readonly env: Record<string, string>;
  readonly url: string;
  readonly token?: string;
  /** Called on every state change after the first start. */
  readonly onState?: (state: BackendState) => void;
  /** Restart attempts allowed within `windowMs` (default 3). */
  readonly maxRestarts?: number;
  /** The window of the bound (default 60 000 ms). */
  readonly windowMs?: number;
  /** Delay before restart attempt `n` (1-based) of the current window (default 500 ms doubling). */
  readonly backoffMs?: (attempt: number) => number;
  /** Injected for tests. */
  readonly start?: typeof startBackend;
  readonly now?: () => number;
}

const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_WINDOW_MS = 60_000;
const defaultBackoff = (attempt: number): number => 500 * 2 ** (attempt - 1);

export interface SupervisedBackend extends RunningBackend {
  /** Pid of the backend process that is current now. */
  readonly pid: number | undefined;
}

/** @failure the first start fails -> rejects (as `startBackend`); later failures end in a `failed` state and the backend stays down */
export async function superviseBackend(options: SupervisorOptions): Promise<SupervisedBackend> {
  const start = options.start ?? startBackend;
  const now = options.now ?? Date.now;
  const maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const backoff = options.backoffMs ?? defaultBackoff;
  const emit = (state: BackendState): void => options.onState?.(state);

  let current: RunningBackend = await start(options.fork, options.entry, options.env, options.url, options.token);
  let stopping = false;
  let attempts: number[] = []; // times of the restart attempts inside the window
  let wake: (() => void) | null = null; // ends a backoff wait early when stop() is called
  let restarting: Promise<void> = Promise.resolve(); // the restart in flight (stop() waits for it, then stops what it started)

  const pause = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const restart = async (reason: string): Promise<void> => {
    while (!stopping) {
      const at = now();
      attempts = attempts.filter((time) => at - time < windowMs);
      if (attempts.length >= maxRestarts) {
        emit({ state: 'failed', reason: `${reason} (${maxRestarts} restarts in ${Math.round(windowMs / 1000)} s)` });
        return;
      }
      attempts.push(at);
      emit({ state: 'restarting', attempt: attempts.length, reason });
      await pause(backoff(attempts.length));
      if (stopping) return;
      try {
        const next = await start(options.fork, options.entry, { ...options.env, LLULL_RECOVERY_RESUME: '1' }, options.url, options.token);
        if (stopping) {
          await next.stop(); // quit arrived while it was starting: do not leave it behind
          return;
        }
        current = next;
        next.onUnexpectedExit(onExit);
        emit({ state: 'running' });
        return;
      } catch (error) {
        reason = `the backend did not restart: ${errorMessage(error)}`;
      }
    }
  };

  const onExit = (code: number | null): void => {
    if (!stopping) restarting = restart(`the backend exited (code ${String(code)})`);
  };

  current.onUnexpectedExit(onExit);

  return {
    url: options.url,
    get pid() {
      return current.pid;
    },
    onUnexpectedExit: () => undefined, // the supervisor consumes crashes itself
    async stop() {
      stopping = true;
      wake?.();
      await restarting.catch(() => undefined); // a start in flight ends with its own child stopped (see restart)
      await current.stop();
    },
  };
}

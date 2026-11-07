/**
 * Running flow solves of this host process (12 CFD M3a, `cfd_stop`). Identical solves (same case, same job files) share one native run;
 * every caller joins with its own signal and progress sink.
 * @invariant a caller whose signal aborts stops waiting at once ('detached'); the run is killed (process tree) when its last waiter leaves
 * @invariant `stop(caseId)` kills every run of the case for all its waiters ('stopped'); a stopped run never yields a value, even when it
 *   finished in the same tick (the caller commits nothing)
 * @invariant an entry is removed when its run settles, is stopped or loses its last waiter: a later solve starts fresh
 */

type JoinOutcome<T> = { readonly kind: 'done'; readonly value: T } | { readonly kind: 'stopped' } | { readonly kind: 'detached' };

export interface RunningSolve {
  readonly caseId: string;
  readonly key: string;
  readonly startedAt: number;
  readonly waiters: number;
}

interface Entry<T> {
  readonly caseId: string;
  readonly key: string;
  readonly startedAt: number;
  readonly controller: AbortController;
  readonly listeners: Set<(line: string) => void>;
  readonly promise: Promise<T>;
  waiters: number;
  stopped: boolean;
  settled: boolean;
}

interface Caller {
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((line: string) => void) | undefined;
}

export interface SolveRegistry<T> {
  /** Joins the run of `key` (starting it with `start` when none runs) and waits for it, for a stop, or for the caller's own signal. */
  join(
    key: string,
    caseId: string,
    start: (signal: AbortSignal, progress: (line: string) => void) => Promise<T>,
    caller: Caller,
  ): Promise<JoinOutcome<T>>;
  /** Kills every run of `caseId`; returns what was running. */
  stop(caseId: string): RunningSolve[];
  list(): RunningSolve[];
}

export function createSolveRegistry<T>(now: () => number = Date.now): SolveRegistry<T> {
  const running = new Map<string, Entry<T>>();
  const describe = (entry: Entry<T>): RunningSolve => ({
    caseId: entry.caseId,
    key: entry.key,
    startedAt: entry.startedAt,
    waiters: entry.waiters,
  });
  const forget = (entry: Entry<T>): void => {
    if (running.get(entry.key) === entry) running.delete(entry.key);
  };
  const launch = (key: string, caseId: string, start: (signal: AbortSignal, progress: (line: string) => void) => Promise<T>): Entry<T> => {
    const controller = new AbortController();
    const listeners = new Set<(line: string) => void>();
    const entry: Entry<T> = {
      caseId,
      key,
      startedAt: now(),
      controller,
      listeners,
      promise: start(controller.signal, (line) => {
        for (const listener of listeners) listener(line);
      }),
      waiters: 0,
      stopped: false,
      settled: false,
    };
    void entry.promise.finally(() => {
      entry.settled = true;
      forget(entry);
    });
    return entry;
  };
  return {
    join(key, caseId, start, caller) {
      if (caller.signal?.aborted === true) return Promise.resolve({ kind: 'detached' });
      const current = running.get(key);
      const entry = current !== undefined && !current.stopped ? current : launch(key, caseId, start);
      running.set(key, entry);
      entry.waiters += 1;
      const sink = caller.onProgress;
      if (sink !== undefined) entry.listeners.add(sink);
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        if (sink !== undefined) entry.listeners.delete(sink);
        entry.waiters -= 1;
        if (entry.waiters > 0 || entry.settled) return;
        forget(entry);
        entry.controller.abort();
      };
      return new Promise<JoinOutcome<T>>((resolve) => {
        const onAbort = (): void => {
          release();
          resolve({ kind: 'detached' });
        };
        caller.signal?.addEventListener('abort', onAbort, { once: true });
        void entry.promise.then(
          (value) => {
            caller.signal?.removeEventListener('abort', onAbort);
            release();
            resolve(entry.stopped ? { kind: 'stopped' } : { kind: 'done', value });
          },
          () => {
            caller.signal?.removeEventListener('abort', onAbort);
            release();
            resolve({ kind: 'stopped' });
          },
        );
      });
    },
    stop(caseId) {
      const stopped = [...running.values()].filter((entry) => entry.caseId === caseId);
      for (const entry of stopped) {
        entry.stopped = true;
        forget(entry);
        entry.controller.abort();
      }
      return stopped.map(describe);
    },
    list: () => [...running.values()].map(describe),
  };
}

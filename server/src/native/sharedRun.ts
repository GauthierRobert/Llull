/**
 * One native run shared by every caller that asks for the same key (the lifecycle of the deferred mesh jobs, `deferredRun.ts`, and of the flow
 * solves, `../cfd/flowSolve.ts`). A caller joins with its own signal and progress sink; the run starts with the first caller and gets an
 * AbortSignal of its own that aborts (process-tree kill in the job runner) when the run is stopped or its last waiter leaves.
 * @invariant a caller whose signal aborts stops waiting at once ('detached'); a caller already aborted when it joins starts nothing
 * @invariant the run is aborted when its last waiter leaves before it settles, never after (a completed run's signal stays unaborted)
 * @invariant `stop(match)` aborts every matching run for all its waiters ('stopped'); a stopped run never yields a value, even when it settled in
 *   the same tick (the caller commits nothing)
 * @invariant a run that rejects yields 'failed' with the error message to every waiter (never 'stopped': nobody stopped it)
 * @invariant an entry leaves the table when its run settles, is stopped or loses its last waiter: a later join starts fresh
 * @invariant with `replayLatest`, a caller that joins a running run hears its latest progress report at once
 */

type JoinOutcome<T> =
  | { readonly kind: 'done'; readonly value: T }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'detached' }
  | { readonly kind: 'failed'; readonly error: string };

export interface RunInfo<M> {
  readonly key: string;
  readonly meta: M;
  readonly startedAt: number;
  readonly waiters: number;
}

interface Caller<P> {
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((progress: P) => void) | undefined;
}

type StartRun<T, P> = (signal: AbortSignal, publish: (progress: P) => void) => Promise<T>;

export interface SharedRuns<T, P, M> {
  /** Joins the run of `key` (started with `start` and `meta` when none runs) and waits for it, a stop, or the caller's own signal. */
  join(key: string, meta: M, start: StartRun<T, P>, caller: Caller<P>): Promise<JoinOutcome<T>>;
  /** Aborts every run whose meta matches; returns what was running. */
  stop(match: (meta: M) => boolean): RunInfo<M>[];
  list(): RunInfo<M>[];
}

interface Entry<T, P, M> {
  readonly key: string;
  readonly meta: M;
  readonly startedAt: number;
  readonly controller: AbortController;
  readonly listeners: Set<(progress: P) => void>;
  readonly promise: Promise<T>;
  readonly latest: () => { readonly progress: P } | null;
  waiters: number;
  stopped: boolean;
  settled: boolean;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createSharedRuns<T, P, M>(
  options: { readonly replayLatest?: boolean; readonly now?: () => number } = {},
): SharedRuns<T, P, M> {
  const now = options.now ?? Date.now;
  const running = new Map<string, Entry<T, P, M>>();
  const describe = (entry: Entry<T, P, M>): RunInfo<M> => ({
    key: entry.key,
    meta: entry.meta,
    startedAt: entry.startedAt,
    waiters: entry.waiters,
  });
  const forget = (entry: Entry<T, P, M>): void => {
    if (running.get(entry.key) === entry) running.delete(entry.key);
  };
  /** A new entry whose first listener is `sink` (it hears the run's very first report), started at once. */
  const launch = (key: string, meta: M, start: StartRun<T, P>, sink: ((progress: P) => void) | undefined): Entry<T, P, M> => {
    const controller = new AbortController();
    const listeners = new Set<(progress: P) => void>(sink === undefined ? [] : [sink]);
    const holder: { latest: { readonly progress: P } | null } = { latest: null };
    const publish = (progress: P): void => {
      holder.latest = { progress };
      for (const listener of listeners) listener(progress);
    };
    let promise: Promise<T>;
    try {
      promise = start(controller.signal, publish);
    } catch (error) {
      promise = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const entry: Entry<T, P, M> = {
      key,
      meta,
      startedAt: now(),
      controller,
      listeners,
      promise,
      latest: () => holder.latest,
      waiters: 0,
      stopped: false,
      settled: false,
    };
    // The first reaction to the run: it runs before any waiter's (registered later), so a waiter releasing on settle never aborts a
    // finished run.
    const settle = (): void => {
      entry.settled = true;
      forget(entry);
    };
    promise.then(settle, settle);
    return entry;
  };
  return {
    join(key, meta, start, caller) {
      if (caller.signal?.aborted === true) return Promise.resolve({ kind: 'detached' });
      const sink = caller.onProgress;
      const current = running.get(key);
      let entry: Entry<T, P, M>;
      if (current === undefined || current.stopped) {
        entry = launch(key, meta, start, sink);
        running.set(key, entry);
      } else {
        entry = current;
        if (sink !== undefined) {
          entry.listeners.add(sink);
          const latest = entry.latest();
          if (options.replayLatest === true && latest !== null) sink(latest.progress);
        }
      }
      entry.waiters += 1;
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
        const settle = (outcome: JoinOutcome<T>): void => {
          caller.signal?.removeEventListener('abort', onAbort);
          release();
          resolve(entry.stopped ? { kind: 'stopped' } : outcome);
        };
        entry.promise.then(
          (value) => settle({ kind: 'done', value }),
          (error: unknown) => settle({ kind: 'failed', error: messageOf(error) }),
        );
      });
    },
    stop(match) {
      const stopped = [...running.values()].filter((entry) => match(entry.meta));
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

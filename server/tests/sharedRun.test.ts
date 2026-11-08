/**
 * `createSharedRuns` (the run lifecycle of the deferred mesh jobs and the flow solves), one test per @invariant, with fake starts: a pre-aborted
 * join starts nothing; the run is killed with its last waiter and never after it settled; a stop in the same tick as the settle is 'stopped';
 * a rejection (or a synchronous throw) is 'failed' with the message; a join after a stop starts fresh; latest-progress replay on and off.
 */

import { describe, expect, it } from 'vitest';
import { createSharedRuns } from '../src/native/sharedRun';

interface Held {
  readonly start: (signal: AbortSignal, publish: (progress: string) => void) => Promise<string>;
  readonly starts: () => number;
  readonly signals: AbortSignal[];
  readonly publish: (progress: string) => void;
  readonly resolve: (value: string) => void;
  readonly reject: (error: Error) => void;
}

/** A start that holds until `resolve` / `reject`, resolving 'aborted' when its signal aborts. */
function held(): Held {
  const signals: AbortSignal[] = [];
  let starts = 0;
  let publisher: (progress: string) => void = () => undefined;
  let settleOk: (value: string) => void = () => undefined;
  let settleError: (error: Error) => void = () => undefined;
  return {
    start: (signal, publish) => {
      starts += 1;
      signals.push(signal);
      publisher = publish;
      return new Promise<string>((resolve, reject) => {
        settleOk = resolve;
        settleError = reject;
        signal.addEventListener('abort', () => resolve('aborted'), { once: true });
      });
    },
    starts: () => starts,
    signals,
    publish: (progress) => publisher(progress),
    resolve: (value) => settleOk(value),
    reject: (error) => settleError(error),
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('createSharedRuns', () => {
  it('a caller already aborted when it joins starts nothing', async () => {
    const runs = createSharedRuns<string, string, string>();
    const job = held();
    const gone = new AbortController();
    gone.abort();
    expect(await runs.join('k', 'case', job.start, { signal: gone.signal })).toEqual({ kind: 'detached' });
    expect(job.starts()).toBe(0);
    expect(runs.list()).toEqual([]);
  });

  it('shares one run per key and kills it when its last waiter leaves, not before', async () => {
    const runs = createSharedRuns<string, string, string>();
    const job = held();
    const [a, b] = [new AbortController(), new AbortController()];
    const first = runs.join('k', 'case', job.start, { signal: a.signal });
    const second = runs.join('k', 'case', job.start, { signal: b.signal });
    expect(job.starts()).toBe(1);
    expect(runs.list()).toMatchObject([{ key: 'k', meta: 'case', waiters: 2 }]);
    a.abort();
    expect(await first).toEqual({ kind: 'detached' });
    expect(job.signals[0]?.aborted).toBe(false);
    b.abort();
    expect(await second).toEqual({ kind: 'detached' });
    expect(job.signals[0]?.aborted).toBe(true);
    expect(runs.list()).toEqual([]);
  });

  it('never aborts a run that completed, and gives every waiter its value', async () => {
    const runs = createSharedRuns<string, string, string>();
    const job = held();
    const waiting = [runs.join('k', 'case', job.start, {}), runs.join('k', 'case', job.start, {})];
    job.resolve('result');
    expect(await Promise.all(waiting)).toEqual([
      { kind: 'done', value: 'result' },
      { kind: 'done', value: 'result' },
    ]);
    await tick();
    expect(job.signals[0]?.aborted).toBe(false);
    expect(runs.list()).toEqual([]);
  });

  it('a stop that lands in the tick the run settles is stopped: the value is never handed out', async () => {
    const runs = createSharedRuns<string, string, string>();
    const job = held();
    const waiting = runs.join('k', 'case', job.start, {});
    job.resolve('result');
    expect(runs.stop((meta) => meta === 'case')).toMatchObject([{ key: 'k', waiters: 1 }]);
    expect(await waiting).toEqual({ kind: 'stopped' });
    expect(runs.stop(() => true)).toEqual([]);
  });

  it('a rejected run is failed with the message for every waiter, not stopped', async () => {
    const runs = createSharedRuns<string, string, string>();
    const job = held();
    const waiting = [runs.join('k', 'case', job.start, {}), runs.join('k', 'case', job.start, { signal: new AbortController().signal })];
    job.reject(new Error('ENOSPC: no space left'));
    expect(await Promise.all(waiting)).toEqual([
      { kind: 'failed', error: 'ENOSPC: no space left' },
      { kind: 'failed', error: 'ENOSPC: no space left' },
    ]);
    expect(runs.list()).toEqual([]);
  });

  it('a start that throws synchronously is a failed run, not an exception of join', async () => {
    const runs = createSharedRuns<string, string, string>();
    const throwing = (): Promise<string> => {
      throw new Error('cannot spawn');
    };
    expect(await runs.join('k', 'case', throwing, {})).toEqual({ kind: 'failed', error: 'cannot spawn' });
    expect(runs.list()).toEqual([]);
  });

  it('a join after a stop starts a fresh run', async () => {
    const runs = createSharedRuns<string, string, string>();
    const job = held();
    const first = runs.join('k', 'case', job.start, {});
    runs.stop(() => true);
    expect(await first).toEqual({ kind: 'stopped' });
    expect(job.signals[0]?.aborted).toBe(true);
    const second = runs.join('k', 'case', job.start, {});
    expect(job.starts()).toBe(2);
    expect(job.signals[1]?.aborted).toBe(false);
    job.resolve('again');
    expect(await second).toEqual({ kind: 'done', value: 'again' });
  });

  it.each([
    [true, ['first report', 'second report']],
    [false, ['second report']],
  ])('replayLatest %s: a late joiner hears the latest report at once only when replay is on', async (replayLatest, heard) => {
    const runs = createSharedRuns<string, string, string>({ replayLatest });
    const job = held();
    const early: string[] = [];
    const late: string[] = [];
    const first = runs.join('k', 'case', job.start, { onProgress: (line) => early.push(line) });
    job.publish('first report');
    const second = runs.join('k', 'case', job.start, { onProgress: (line) => late.push(line) });
    job.publish('second report');
    job.resolve('done');
    await Promise.all([first, second]);
    expect(early).toEqual(['first report', 'second report']);
    expect(late).toEqual(heard);
  });
});

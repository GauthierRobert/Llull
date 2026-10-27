/**
 * `resolveDeferred` (TECHNICAL_SPEC 13.8): the host runs a command again until it stops asking for native jobs. Fake jobs, no process: rounds, sharing,
 * failures, cancellation, heartbeats, the kept-result cache.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { deferMeshOp } from '@core/geometry/mesh/engine';
import type { MeshEngineFailure, MeshOpResult } from '@core/geometry/mesh/engineTypes';
import {
  _clearResultCache,
  _resultCacheSize,
  _runningJobCount,
  configureResultCache,
  currentScope,
  resolveDeferred,
  type DeferredJob,
  type JobOutcome,
  type JobProgress,
} from '../src/native/deferredRun';

const result = (vertices: number): MeshOpResult => ({
  mesh: { positions: new Array<number>(vertices * 3).fill(0), indices: [0, 1, 2] },
  report: {},
  provenance: { engine: 'native', version: 'fake', algorithm: 'a', reference: 'r', deterministic: true },
});

interface Probe {
  readonly job: DeferredJob;
  readonly starts: () => number;
  readonly aborted: () => boolean;
}

function fakeJob(key: string, outcome: JobOutcome, durationMs = 20, heartbeatMs = 1000, reports = 0): Probe {
  let starts = 0;
  let aborted = false;
  return {
    job: {
      key,
      op: 'quad_remesh',
      heartbeatMs,
      start: (signal, report) => {
        starts += 1;
        for (let i = 1; i <= reports; i++)
          report({ stage: `s${i}`, message: `stage ${i}`, step: i, total: reports, fraction: i / (reports + 1) });
        return new Promise<JobOutcome>((resolve) => {
          const timer = setTimeout(() => resolve(outcome), durationMs);
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              clearTimeout(timer);
              resolve({ code: 'MESH_CANCELLED', message: 'killed' });
            },
            { once: true },
          );
        });
      },
    },
    starts: () => starts,
    aborted: () => aborted,
  };
}

/** One run of a "command" that needs `jobs` in order: the first it has no result for is requested, and the run answers its refusal. */
const needs =
  (...jobs: DeferredJob[]) =>
  (): JobOutcome | string => {
    const scope = currentScope();
    if (scope === null) return 'no scope';
    const answers: string[] = [];
    for (const job of jobs) {
      const held = scope.lookup(job.key);
      if (held === undefined) {
        if (scope.cancelled) return 'refused:cancelled';
        scope.request(job);
        return 'pending';
      }
      answers.push('code' in held ? (held as MeshEngineFailure).code : 'ok');
    }
    return answers.join(',');
  };

beforeEach(() => {
  _clearResultCache();
  configureResultCache({});
});

describe('resolveDeferred', () => {
  it('a run that asks for nothing is the answer, committed once, with no wait', async () => {
    const commits: string[] = [];
    const answer = await resolveDeferred(() => 'done', { commit: (outcome) => commits.push(outcome) });
    expect(answer).toBe('done');
    expect(commits).toEqual(['done']);
  });

  it('awaits the job, runs the command again with the result, and commits only that run', async () => {
    const a = fakeJob('a', result(3));
    const seen: string[] = [];
    const answer = await resolveDeferred(needs(a.job), { commit: (outcome) => seen.push(String(outcome)) });
    expect(answer).toBe('ok');
    expect(seen).toEqual(['ok']);
    expect(a.starts()).toBe(1);
    expect(_runningJobCount()).toBe(0);
  });

  it('a command that chains two ops takes one extra run per op, and the jobs run one after the other', async () => {
    const a = fakeJob('a', result(3));
    const b = fakeJob('b', result(4));
    let runs = 0;
    const attempt = needs(a.job, b.job);
    expect(await resolveDeferred(() => (runs++, attempt()))).toBe('ok,ok');
    expect(runs).toBe(3);
  });

  it('two commands that want the same job share it; each gets the result', async () => {
    const a = fakeJob('shared', result(3), 60);
    const [one, two] = await Promise.all([resolveDeferred(needs(a.job)), resolveDeferred(needs(a.job))]);
    expect([one, two]).toEqual(['ok', 'ok']);
    expect(a.starts()).toBe(1);
  });

  it('keeps a finished result for the next command (replay, undo, a retry) until the budget evicts it', async () => {
    const a = fakeJob('kept', result(3));
    await resolveDeferred(needs(a.job));
    expect(_resultCacheSize()).toBe(1);
    expect(await resolveDeferred(needs(a.job))).toBe('ok');
    expect(a.starts()).toBe(1);
    configureResultCache({ LLULL_MESH_CACHE_MB: '0' });
    expect(_resultCacheSize()).toBe(0);
    await resolveDeferred(needs(a.job));
    expect(a.starts()).toBe(2);
  });

  it('evicts the least recently used result when the byte budget is full', async () => {
    configureResultCache({ LLULL_MESH_CACHE_MB: String((2.5 * 3 * 8 * 1000) / (1024 * 1024)) });
    for (const key of ['k1', 'k2', 'k3']) await resolveDeferred(needs(fakeJob(key, result(1000)).job));
    expect(_resultCacheSize()).toBe(2);
    const again = fakeJob('k1', result(1000));
    await resolveDeferred(needs(again.job));
    expect(again.starts()).toBe(1);
  });

  it('a failed job is reported to the command by its code and is not kept', async () => {
    const failed = fakeJob('bad', { code: 'MESH_TIMEOUT', message: 'too slow' });
    expect(await resolveDeferred(needs(failed.job))).toBe('MESH_TIMEOUT');
    expect(_resultCacheSize()).toBe(0);
    await resolveDeferred(needs(failed.job));
    expect(failed.starts()).toBe(2);
  });

  it('a command that chains more than 16 native jobs still resolves: the bound is on jobs, not on runs', async () => {
    const jobs = Array.from({ length: 20 }, (_, i) => fakeJob(`chain-${i}`, result(3), 1));
    expect(await resolveDeferred(needs(...jobs.map((probe) => probe.job)))).toBe(Array(20).fill('ok').join(','));
    expect(jobs.every((probe) => probe.starts() === 1)).toBe(true);
  });

  it('a run asks for one job only: later misses of the same run are not requested', async () => {
    const first = fakeJob('first', result(3), 1);
    const second = fakeJob('second', result(3), 1);
    const greedy = (): string => {
      const scope = currentScope();
      for (const probe of [first, second]) if (scope?.lookup(probe.job.key) === undefined) scope?.request(probe.job);
      return 'run';
    };
    await resolveDeferred(greedy);
    expect([first.starts(), second.starts()]).toEqual([1, 1]);
  });

  it('beyond maxJobs the resolve refuses MESH_JOB_LIMIT and commits the refusal, not a run', async () => {
    let n = 0;
    const committed: string[] = [];
    const endless = (): string => {
      currentScope()?.request(fakeJob(`job-${n++}`, result(3), 1).job);
      return 'run';
    };
    const answer = await resolveDeferred(endless, {
      maxJobs: 3,
      refuse: (refusal) => refusal.code,
      commit: (outcome) => committed.push(outcome),
    });
    expect(answer).toBe('MESH_JOB_LIMIT');
    expect(committed).toEqual(['MESH_JOB_LIMIT']);
    expect(n).toBe(4);
  });

  it('a run that defers without asking for a job, or asks again for a result it holds, is refused by name', async () => {
    const silent = (): string => {
      deferMeshOp('quad_remesh');
      return 'run';
    };
    expect(await resolveDeferred(silent, { refuse: (refusal) => refusal.code })).toBe('MESH_DEFER_PROTOCOL');
    const probe = fakeJob('again', result(3), 1);
    const forgetful = (): string => {
      currentScope()?.request(probe.job);
      return 'run';
    };
    expect(await resolveDeferred(forgetful, { refuse: (refusal) => refusal.code })).toBe('MESH_DEFER_PROTOCOL');
  });

  it('calls the wait hooks around each wait for a job and nowhere else', async () => {
    const log: string[] = [];
    const a = fakeJob('wait-a', result(3), 5);
    const b = fakeJob('wait-b', result(3), 5);
    const attempt = needs(a.job, b.job);
    await resolveDeferred(() => (log.push('run'), attempt()), {
      onWaitStart: () => log.push('wait-start'),
      onWaitEnd: () => log.push('wait-end'),
    });
    expect(log).toEqual(['run', 'wait-start', 'wait-end', 'run', 'wait-start', 'wait-end', 'run']);
    const none: string[] = [];
    await resolveDeferred(() => 'x', { onWaitStart: () => none.push('s'), onWaitEnd: () => none.push('e') });
    expect(none).toEqual([]);
  });

  it('there is no scope outside a resolve', () => {
    expect(currentScope()).toBeNull();
  });
});

describe('cancellation', () => {
  const code = (refusal: { code: string }): string => refusal.code;

  it('aborting the signal answers at once, kills the job nobody else waits for, and commits nothing but the refusal', async () => {
    const slow = fakeJob('slow', result(3), 5000);
    const controller = new AbortController();
    const committed: string[] = [];
    const running = resolveDeferred(needs(slow.job), {
      signal: controller.signal,
      refuse: code,
      commit: (outcome) => committed.push(String(outcome)),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const aborted = performance.now();
    controller.abort();
    expect(await running).toBe('MESH_CANCELLED');
    expect(performance.now() - aborted).toBeLessThan(500);
    expect(committed).toEqual(['MESH_CANCELLED']);
    expect(slow.aborted()).toBe(true);
    expect(_runningJobCount()).toBe(0);
    expect(_resultCacheSize()).toBe(0);
  });

  it('the reason of the abort names the refusal (a --timeout deadline is MESH_TIMEOUT)', async () => {
    const slow = fakeJob('slow-deadline', result(3), 5000);
    const controller = new AbortController();
    const running = resolveDeferred(needs(slow.job), { signal: controller.signal, refuse: code });
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort({ code: 'MESH_TIMEOUT', message: 'late' });
    expect(await running).toBe('MESH_TIMEOUT');
  });

  it('a job that crashes in the instant the signal aborts is a cancellation, not the crash', async () => {
    const controller = new AbortController();
    const crashing = fakeJob('race', { code: 'MESH_QUAD_REMESH_FAILED', message: 'NATIVE_PROTOCOL' }, 10);
    const start = crashing.job.start;
    const racing: DeferredJob = {
      ...crashing.job,
      start: (signal, report) => start(signal, report).then((outcome) => (controller.abort(), outcome)),
    };
    expect(await resolveDeferred(needs(racing), { signal: controller.signal, refuse: code })).toBe('MESH_CANCELLED');
  });

  it('a job another waiter cancelled makes the resolve a cancellation too: nothing is committed', async () => {
    const stopped = fakeJob('stopped', { code: 'MESH_CANCELLED', message: 'killed' }, 5);
    const committed: string[] = [];
    expect(await resolveDeferred(needs(stopped.job), { refuse: code, commit: (outcome) => committed.push(String(outcome)) })).toBe(
      'MESH_CANCELLED',
    );
    expect(committed).toEqual(['MESH_CANCELLED']);
  });

  it('a shared job survives the cancel of one waiter', async () => {
    const shared = fakeJob('shared-slow', result(3), 150);
    const controller = new AbortController();
    const cancelled = resolveDeferred(needs(shared.job), { signal: controller.signal, refuse: code });
    const kept = resolveDeferred(needs(shared.job));
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    expect(await cancelled).toBe('MESH_CANCELLED');
    expect(shared.aborted()).toBe(false);
    expect(await kept).toBe('ok');
    expect(shared.starts()).toBe(1);
  });

  it('a signal already aborted starts no job', async () => {
    const never = fakeJob('never', result(3));
    const controller = new AbortController();
    controller.abort();
    expect(await resolveDeferred(needs(never.job), { signal: controller.signal, refuse: code })).toBe('MESH_CANCELLED');
    expect(never.starts()).toBe(0);
  });
});

describe('progress', () => {
  it('reports every stage in order with the share done and an estimate of the time left', async () => {
    const events: JobProgress[] = [];
    const job = fakeJob('progress', result(3), 30, 1000, 3);
    await resolveDeferred(needs(job.job), { onProgress: (event) => events.push(event) });
    const stages = events.map((event) => event.stage);
    expect(stages.filter((stage) => stage !== 'start')).toEqual(['s1', 's2', 's3']);
    expect(events.every((event) => event.op === 'quad_remesh')).toBe(true);
    const withEstimate = events.filter((event) => event.etaMs !== null);
    expect(withEstimate.length).toBeGreaterThan(0);
    expect(withEstimate.every((event) => (event.fraction ?? 0) >= 0.05)).toBe(true);
  });

  it('a silent job heartbeats with the clock advancing, and a late joiner is told the latest report at once', async () => {
    const quiet = fakeJob('quiet', result(3), 250, 40, 1);
    const first: JobProgress[] = [];
    const running = resolveDeferred(needs(quiet.job), { onProgress: (event) => first.push(event) });
    await new Promise((resolve) => setTimeout(resolve, 130));
    const late: JobProgress[] = [];
    const joined = resolveDeferred(needs(quiet.job), { onProgress: (event) => late.push(event) });
    await Promise.all([running, joined]);
    const beats = first.filter((event) => event.heartbeat);
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(beats.map((event) => event.elapsedMs)).toEqual([...beats.map((event) => event.elapsedMs)].sort((a, b) => a - b));
    expect(late[0]?.elapsedMs).toBeGreaterThan(0);
    expect(quiet.starts()).toBe(1);
  });
});

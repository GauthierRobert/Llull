/**
 * Async native mesh jobs behind the synchronous command layer (07 MSH TECHNICAL_SPEC 13.8). A command is a pure synchronous function, so a
 * 2-minute `llull-compute meshops` job cannot be awaited inside it and must not block the event loop. The host runs the command in a SCOPE
 * instead: the native engine answers from the results the scope already holds, or asks the scope for a job and answers `deferMeshOp`
 * (a refusal); `resolveDeferred` then discards that run, awaits the jobs on the event loop (progress events, cancellation, timeout) and runs the
 * command again, now finding the results. The command stays a pure function of (document, params, result table); live sync, replay and undo
 * only ever see the final run.
 * @invariant a run that requested a job is discarded whatever it returned (the refusal may have been swallowed into a success)
 * @invariant one job per content key runs at a time: concurrent commands wanting the same op on the same mesh share it; it is killed when its last waiter cancels
 * @invariant a failed job (timeout, crash) is remembered for the scope only, so the next run reports its named code instead of asking again
 * @invariant a resolve that was cancelled (signal aborted, or a job ended MESH_CANCELLED), hit the job limit or broke the protocol commits NOTHING: it ends in a refusal on the unchanged document
 * @invariant the runs of one resolve share a memo (`DeferredScope.memo`, handed to commands through `ExecutionContext.resolveMemo`): plan steps before the first deferral and a command's mesh preparation are computed once (13.9); it is dropped when the resolve ends, however it ends
 * @invariant one run asks for at most one job; the resolve loops while each run asks for a key it does not hold yet, up to MAX_JOBS_PER_RESOLVE jobs
 */

import { createResolveMemo, type ResolveMemo } from '@core/commands/resolveMemo';
import { deferralCount } from '@core/geometry/mesh/engine';
import type { MeshEngineFailure, MeshOpName, MeshOpResult } from '@core/geometry/mesh/engineTypes';
import { isRecord } from '@lib/isRecord';

/** Named guard: native jobs one resolve may run (a plan of many native steps takes one per step); beyond it MESH_JOB_LIMIT. */
const MAX_JOBS_PER_RESOLVE = 256;
const DEFAULT_RESULT_CACHE_BYTES = 512 * 1024 * 1024;
const BYTES_PER_NUMBER = 8;
/** Share of the run below which a remaining-time estimate is noise. */
const MIN_FRACTION_FOR_ETA = 0.05;

export type JobOutcome = MeshOpResult | MeshEngineFailure;

/** One progress report of a native job, as the host streams it (CLI `--progress`, `POST /command` NDJSON). */
export interface JobProgress {
  readonly op: MeshOpName;
  /** Machine name of the stage (`max_flow`, `decimate`, ...). */
  readonly stage: string;
  /** The stage in words. */
  readonly message: string;
  readonly step: number;
  readonly total: number;
  /** Share of the whole job done (0 to 1), or null before the job reported one. */
  readonly fraction: number | null;
  readonly elapsedMs: number;
  /** Estimated remaining milliseconds from the share done so far; null while too little is done to say. */
  readonly etaMs: number | null;
  /** Nothing new from the job: the last report again, with the clock advanced. */
  readonly heartbeat: boolean;
}

export interface DeferredJob {
  /** Content key: the same op on the same mesh and parameters gives the same key (hash of the job files). */
  readonly key: string;
  readonly op: MeshOpName;
  /** Milliseconds between two heartbeats of a silent job. */
  readonly heartbeatMs: number;
  /** Runs the job; resolves with its result or a named failure, never rejects. `report` takes the raw `progress` events of the job. */
  start(signal: AbortSignal, report: (event: Readonly<Record<string, unknown>>) => void): Promise<JobOutcome>;
}

export interface DeferredScope {
  /** The result held for `key`, or undefined. */
  lookup(key: string): JobOutcome | undefined;
  /** Ask for `job` to be run before the next run of the command; only the first request of a run counts. */
  request(job: DeferredJob): void;
  /** The resolve was cancelled: no new job starts. */
  readonly cancelled: boolean;
  /** This run already asked for a job: every later miss defers without asking (its input is a placeholder). */
  readonly deferring: boolean;
  /** The job budget of this resolve is spent: an op the TypeScript engine can take should be left to it (answer MESH_ENGINE_NEEDS_HOST), only the others still ask for a job. */
  readonly budgetSpent: boolean;
  /** Shared by every run of this resolve; dropped when it ends. */
  readonly memo: ResolveMemo;
}

/** Why a resolve ended without committing a run. */
export interface Refusal {
  readonly code: string;
  readonly message: string;
  readonly remediation: string;
}

let current: DeferredScope | null = null;

/** The scope of the run in progress, or null outside `resolveDeferred`. */
export function currentScope(): DeferredScope | null {
  return current;
}

const isFailure = (outcome: JobOutcome): outcome is MeshEngineFailure => 'code' in outcome;

const numbersIn = (result: MeshOpResult): number =>
  (result.mesh?.positions.length ?? 0) +
  (result.mesh?.indices.length ?? 0) +
  (result.quads?.positions.length ?? 0) +
  (result.quads?.quads.length ?? 0);

/** Successful results kept across resolves (undo/redo, replay and a retry of the same command find them), least recently used out first. */
class ResultCache {
  private readonly entries = new Map<string, { readonly result: MeshOpResult; readonly bytes: number }>();
  private total = 0;
  constructor(private limit: number) {}

  setLimit(limit: number): void {
    this.limit = limit;
    this.trim();
  }

  get(key: string): MeshOpResult | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.result;
  }

  set(key: string, result: MeshOpResult): void {
    const bytes = numbersIn(result) * BYTES_PER_NUMBER;
    this.delete(key);
    if (bytes > this.limit) return;
    this.entries.set(key, { result, bytes });
    this.total += bytes;
    this.trim();
  }

  clear(): void {
    this.entries.clear();
    this.total = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.total -= entry.bytes;
    this.entries.delete(key);
  }

  private trim(): void {
    for (const key of this.entries.keys()) {
      if (this.total <= this.limit) return;
      this.delete(key);
    }
  }
}

const resultCache = new ResultCache(DEFAULT_RESULT_CACHE_BYTES);

/** The kept result of a finished job, or undefined: usable without a scope (a hit needs no job). */
export function keptResult(key: string): MeshOpResult | undefined {
  return resultCache.get(key);
}

/** `LLULL_MESH_CACHE_MB`: megabytes of finished native mesh results kept (default 512; 0 keeps none). Called once by the engine factory. */
export function configureResultCache(env: NodeJS.ProcessEnv): void {
  const megabytes = Number(env['LLULL_MESH_CACHE_MB']);
  resultCache.setLimit(Number.isFinite(megabytes) && megabytes >= 0 ? megabytes * 1024 * 1024 : DEFAULT_RESULT_CACHE_BYTES);
}

/** @internal tests only: forget every kept result. */
export function _clearResultCache(): void {
  resultCache.clear();
}

/** @internal tests only: number of kept results. */
export function _resultCacheSize(): number {
  return resultCache.size;
}

type Listener = (event: JobProgress) => void;

interface RunningJob {
  readonly promise: Promise<JobOutcome>;
  readonly controller: AbortController;
  readonly listeners: Set<Listener>;
  waiters: number;
  last(): JobProgress | null;
}

const running = new Map<string, RunningJob>();

function progressOf(job: DeferredJob, raw: Readonly<Record<string, unknown>>, startedAt: number, heartbeat: boolean): JobProgress {
  const elapsedMs = Date.now() - startedAt;
  const fraction = typeof raw['fraction'] === 'number' && Number.isFinite(raw['fraction']) ? raw['fraction'] : null;
  const etaMs =
    fraction !== null && fraction >= MIN_FRACTION_FOR_ETA && fraction < 1 ? Math.round((elapsedMs * (1 - fraction)) / fraction) : null;
  return {
    op: job.op,
    stage: typeof raw['stage'] === 'string' ? raw['stage'] : '',
    message: typeof raw['message'] === 'string' ? raw['message'] : job.op,
    step: typeof raw['step'] === 'number' ? raw['step'] : 0,
    total: typeof raw['total'] === 'number' ? raw['total'] : 0,
    fraction,
    elapsedMs,
    etaMs,
    heartbeat,
  };
}

/** Start `job`; `first` hears every report from the very first (the job may report before `start` returns). */
function launch(job: DeferredJob, first: Listener | undefined): RunningJob {
  const controller = new AbortController();
  const listeners = new Set<Listener>(first === undefined ? [] : [first]);
  const startedAt = Date.now();
  let last: JobProgress | null = null;
  const publish = (event: JobProgress): void => {
    last = event;
    for (const listener of listeners) listener(event);
  };
  publish(progressOf(job, { stage: 'start', message: `${job.op} starting` }, startedAt, false));
  const heartbeat = setInterval(() => {
    if (last !== null) publish(progressOf(job, { ...last }, startedAt, true));
  }, job.heartbeatMs);
  heartbeat.unref();
  const promise = job
    .start(controller.signal, (raw) => publish(progressOf(job, raw, startedAt, false)))
    .then((outcome) => {
      if (!isFailure(outcome)) resultCache.set(job.key, outcome);
      return outcome;
    })
    .finally(() => {
      clearInterval(heartbeat);
      if (running.get(job.key)?.promise === promise) running.delete(job.key);
    });
  return { promise, controller, listeners, waiters: 0, last: () => last };
}

/** Wait for `job` (started if not running, shared if running). Aborting `signal` stops waiting at once and kills the job when nobody else waits. */
function acquire(job: DeferredJob, signal: AbortSignal | undefined, onProgress: Listener | undefined): Promise<JobOutcome> {
  const existing = running.get(job.key);
  const shared = existing ?? launch(job, onProgress);
  if (existing === undefined) running.set(job.key, shared);
  else if (onProgress !== undefined) {
    shared.listeners.add(onProgress);
    const latest = shared.last();
    if (latest !== null) onProgress(latest);
  }
  shared.waiters += 1;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    if (onProgress !== undefined) shared.listeners.delete(onProgress);
    shared.waiters -= 1;
    if (shared.waiters > 0) return;
    if (running.get(job.key) === shared) running.delete(job.key);
    shared.controller.abort();
  };
  if (signal === undefined) return shared.promise.finally(release);
  return new Promise<JobOutcome>((resolve) => {
    const onAbort = (): void => {
      release();
      resolve({ code: 'MESH_CANCELLED', message: `the '${job.op}' job was cancelled` });
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    void shared.promise.then((outcome) => {
      signal.removeEventListener('abort', onAbort);
      release();
      resolve(outcome);
    });
  });
}

export interface ResolveOptions<T = unknown> {
  /** Every progress report of every job the command waits for, in order. */
  readonly onProgress?: (event: JobProgress) => void;
  /** Aborting cancels the command: running jobs nobody else waits for are killed and NOTHING is committed. A reason with a `code` (e.g. MESH_TIMEOUT) names the refusal. */
  readonly signal?: AbortSignal;
  /** Jobs one resolve may run (default 256). */
  readonly maxJobs?: number;
  /** Called with the run that stands, synchronously in the same tick as that run: no other command can change the document before it. */
  readonly commit?: (outcome: T) => void;
  /** The result of a resolve that ends in a refusal (the unchanged document with an error); it is committed like a run. Without it the last run stands. */
  readonly refuse?: (refusal: Refusal) => T;
  /** The event loop is about to wait for a job (the caller may listen for Ctrl-C now). */
  readonly onWaitStart?: () => void;
  /** The wait for the job ended (a synchronous run follows). */
  readonly onWaitEnd?: () => void;
}

function runInScope<T>(scope: DeferredScope, attempt: () => T): T {
  const outer = current;
  current = scope;
  try {
    return attempt();
  } finally {
    current = outer;
  }
}

const cancelRefusal = (signal: AbortSignal | undefined): Refusal => {
  const reason: unknown = signal?.reason;
  if (isRecord(reason) && typeof reason['code'] === 'string')
    return {
      code: reason['code'],
      message: typeof reason['message'] === 'string' ? reason['message'] : 'the command was stopped',
      remediation: 'Nothing was applied. Run the command again.',
    };
  return {
    code: 'MESH_CANCELLED',
    message: 'the command was cancelled; nothing was applied',
    remediation: 'Nothing was applied. Run the command again.',
  };
};

/**
 * Run `attempt` (a synchronous run of a command through `execute`) until it no longer asks for a native job; returns the last run.
 * Each run asks for at most one job (the first miss; later misses of the same run work on a placeholder). The jobs are awaited on the event loop.
 * @failure signal aborted, or a job ended MESH_CANCELLED: refusal MESH_CANCELLED (or the reason's code), nothing committed
 * @failure a job that times out or crashes: the next run refuses with its named code (MESH_TIMEOUT, MESH_QUAD_REMESH_FAILED, ...)
 * @failure more than `maxJobs` jobs: refusal MESH_JOB_LIMIT
 * @failure a run deferred without asking, or asked for a result it already holds: refusal MESH_DEFER_PROTOCOL (an engine bug)
 */
export async function resolveDeferred<T>(attempt: () => T, options: ResolveOptions<T> = {}): Promise<T> {
  const aborted = (): boolean => options.signal?.aborted === true;
  const results = new Map<string, JobOutcome>();
  const requested = new Map<string, DeferredJob>();
  const memo = createResolveMemo();
  const scope: DeferredScope = {
    memo,
    lookup: (key) => results.get(key) ?? resultCache.get(key),
    request: (job) => {
      if (requested.size === 0) requested.set(job.key, job);
    },
    get cancelled() {
      return aborted();
    },
    get deferring() {
      return requested.size > 0;
    },
    get budgetSpent() {
      return jobs >= maxJobs;
    },
  };
  const maxJobs = options.maxJobs ?? MAX_JOBS_PER_RESOLVE;
  let last: T | undefined;
  let cancelledJob = false;
  let jobs = 0;
  const stand = (outcome: T): T => {
    options.commit?.(outcome);
    return outcome;
  };
  const stop = (refusal: Refusal): T => stand(options.refuse !== undefined ? options.refuse(refusal) : (last as T));
  try {
    for (;;) {
      requested.clear();
      memo.beginRun();
      const before = deferralCount();
      last = runInScope(scope, attempt);
      const deferred = deferralCount() !== before;
      if (requested.size === 0) {
        if (deferred)
          return stop({
            code: 'MESH_DEFER_PROTOCOL',
            message: 'an engine deferred a native mesh op without asking for a job',
            remediation: 'This is a bug in the mesh engine; report it with the command that was run.',
          });
        if (aborted() || cancelledJob) return stop(cancelRefusal(options.signal));
        return stand(last);
      }
      const job = [...requested.values()][0] as DeferredJob;
      requested.clear();
      if (results.has(job.key))
        return stop({
          code: 'MESH_DEFER_PROTOCOL',
          message: `the '${job.op}' job was asked for again after it finished`,
          remediation: 'This is a bug in the mesh engine; report it with the command that was run.',
        });
      if (jobs >= maxJobs)
        return stop({
          code: 'MESH_JOB_LIMIT',
          message: `the command needs more than ${maxJobs} native mesh jobs`,
          remediation:
            'Split the plan into several runs. Once the budget is spent only the ops the TypeScript engine cannot take still count (quad_remesh, meshes above its 200000-triangle cap).',
        });
      if (aborted()) return stop(cancelRefusal(options.signal));
      jobs += 1;
      options.onWaitStart?.();
      let outcome: JobOutcome;
      try {
        outcome = await acquire(job, options.signal, options.onProgress);
      } finally {
        options.onWaitEnd?.();
      }
      results.set(job.key, outcome);
      if (isFailure(outcome) && outcome.code === 'MESH_CANCELLED') cancelledJob = true;
      if (aborted() || cancelledJob) return stop(cancelRefusal(options.signal));
    }
  } finally {
    memo.dispose();
  }
}

/** @internal tests only: native jobs running now. */
export function _runningJobCount(): number {
  return running.size;
}

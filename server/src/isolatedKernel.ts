/**
 * @layer server
 * A `GeometryKernel` whose OpenCascade work runs in a worker thread, behind a SYNCHRONOUS call:
 * the server thread posts a request, blocks on `Atomics.wait`, and reads the reply with
 * `receiveMessageOnPort`. A WASM abort (Emscripten `process.exit`), a hang past the call timeout
 * or a failed start kills only the worker; the call returns null (the command's graceful no-op)
 * and the next call respawns it.
 *
 * @invariant the interface stays synchronous (`packages/core` is unchanged)
 * @invariant shape handles cross the thread boundary as plain data (they carry their recipe), so a
 *   handle minted by a worker that has since been recycled is rebuilt by its successor
 * @failure worker died / timed out / failed to start -> null result + console.warn, never a throw
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  MessageChannel,
  Worker,
  receiveMessageOnPort,
  type MessagePort,
} from 'node:worker_threads';
import type { GeometryKernel } from '@core/geometry/kernel';
import {
  STATUS_DIED,
  STATUS_READY,
  STATUS_REPLY,
  type KernelOperation,
  type KernelReply,
  type TestHook,
} from './occtWorkerProtocol';

export interface IsolatedKernelOptions {
  /** Worker entry file; default `occtWorker.ts`/`.js` next to this module. */
  readonly entry?: string;
  /** Node flags for the worker (e.g. `--import tsx` when the entry is TypeScript). */
  readonly execArgv?: readonly string[];
  /** Max milliseconds one kernel call may block the server thread (default 60 000). */
  readonly callTimeoutMs?: number;
  /** Max milliseconds to wait for the worker to load the WASM kernel (default 60 000). */
  readonly startTimeoutMs?: number;
  /** Enables the `__abort` / `__hang` operations (tests only). */
  readonly testHooks?: boolean;
}

export interface IsolatedKernel extends GeometryKernel {
  /** Number of times a worker died or was killed mid-call. */
  crashCount(): number;
  /** Number of times the worker was replaced after a native OCC exception (module degraded). */
  recycleCount(): number;
  /** Test hook: ask the worker to run `__abort` or `__hang`. */
  forceFailure(hook: TestHook): void;
  /** Spawn the worker now; false (with a warning) when it cannot start. Idempotent. */
  start(): boolean;
  /** Terminate the worker (shutdown). */
  dispose(): void;
}

/** Path of the worker entry next to this module, or null when not shipped (bundled build). */
export function defaultWorkerEntry(): string | null {
  for (const extension of ['.ts', '.js']) {
    const candidate = path.join(__dirname, `occtWorker${extension}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Worker bootstrap (evaluated): flags a death in the shared status word from the first
 * instant, then loads the real entry, so even a failed load wakes the blocked server thread.
 * @invariant the exit hook always writes STATUS_DIED and notifies, whatever the status was
 *   (READY / REPLY not yet consumed): the server only ever clears it via compareExchange.
 */
const BOOTSTRAP = `
const { workerData } = require('node:worker_threads');
const status = new Int32Array(workerData.statusBuffer);
process.on('exit', () => {
  Atomics.store(status, 0, ${STATUS_DIED});
  Atomics.notify(status, 0);
});
try {
  require(workerData.entry);
} catch (error) {
  console.error('[occt-worker] cannot load', workerData.entry, error);
  process.exit(1);
}
`;

interface LiveWorker {
  readonly worker: Worker;
  readonly port: MessagePort;
  readonly status: Int32Array;
  /** False while the WASM module is still loading in the background. */
  ready: boolean;
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

class WorkerDiedOnStartError extends Error {
  constructor() {
    super('OCC worker died on start');
    this.name = 'WorkerDiedOnStartError';
  }
}

export function createIsolatedKernel(options: IsolatedKernelOptions = {}): IsolatedKernel {
  const entry = options.entry ?? defaultWorkerEntry();
  if (entry === null) throw new Error('OCC worker entry not found next to the server modules');
  // A TypeScript entry (dev, tests) is compiled on load by tsx's CommonJS hook.
  const execArgv =
    options.execArgv !== undefined
      ? [...options.execArgv]
      : entry.endsWith('.ts')
        ? ['--require', 'tsx/cjs']
        : undefined;
  const callTimeoutMs = options.callTimeoutMs ?? 60_000;
  const startTimeoutMs = options.startTimeoutMs ?? 60_000;
  let live: LiveWorker | null = null;
  let crashes = 0;
  let recycles = 0;

  const kill = (): void => {
    if (live === null) return;
    live.port.close();
    void live.worker.terminate();
    live = null;
  };

  /** Start a worker without waiting for its WASM load (it loads in parallel with the server). */
  const launch = (): LiveWorker => {
    const statusBuffer = new SharedArrayBuffer(4);
    const status = new Int32Array(statusBuffer);
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(BOOTSTRAP, {
      eval: true,
      workerData: { entry, statusBuffer, port: port2, testHooks: options.testHooks === true },
      transferList: [port2],
      ...(execArgv !== undefined ? { execArgv } : {}),
    });
    worker.on('error', () => undefined); // surfaced through the status word, not an event
    worker.unref();
    worker.on('exit', () => {
      if (live?.worker === worker) live = null; // died while idle: the next call respawns
    });
    return { worker, port: port1, status, ready: false };
  };

  /** Block until `candidate` finished loading (instant when it warmed up between calls). */
  const awaitReady = (candidate: LiveWorker): void => {
    if (candidate.ready) return;
    const { status } = candidate;
    const outcome = Atomics.wait(status, 0, 0, startTimeoutMs);
    if (outcome === 'timed-out' || Atomics.load(status, 0) !== STATUS_READY) {
      if (live === candidate) live = null;
      candidate.port.close();
      void candidate.worker.terminate();
      throw outcome === 'timed-out'
        ? new Error('OCC worker start timed out')
        : new WorkerDiedOnStartError();
    }
    Atomics.compareExchange(status, 0, STATUS_READY, 0); // a death since the load stays flagged
    candidate.ready = true;
  };

  /**
   * @invariant a worker launched in the background (warm restart) that died on start is replaced
   *   once by a fresh launch; a foreground launch or a start timeout is not retried.
   */
  const ensureLive = (): LiveWorker => {
    const launchedInBackground = live !== null;
    live ??= launch();
    try {
      awaitReady(live);
    } catch (error) {
      if (!launchedInBackground || !(error instanceof WorkerDiedOnStartError)) throw error;
      console.warn('[occt] the background-loaded worker died on start; launching a fresh one');
      live = launch();
      awaitReady(live);
    }
    return live;
  };

  /** Replace the worker; the new one loads in the background while the server handles requests. */
  const recycle = (): void => {
    kill();
    try {
      live = launch();
    } catch (error) {
      console.warn(`[occt] warm restart failed: ${errorText(error)}`);
    }
  };

  const call = (op: KernelOperation | TestHook, args: readonly unknown[]): unknown => {
    let target: LiveWorker;
    try {
      target = ensureLive();
      if (Atomics.load(target.status, 0) === STATUS_DIED) {
        kill(); // the worker died while idle (its exit event may not have run yet)
        target = ensureLive();
      }
    } catch (error) {
      console.warn(`[occt] ${errorText(error)}; returning null`);
      return null;
    }
    const { port, status } = target;
    port.postMessage({ op, args });
    const outcome = Atomics.wait(status, 0, 0, callTimeoutMs);
    const state = Atomics.load(status, 0);
    if (outcome !== 'timed-out' && state === STATUS_REPLY) {
      const reply = receiveMessageOnPort(port)?.message as KernelReply | undefined;
      Atomics.compareExchange(status, 0, STATUS_REPLY, 0); // idle; a death since the reply stays flagged
      if (reply?.error !== undefined) console.warn(`[occt] ${op} failed: ${reply.error}`);
      if (reply?.recycle === true) {
        recycles++;
        recycle(); // a degraded module is replaced; the next call gets a fresh, pre-loaded one
      }
      return reply?.result ?? null;
    }
    crashes++;
    console.warn(
      state === STATUS_DIED
        ? `[occt] worker aborted during ${op}; restarting it and returning null`
        : `[occt] ${op} exceeded ${callTimeoutMs} ms; killing the worker and returning null`,
    );
    recycle();
    return null;
  };

  return {
    evaluate: (recipe) => call('evaluate', [recipe]) as ReturnType<GeometryKernel['evaluate']>,
    tessellate: (shape) => call('tessellate', [shape]) as ReturnType<GeometryKernel['tessellate']>,
    topology: (shape) => call('topology', [shape]) as ReturnType<GeometryKernel['topology']>,
    exportStep: (shapes) =>
      call('exportStep', [shapes]) as ReturnType<GeometryKernel['exportStep']>,
    crashCount: () => crashes,
    recycleCount: () => recycles,
    forceFailure: (hook) => void call(hook, []),
    start: () => {
      try {
        ensureLive();
        return true;
      } catch (error) {
        console.warn(`[occt] ${errorText(error)}`);
        return false;
      }
    },
    dispose: kill,
  };
}

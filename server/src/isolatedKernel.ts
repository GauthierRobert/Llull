/**
 * @layer server
 * A `GeometryKernel` whose OpenCascade work runs in a worker thread, behind a SYNCHRONOUS call:
 * the server thread posts a request, blocks on `Atomics.wait`, and reads the reply with
 * `receiveMessageOnPort`. A WASM abort (Emscripten `process.exit`), a hang past the call timeout
 * or a failed start kills only the worker; the call returns null (the command's graceful no-op)
 * and the next call respawns it.
 *
 * @invariant the interface stays synchronous (`packages/core` is unchanged)
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
 */
const BOOTSTRAP = `
const { workerData } = require('node:worker_threads');
const status = new Int32Array(workerData.statusBuffer);
process.on('exit', () => {
  if (Atomics.compareExchange(status, 0, 0, ${STATUS_DIED}) === 0) Atomics.notify(status, 0);
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

  const spawn = (): LiveWorker => {
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
    const outcome = Atomics.wait(status, 0, 0, startTimeoutMs);
    if (outcome === 'timed-out' || Atomics.load(status, 0) !== STATUS_READY) {
      port1.close();
      void worker.terminate();
      throw new Error(
        outcome === 'timed-out' ? 'OCC worker start timed out' : 'OCC worker died on start',
      );
    }
    Atomics.store(status, 0, 0);
    return { worker, port: port1, status };
  };

  const call = (op: KernelOperation | TestHook, args: readonly unknown[]): unknown => {
    try {
      live ??= spawn();
    } catch (error) {
      console.warn(
        `[occt] ${error instanceof Error ? error.message : String(error)}; returning null`,
      );
      return null;
    }
    const { port, status } = live;
    Atomics.store(status, 0, 0);
    port.postMessage({ op, args });
    const outcome = Atomics.wait(status, 0, 0, callTimeoutMs);
    const state = Atomics.load(status, 0);
    if (outcome !== 'timed-out' && state === STATUS_REPLY) {
      const reply = receiveMessageOnPort(port)?.message as KernelReply | undefined;
      if (reply?.error !== undefined) console.warn(`[occt] ${op} failed: ${reply.error}`);
      if (reply?.recycle === true) {
        recycles++;
        kill(); // a native OCC exception leaves the module degraded; the next call gets a fresh one
      }
      return reply?.result ?? null;
    }
    crashes++;
    console.warn(
      state === STATUS_DIED
        ? `[occt] worker aborted during ${op}; restarting it and returning null`
        : `[occt] ${op} exceeded ${callTimeoutMs} ms; killing the worker and returning null`,
    );
    kill();
    return null;
  };

  return {
    booleanOp: (op, a, b) =>
      call('booleanOp', [op, a, b]) as ReturnType<GeometryKernel['booleanOp']>,
    filletEdges: (shape, edges, radius) =>
      call('filletEdges', [shape, edges, radius]) as ReturnType<GeometryKernel['filletEdges']>,
    chamferEdges: (shape, edges, distance) =>
      call('chamferEdges', [shape, edges, distance]) as ReturnType<GeometryKernel['chamferEdges']>,
    shellSolid: (shape, thickness) =>
      call('shellSolid', [shape, thickness]) as ReturnType<GeometryKernel['shellSolid']>,
    tessellate: (entity) =>
      call('tessellate', [entity]) as ReturnType<GeometryKernel['tessellate']>,
    crashCount: () => crashes,
    recycleCount: () => recycles,
    forceFailure: (hook) => void call(hook, []),
    start: () => {
      try {
        live ??= spawn();
        return true;
      } catch (error) {
        console.warn(`[occt] ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    },
    dispose: kill,
  };
}

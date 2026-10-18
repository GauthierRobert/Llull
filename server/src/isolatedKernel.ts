/**
 * `GeometryKernel` running OCC in a worker thread behind a SYNCHRONOUS call (post, `Atomics.wait`,
 * `receiveMessageOnPort`). An abort, hang or failed start kills only the worker; the next call respawns it.
 * @invariant handles cross the thread as plain data (they carry their recipe): a recycled worker's successor rebuilds them
 * @failure worker died / timed out / failed to start -> null result + console.warn, never a throw
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { MessageChannel, Worker, receiveMessageOnPort, type MessagePort } from 'node:worker_threads';
import type { GeometryKernel, ShapeAnalysis, ShapeDistance, ShapeHandle, StepOccurrence } from '@core/geometry/kernel';
import type { ExactMassProperties, ImportShapesResult, KernelInfo } from '@core/geometry/kernelPorts';
import { errorMessage } from '@lib/errorMessage';
import { handleOf, keyOnlyHandle, SHAPE_NOT_CACHED } from '@core/geometry/shapeKernel';
import type { FaceQueryPort } from '@core/geometry/kernelPorts';
import { STATUS_DIED, STATUS_READY, STATUS_REPLY, type KernelOperation, type KernelReply, type TestHook } from './occtWorkerProtocol';

export interface IsolatedKernelOptions {
  readonly entry?: string; // default occtWorker.ts/.js next to this module
  readonly execArgv?: readonly string[];
  readonly callTimeoutMs?: number; // default 60 000
  readonly startTimeoutMs?: number; // WASM load, default 60 000
  readonly testHooks?: boolean; // enables `__abort` / `__hang`
}

export interface IsolatedKernel extends GeometryKernel {
  crashCount(): number; // worker died or was killed mid-call
  recycleCount(): number; // replaced after a degrading native exception
  forceFailure(hook: TestHook): void;
  /** Spawn the worker now (idempotent); false + warning when it cannot start. */
  start(): boolean;
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
 * Worker bootstrap: hooks death into the shared status word before loading the entry, so even a failed load wakes the server.
 * @invariant exit always writes STATUS_DIED + notifies; the server only clears status via compareExchange
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
  ready: boolean; // false while the WASM still loads in the background
  readonly blobsSent: Set<string>; // document B-rep blobs this worker already holds
}

class WorkerDiedOnStartError extends Error {
  constructor() {
    super('OCC worker died on start');
    this.name = 'WorkerDiedOnStartError';
  }
}

const FACE_QUERY_METHODS = [
  'faceDetails',
  'faceContains',
  'faceGraph',
  'faceGeometry',
  'projectOnFace',
  'evaluateFace',
  'tessellateFace',
  'faceSamples',
  'edgeSamples',
  'edgeContinuity',
  'distance',
  'bspline',
] as const satisfies readonly (keyof FaceQueryPort)[];

export function createIsolatedKernel(options: IsolatedKernelOptions = {}): IsolatedKernel {
  const entry = options.entry ?? defaultWorkerEntry();
  if (entry === null) throw new Error('OCC worker entry not found next to the server modules');
  const execArgv = options.execArgv !== undefined ? [...options.execArgv] : entry.endsWith('.ts') ? ['--require', 'tsx/cjs'] : undefined;
  const callTimeoutMs = options.callTimeoutMs ?? 60_000;
  const startTimeoutMs = options.startTimeoutMs ?? 60_000;
  let live: LiveWorker | null = null;
  let crashes = 0;
  let recycles = 0;
  /** Every document blob the host loaded, kept to re-send to a worker that was recycled or restarted. */
  const blobs = new Map<string, string>();
  let describedAs: KernelInfo | null = null;

  const kill = (): void => {
    if (live === null) return;
    live.port.close();
    void live.worker.terminate();
    live = null;
  };

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
    return { worker, port: port1, status, ready: false, blobsSent: new Set() };
  };

  const awaitReady = (candidate: LiveWorker): void => {
    if (candidate.ready) return;
    const { status } = candidate;
    const outcome = Atomics.wait(status, 0, 0, startTimeoutMs);
    if (outcome === 'timed-out' || Atomics.load(status, 0) !== STATUS_READY) {
      if (live === candidate) live = null;
      candidate.port.close();
      void candidate.worker.terminate();
      throw outcome === 'timed-out' ? new Error('OCC worker start timed out') : new WorkerDiedOnStartError();
    }
    Atomics.compareExchange(status, 0, STATUS_READY, 0); // a death since the load stays flagged
    candidate.ready = true;
  };

  /** @invariant only a background-launched worker that died on start is relaunched (once); timeouts are not retried */
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

  const recycle = (): void => {
    kill();
    try {
      live = launch();
    } catch (error) {
      console.warn(`[occt] warm restart failed: ${errorMessage(error)}`);
    }
  };

  /** One synchronous request/reply with `target`; null (worker recycled) when it died or timed out. */
  const transact = (target: LiveWorker, op: KernelOperation | TestHook, args: readonly unknown[]): KernelReply | null => {
    const { port, status } = target;
    port.postMessage({ op, args });
    const outcome = Atomics.wait(status, 0, 0, callTimeoutMs);
    const state = Atomics.load(status, 0);
    if (outcome !== 'timed-out' && state === STATUS_REPLY) {
      const reply = receiveMessageOnPort(port)?.message as KernelReply | undefined;
      Atomics.compareExchange(status, 0, STATUS_REPLY, 0); // idle; a death since the reply stays flagged
      if (reply?.error !== undefined && !reply.error.startsWith(SHAPE_NOT_CACHED)) console.warn(`[occt] ${op} failed: ${reply.error}`);
      if (reply?.recycle === true) {
        recycles++;
        recycle(); // a degraded module is replaced; the next call gets a fresh, pre-loaded one
      }
      return reply ?? null;
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

  /** @invariant a request reaches a worker only after it holds every blob the host loaded (`brep` leaves evaluate there) */
  const exchange = (op: KernelOperation | TestHook, args: readonly unknown[]): KernelReply | null => {
    let target: LiveWorker;
    try {
      target = ensureLive();
      if (Atomics.load(target.status, 0) === STATUS_DIED) {
        kill(); // the worker died while idle (its exit event may not have run yet)
        target = ensureLive();
      }
    } catch (error) {
      console.warn(`[occt] ${errorMessage(error)}; returning null`);
      return null;
    }
    for (const [sha256, text] of blobs) {
      if (target.blobsSent.has(sha256)) continue;
      target.blobsSent.add(sha256);
      // a reply that recycled the worker leaves `target` killed: stop here, the next call respawns and re-sends every blob
      if (transact(target, 'loadBlob', [sha256, text]) === null || live !== target) return null;
    }
    return transact(target, op, args);
  };

  const call = (op: KernelOperation | TestHook, args: readonly unknown[]): unknown => exchange(op, args)?.result ?? null;

  /** Output call with key-only handles first; on SHAPE_NOT_CACHED (evicted/recycled) retry with full recipes. */
  const shapeCall = (op: KernelOperation, handles: readonly ShapeHandle[], wrap: boolean, extra: readonly unknown[] = []): unknown => {
    const pack = (list: readonly ShapeHandle[]): unknown[] => (wrap ? [list] : [...list, ...extra]);
    const reply = exchange(op, pack(handles.map(keyOnlyHandle)));
    if (reply?.error?.startsWith(SHAPE_NOT_CACHED) !== true) return reply?.result ?? null;
    return call(op, pack(handles));
  };

  /** Assembly STEP: parts keep their object identity through the structured clone, so one part stays one product. */
  const exportStepAssembly = (occurrences: readonly StepOccurrence[]): string | null => {
    const withShapes = (map: (shape: ShapeHandle) => ShapeHandle): StepOccurrence[] => {
      const parts = new Map<StepOccurrence['part'], StepOccurrence['part']>();
      return occurrences.map((occurrence) => {
        const part = parts.get(occurrence.part) ?? { shapes: occurrence.part.shapes.map(map) };
        parts.set(occurrence.part, part);
        return { ...occurrence, part };
      });
    };
    const reply = exchange('exportStepAssembly', [withShapes(keyOnlyHandle)]);
    if (reply?.error?.startsWith(SHAPE_NOT_CACHED) !== true) return (reply?.result ?? null) as string | null;
    return call('exportStepAssembly', [withShapes((shape) => shape)]) as string | null;
  };

  const faceQuery = Object.fromEntries(
    FACE_QUERY_METHODS.map((method) => [
      method,
      (shape: ShapeHandle, ...args: unknown[]) => shapeCall(`faceQuery.${method}`, [shape], false, args),
    ]),
  ) as unknown as FaceQueryPort;

  return {
    name: 'occt',
    faceQuery,
    supports: () => true,
    evaluate: (recipe) => (call('evaluate', [recipe]) === null ? null : handleOf(recipe)),
    tessellate: (shape) => shapeCall('tessellate', [shape], false) as ReturnType<GeometryKernel['tessellate']>,
    topology: (shape) => shapeCall('topology', [shape], false) as ReturnType<GeometryKernel['topology']>,
    exportStep: (shapes) => shapeCall('exportStep', shapes, true) as ReturnType<GeometryKernel['exportStep']>,
    exportStepAssembly,
    analyze: (shape) => shapeCall('analyze', [shape], false) as ShapeAnalysis | null,
    massProperties: (shape) => shapeCall('massProperties', [shape], false) as ExactMassProperties | null,
    distance: (a, b, maxDistance) => shapeCall('distance', [a, b], false, [maxDistance]) as ShapeDistance | null,
    loadBlob: (sha256, brep) => void blobs.set(sha256, brep),
    importShapes: (format, text, options) => call('importShapes', [format, text, options]) as ImportShapesResult | null,
    info: () => {
      describedAs ??= call('info', []) as KernelInfo | null;
      return describedAs ?? { capabilities: [] };
    },
    crashCount: () => crashes,
    recycleCount: () => recycles,
    forceFailure: (hook) => void call(hook, []),
    start: () => {
      try {
        ensureLive();
        return true;
      } catch (error) {
        console.warn(`[occt] ${errorMessage(error)}`);
        return false;
      }
    },
    dispose: kill,
  };
}

// Physics queries (simulate_motion, check_prototype, …) while the backend is not connected: they run in the in-page physics worker
// (@app/physicsJob), off the UI thread, on the document as it is when asked. Connected, callers use the backend instead. The backend
// also serves the engine (the worker script and MuJoCo's WASM), so the panels that may need it warm it up while it is reachable.

import type { PhysicsJobAnswer, PhysicsWorkerLike } from '@app/physicsJob';
import { useStore } from '@ui/store';

export interface PhysicsRun {
  readonly summary: string;
  readonly data: unknown;
}

type WorkerFactory = () => PhysicsWorkerLike | null;

/** The in-page physics worker, or null where workers do not exist (tests under jsdom, a restricted renderer). */
function createPhysicsWorker(): PhysicsWorkerLike | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('../../physics.worker.ts', import.meta.url), { type: 'module' }) as unknown as PhysicsWorkerLike;
  } catch {
    return null;
  }
}

let factory: WorkerFactory = createPhysicsWorker;
let worker: PhysicsWorkerLike | null = null;
let nextId = 1;
const waiting = new Map<number, (run: PhysicsRun) => void>();

let warmed = false;

/** Replace how the worker is made (tests run the job in-process) and drop the current one. */
export function setPhysicsWorkerFactory(next: WorkerFactory | null): void {
  worker?.terminate();
  worker = null;
  warmed = false;
  waiting.clear();
  factory = next ?? createPhysicsWorker;
}

/** A worker that died takes its pending jobs with it: each is answered with the reason, and the next job starts a fresh worker. */
function failAll(reason: string): void {
  const pending = [...waiting.values()];
  waiting.clear();
  worker?.terminate();
  worker = null;
  warmed = false;
  for (const settle of pending) settle({ summary: reason, data: undefined });
}

function workerOrNull(): PhysicsWorkerLike | null {
  if (worker !== null) return worker;
  const created = factory();
  if (created === null) return null;
  created.onmessage = (event: { readonly data: PhysicsJobAnswer }): void => {
    const settle = waiting.get(event.data.id);
    waiting.delete(event.data.id);
    settle?.({ summary: event.data.summary, data: event.data.data });
  };
  created.onerror = (event): void => failAll(`The physics worker stopped: ${event.message ?? 'unknown error'}`);
  worker = created;
  return created;
}

/**
 * Start the worker and load the engine in the background, once (a no-op where workers do not exist). Called by the panels that offer
 * physics while the backend is reachable: the engine is then in memory if the backend goes away.
 */
export function warmPhysicsEngine(): void {
  if (warmed) return;
  const target = workerOrNull();
  if (target === null) return;
  warmed = true;
  target.postMessage({ id: nextId++, warm: true });
}

/**
 * @param onStatus progress line while the engine loads (the first job of a session fetches MuJoCo's WASM)
 * @returns the command's summary and data, or a summary saying why it could not run (no worker in this environment, a worker crash)
 */
export function runPhysicsQuery(
  command: string,
  params: Record<string, unknown>,
  onStatus?: (status: string) => void,
): Promise<PhysicsRun> {
  const first = worker === null;
  warmed = true;
  const target = workerOrNull();
  if (target === null)
    return Promise.resolve({
      summary: `${command} needs the llull backend (it is not connected) and the in-page physics engine is not available here.`,
      data: undefined,
    });
  if (first) onStatus?.('Loading the MuJoCo physics engine…');
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    target.postMessage({ id, document: useStore.getState().document, command, params });
  });
}

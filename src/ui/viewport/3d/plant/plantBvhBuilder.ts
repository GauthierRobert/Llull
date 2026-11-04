// Instance BVH of a plant scene, built in a Web Worker above WORKER_MIN_INSTANCES (else, and without Worker or after a worker error, in a
// deferred main-thread task). One build is current at a time: a newer scene drops the answer of an older one (stale key). A finished tree
// is kept per scene object and announced to subscribers (the plan hook), so small documents never see a notification they care about.

import { buildInstanceBvh, importInstanceBvh, packBoxes, type InstanceBvh } from '@core/geometry/instanceBvh';
import type { PlanScene } from '@core/geometry/renderPlan';
import type { BvhBuildAnswer, BvhBuildRequest } from './plantBvhProtocol';

/** Scenes from this many instances build in the worker and drive the plan's frustum query. */
export const WORKER_MIN_INSTANCES = 10_000;
const DEFER_MS = 50;

export interface BvhWorkerLike {
  onmessage: ((event: { readonly data: BvhBuildAnswer }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  postMessage(request: BvhBuildRequest, transfer: ArrayBuffer[]): void;
  terminate(): void;
}

export interface BvhBuilder {
  /** Starts the build of `scene` unless it is built or building; returns the cancel of a not yet started main-thread build. */
  request(scene: PlanScene): () => void;
  /** The finished tree of `scene`, if any. */
  ready(scene: PlanScene): InstanceBvh | undefined;
  /** The tree of `scene`, built now on the calling thread when missing. */
  buildNow(scene: PlanScene): InstanceBvh;
  subscribe(listener: () => void): () => void;
}

const buildOnThread = (scene: PlanScene): InstanceBvh => buildInstanceBvh(packBoxes(scene.instances.map((instance) => instance.aabb)));

export function createBvhBuilder(makeWorker: () => BvhWorkerLike | null): BvhBuilder {
  const built = new WeakMap<PlanScene, InstanceBvh>();
  const listeners = new Set<() => void>();
  let worker: BvhWorkerLike | null | undefined;
  let current: { readonly key: number; readonly scene: PlanScene } | null = null;
  let nextKey = 1;

  const publish = (scene: PlanScene, bvh: InstanceBvh): void => {
    if (built.has(scene)) return;
    built.set(scene, bvh);
    for (const listener of [...listeners]) listener();
  };
  const buildNow = (scene: PlanScene): InstanceBvh => {
    const existing = built.get(scene);
    if (existing !== undefined) return existing;
    const bvh = buildOnThread(scene);
    publish(scene, bvh);
    return bvh;
  };
  const defer = (scene: PlanScene): (() => void) => {
    const handle = setTimeout(() => {
      if (!built.has(scene)) buildNow(scene);
      if (current?.scene === scene) current = null;
    }, DEFER_MS);
    return () => clearTimeout(handle);
  };
  const fallBack = (): void => {
    if (current !== null) defer(current.scene);
  };
  const workerOrNull = (): BvhWorkerLike | null => {
    if (worker !== undefined) return worker;
    worker = makeWorker();
    if (worker === null) return null;
    const created = worker;
    created.onmessage = (event): void => {
      const { key, buffers } = event.data;
      if (current === null || current.key !== key) return; // stale: a newer scene was requested meanwhile
      const { scene } = current;
      try {
        publish(scene, importInstanceBvh(buffers));
        current = null;
      } catch {
        fallBack();
      }
    };
    created.onerror = (): void => {
      worker = null;
      created.terminate();
      fallBack();
    };
    return created;
  };

  return {
    ready: (scene) => built.get(scene),
    buildNow,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    request(scene) {
      if (built.has(scene) || current?.scene === scene) return () => undefined;
      const key = nextKey++;
      current = { key, scene };
      const target = scene.instances.length >= WORKER_MIN_INSTANCES ? workerOrNull() : null;
      if (target === null) return defer(scene);
      const boxes = packBoxes(scene.instances.map((instance) => instance.aabb));
      target.postMessage({ key, boxes }, [boxes.buffer as ArrayBuffer]);
      return () => undefined;
    },
  };
}

function browserWorker(): BvhWorkerLike | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('./plantBvh.worker.ts', import.meta.url), { type: 'module' }) as unknown as BvhWorkerLike;
  } catch {
    return null;
  }
}

export const plantBvhBuilder: BvhBuilder = createBvhBuilder(browserWorker);

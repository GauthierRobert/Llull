import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importInstanceBvh } from '@core/geometry/instanceBvh';
import { planRender, planScene, type PlanScene } from '@core/geometry/renderPlan';
import { framedPlanCamera } from '@core/geometry/renderPlanCamera';
import { createBvhBuilder, WORKER_MIN_INSTANCES, type BvhWorkerLike } from '@ui/viewport/3d/plant/plantBvhBuilder';
import { answerBuild, type BvhBuildRequest } from '@ui/viewport/3d/plant/plantBvhProtocol';
import { synRackDocument } from '../helpers/synRack';

const bigScene = (): PlanScene => planScene(synRackDocument(44));
const smallScene = (): PlanScene => planScene(synRackDocument(8));

class FakeWorker implements BvhWorkerLike {
  onmessage: BvhWorkerLike['onmessage'] = null;
  onerror: BvhWorkerLike['onerror'] = null;
  readonly requests: BvhBuildRequest[] = [];
  terminated = false;
  postMessage(request: BvhBuildRequest): void {
    this.requests.push(request);
  }
  terminate(): void {
    this.terminated = true;
  }
  /** Answers request `index` the way the real worker does. */
  answer(index: number): void {
    const { answer } = answerBuild(this.requests[index] as BvhBuildRequest);
    this.onmessage?.({ data: answer });
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('plant BVH worker protocol', () => {
  it('answers with buffers that import into a BVH equal to the main-thread build', () => {
    const scene = smallScene();
    const reference = createBvhBuilder(() => null).buildNow(scene);
    const boxes = new Float64Array(scene.instances.length * 6);
    scene.instances.forEach((instance, i) => boxes.set([...instance.aabb.min, ...instance.aabb.max], i * 6));
    const { answer, transfer } = answerBuild({ key: 7, boxes });
    expect(answer.key).toBe(7);
    expect(transfer).toBe(answer.buffers.transfer);
    const imported = importInstanceBvh(answer.buffers);
    expect(imported.count).toBe(reference.count);
    expect(imported.rayQuery([0, 0, 6411], [1, 0, 0])).toEqual(reference.rayQuery([0, 0, 6411], [1, 0, 0]));
  });
});

describe('plant BVH builder', () => {
  it('builds big scenes in the worker and notifies subscribers once', () => {
    const scene = bigScene();
    expect(scene.instances.length).toBeGreaterThanOrEqual(WORKER_MIN_INSTANCES);
    const worker = new FakeWorker();
    const builder = createBvhBuilder(() => worker);
    const listener = vi.fn();
    builder.subscribe(listener);
    builder.request(scene);
    builder.request(scene);
    expect(worker.requests).toHaveLength(1);
    expect(builder.ready(scene)).toBeUndefined();
    worker.answer(0);
    expect(builder.ready(scene)).toBeDefined();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('drops the answer of a stale build', () => {
    const [older, newer] = [bigScene(), bigScene()];
    const worker = new FakeWorker();
    const builder = createBvhBuilder(() => worker);
    builder.request(older);
    builder.request(newer);
    worker.answer(0);
    expect(builder.ready(older)).toBeUndefined();
    expect(builder.ready(newer)).toBeUndefined();
    worker.answer(1);
    expect(builder.ready(newer)).toBeDefined();
    expect(builder.ready(older)).toBeUndefined();
  });

  it('builds small scenes in a deferred main-thread task, never in the worker', () => {
    const scene = smallScene();
    const worker = new FakeWorker();
    const builder = createBvhBuilder(() => worker);
    builder.request(scene);
    expect(worker.requests).toHaveLength(0);
    expect(builder.ready(scene)).toBeUndefined();
    vi.advanceTimersByTime(100);
    expect(builder.ready(scene)).toBeDefined();
  });

  it('cancels a deferred build', () => {
    const scene = smallScene();
    const builder = createBvhBuilder(() => null);
    builder.request(scene)();
    vi.advanceTimersByTime(100);
    expect(builder.ready(scene)).toBeUndefined();
  });

  it('falls back to the main thread without a Worker', () => {
    const scene = bigScene();
    const builder = createBvhBuilder(() => null);
    builder.request(scene);
    vi.advanceTimersByTime(100);
    expect(builder.ready(scene)).toBeDefined();
  });

  it('falls back to the main thread when the worker fails', () => {
    const scene = bigScene();
    const worker = new FakeWorker();
    const builder = createBvhBuilder(() => worker);
    builder.request(scene);
    worker.onerror?.(new Error('boom'));
    expect(worker.terminated).toBe(true);
    vi.advanceTimersByTime(100);
    expect(builder.ready(scene)).toBeDefined();
  });

  it('falls back to the main thread when the worker answer is invalid', () => {
    const scene = bigScene();
    const worker = new FakeWorker();
    const builder = createBvhBuilder(() => worker);
    builder.request(scene);
    const { answer } = answerBuild(worker.requests[0] as BvhBuildRequest);
    worker.onmessage?.({ data: { key: answer.key, buffers: { ...answer.buffers, count: -1 } } });
    vi.advanceTimersByTime(100);
    expect(builder.ready(scene)).toBeDefined();
  });

  it('buildNow serves a pick that arrives before the worker answer, and the later answer changes nothing', () => {
    const scene = bigScene();
    const worker = new FakeWorker();
    const builder = createBvhBuilder(() => worker);
    builder.request(scene);
    const now = builder.buildNow(scene);
    worker.answer(0);
    expect(builder.ready(scene)).toBe(now);
  });

  it('a plan through the BVH query equals the plan without it (SYN-RACK)', () => {
    const scene = bigScene();
    const bvh = createBvhBuilder(() => null).buildNow(scene);
    const camera = framedPlanCamera({
      view: 'iso',
      projection: 'perspective',
      center: [0, 0, 6000],
      radius: 9000,
      widthPx: 1920,
      heightPx: 1080,
    });
    if (typeof camera === 'string') throw new Error(camera);
    const plain = planRender(scene, camera, { multiDraw: true, quality: 'medium' });
    const indexed = planRender(scene, camera, { multiDraw: true, quality: 'medium', query: (planes) => bvh.frustumQuery(planes) });
    expect(indexed.levels).toEqual(plain.levels);
    expect(indexed).toEqual(plain);
  });
});

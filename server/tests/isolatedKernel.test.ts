/**
 * @layer server/tests
 * The OCC kernel runs in a worker thread: a forced WASM-style abort (Emscripten `process.exit`) or
 * a hang kills only the worker, the call returns null, and the next call respawns it.
 */

import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Entity } from '@core/model/types';
import { createIsolatedKernel, type IsolatedKernel } from '../src/isolatedKernel';

const box = (size: number): Entity =>
  ({
    id: 'b',
    kind: 'box',
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    size: [size, size, size],
    layerId: 'layer-default',
    color: '#888888',
  }) as Entity;

const kernels: IsolatedKernel[] = [];
const make = (callTimeoutMs?: number): IsolatedKernel => {
  const kernel = createIsolatedKernel({
    testHooks: true,
    ...(callTimeoutMs !== undefined ? { callTimeoutMs } : {}),
  });
  kernels.push(kernel);
  return kernel;
};

afterAll(() => kernels.forEach((kernel) => kernel.dispose()));

describe('isolated OCC kernel', () => {
  it('tessellates and runs booleans through the worker', () => {
    const kernel = make();
    expect(kernel.tessellate(box(2))?.indices).toHaveLength(36);
    const union = kernel.booleanOp('union', box(2), { ...box(2), position: [1, 0, 0] } as Entity);
    expect(union).not.toBeNull();
    expect(kernel.crashCount()).toBe(0);
  }, 120_000);

  it('survives a forced abort: null result, process alive, worker respawned', () => {
    const kernel = make();
    expect(kernel.tessellate(box(2))).not.toBeNull();
    kernel.forceFailure('__abort');
    expect(kernel.crashCount()).toBe(1);
    expect(kernel.tessellate(box(3))?.indices).toHaveLength(36);
    kernel.forceFailure('__abort');
    expect(kernel.crashCount()).toBe(2);
    expect(kernel.tessellate(box(4))).not.toBeNull();
  }, 180_000);

  it('kills a hung worker after the call timeout and recovers', () => {
    const kernel = make(1_500);
    expect(kernel.tessellate(box(2))).not.toBeNull();
    kernel.forceFailure('__hang');
    expect(kernel.crashCount()).toBe(1);
    expect(kernel.tessellate(box(2))).not.toBeNull();
  }, 180_000);

  it('replaces a worker whose OCC call failed natively, so later calls are not poisoned', () => {
    // A cone apex exactly on a box face makes OCC fail; without a restart the module then returns
    // spurious nulls for the next several (even trivial) calls.
    const kernel = make();
    const cone = (height: number): Entity =>
      ({
        id: 'k',
        kind: 'cone',
        radius: 1,
        height,
        position: [0, 0, -3],
        rotation: [0, 0, 0],
        layerId: 'layer-default',
        color: '#888888',
      }) as Entity;
    const floor = { ...box(8), position: [0, 0, -4] } as Entity;
    kernel.booleanOp('union', cone(3), floor);
    kernel.booleanOp('intersect', cone(3), floor);
    expect(kernel.recycleCount()).toBeGreaterThanOrEqual(1);
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(kernel.tessellate(box(2)), 'tessellate').not.toBeNull();
      expect(kernel.booleanOp('union', cone(2.99), floor), 'union').not.toBeNull();
      expect(kernel.booleanOp('intersect', cone(2.99), floor), 'intersect').not.toBeNull();
    }
  }, 180_000);

  it('does not recycle the worker for a graceful refusal such as an oversized fillet', () => {
    const kernel = make();
    const mesh = kernel.tessellate(box(10));
    expect(mesh).not.toBeNull();
    expect(kernel.filletEdges(mesh!, [], 50)).toBeNull();
    expect(kernel.recycleCount()).toBe(0);
    expect(kernel.crashCount()).toBe(0);
    expect(kernel.tessellate(box(2))).not.toBeNull();
  }, 120_000);

  it('reloads a recycled worker in the background so the next call is not slow', async () => {
    const kernel = make();
    const cone = {
      id: 'k',
      kind: 'cone',
      radius: 1,
      height: 3,
      position: [0, 0, -3],
      rotation: [0, 0, 0],
      layerId: 'layer-default',
      color: '#888888',
    } as Entity;
    const floor = { ...box(8), position: [0, 0, -4] } as Entity;
    kernel.booleanOp('union', cone, floor);
    expect(kernel.recycleCount()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 15_000)); // the replacement loads meanwhile
    const started = Date.now();
    expect(kernel.tessellate(box(2))).not.toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  }, 120_000);

  describe('a worker that dies while idle', () => {
    const sleepSync = (ms: number): void =>
      void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

    it('is replaced on the next call (event loop blocked: status word flags the death)', () => {
      const kernel = make(20_000);
      expect(kernel.tessellate(box(2))).not.toBeNull();
      kernel.forceFailure('__exitIdle');
      sleepSync(1_500); // the worker exits; its 'exit' event cannot run on this blocked thread
      const started = Date.now();
      expect(kernel.tessellate(box(3))?.indices).toHaveLength(36);
      expect(Date.now() - started).toBeLessThan(15_000);
    }, 120_000);

    it('is replaced on the next call (exit event handled)', async () => {
      const kernel = make(20_000);
      expect(kernel.tessellate(box(2))).not.toBeNull();
      kernel.forceFailure('__exitIdle');
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const started = Date.now();
      expect(kernel.tessellate(box(3))?.indices).toHaveLength(36);
      expect(Date.now() - started).toBeLessThan(15_000);
    }, 120_000);
  });

  it('a worker that exits with an unconsumed REPLY wakes the server as DIED, not at the timeout', () => {
    const kernel = createIsolatedKernel({
      entry: path.join(__dirname, 'fixtures', 'replyThenExitWorker.cjs'),
      execArgv: [],
      callTimeoutMs: 20_000,
    });
    kernels.push(kernel);
    const started = Date.now();
    expect(kernel.tessellate(box(2))).toBeNull();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(kernel.crashCount()).toBe(1);
  }, 60_000);

  it('retries once when the background-loaded replacement worker dies on start', () => {
    const counterFile = path.join(os.tmpdir(), `llull-flaky-worker-${process.pid}`);
    rmSync(counterFile, { force: true });
    const kernel = createIsolatedKernel({
      entry: path.join(__dirname, 'fixtures', 'flakyStartWorker.cjs'),
      execArgv: [],
      testHooks: true,
    });
    kernels.push(kernel);
    try {
      expect(kernel.tessellate(box(2))).toEqual({ loads: 0 });
      kernel.forceFailure('__abort'); // the warm restart (load #1) dies on start
      expect(kernel.crashCount()).toBe(1);
      expect(kernel.tessellate(box(2))).toEqual({ loads: 2 });
    } finally {
      rmSync(counterFile, { force: true });
    }
  }, 60_000);

  it('returns null promptly instead of throwing when the worker cannot load', () => {
    const kernel = createIsolatedKernel({
      entry: path.join(__dirname, 'missing-worker.js'),
      startTimeoutMs: 30_000,
    });
    const started = Date.now();
    expect(kernel.tessellate(box(2))).toBeNull();
    expect(Date.now() - started).toBeLessThan(15_000);
    kernel.dispose();
  }, 60_000);
});

/**
 * @layer server/tests
 * The OCC kernel runs in a worker thread: a forced WASM-style abort (Emscripten `process.exit`) or
 * a hang kills only the worker, the call returns null, and the next call respawns it.
 */

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

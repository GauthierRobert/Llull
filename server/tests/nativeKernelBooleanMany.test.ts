/**
 * ASC M1a through the real sidecar: the multi-tool boolean (`many`) equals the balanced tree, reports how it ran, and the deadline / cancel of
 * native ops answer `KRN_TIMEOUT` while the process stays alive (VC-ASC-03, 05).
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Entity, ShapeRecipe } from '@core/model/types';
import { createNativeKernel } from '../src/nativeKernel';
import { createKernelSession, spawnKernelChild } from '../src/native/kernelSession';
import type { IsolatedKernel } from '../src/isolatedKernel';
import { box, common, createNativeTestKernel, describeNativeWhen, leaf, nativeKernelBinary } from './kernelTestSupport';

const describeMany = describeNativeWhen({ capabilities: ['booleanMany'], label: 'native boolean many' });

const cylinder = (x: number, y: number): Entity =>
  ({ id: 'c', kind: 'cylinder', position: [x, y, 0], rotation: [0, 0, 0], radius: 1, height: 6, ...common }) as Entity;

/** The balanced union `boolean.ts` builds. */
function balanced(tools: readonly ShapeRecipe[]): ShapeRecipe {
  if (tools.length === 1) return tools[0] as ShapeRecipe;
  const middle = Math.ceil(tools.length / 2);
  return { op: 'boolean', boolean: 'union', a: balanced(tools.slice(0, middle)), b: balanced(tools.slice(middle)) };
}

/** A plate of `columns x rows` cells with one through hole tool per cell. */
function drilledPlate(columns: number, rows: number, many: boolean): ShapeRecipe {
  const tools = Array.from({ length: columns * rows }, (_, k) => leaf(cylinder((k % columns) * 4 + 2, Math.floor(k / columns) * 4 + 2)));
  const plate = leaf(box([columns * 2, rows * 2, 0], [columns * 4, rows * 4, 2]));
  return { op: 'boolean', boolean: 'subtract', a: plate, b: balanced(tools), ...(many ? { many: tools.length } : {}) };
}

function measure(kernel: IsolatedKernel, recipe: ShapeRecipe): { volume: number; faces: number; ms: number } {
  const started = performance.now();
  const shape = kernel.evaluate(recipe);
  expect(shape).not.toBeNull();
  const ms = performance.now() - started;
  return { volume: kernel.massProperties!(shape!)!.volume, faces: kernel.topology(shape!)!.faces.length, ms };
}

describeMany('native multi-tool boolean (ASC M1a)', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
  }, 120_000);
  afterAll(() => kernel?.dispose());

  it('equals the balanced tree in volume (1e-6) and face count, and reports one general fuse', () => {
    const tree = measure(kernel, drilledPlate(6, 4, false));
    const many = measure(kernel, drilledPlate(6, 4, true));
    expect(Math.abs(many.volume - tree.volume)).toBeLessThanOrEqual(1e-6 * tree.volume);
    expect(many.faces).toBe(tree.faces);
    expect(many.volume).toBeCloseTo(24 * 16 * 2 - 24 * Math.PI * 2, 5);
    expect(kernel.booleanReport!(drilledPlate(6, 4, true))).toEqual({ mode: 'general-fuse', tools: 24 });
    expect(kernel.booleanReport!(drilledPlate(6, 4, false))).toBeNull();
  });

  it('fuses a row of overlapping boxes in one operation', () => {
    const row = Array.from({ length: 12 }, (_, k) => leaf(box([2 * k, 0, 0], [3, 2, 2])));
    const [first, ...rest] = row as [ShapeRecipe, ...ShapeRecipe[]];
    const many: ShapeRecipe = { op: 'boolean', boolean: 'union', a: first, b: balanced(rest), many: rest.length };
    const tree: ShapeRecipe = { op: 'boolean', boolean: 'union', a: first, b: balanced(rest) };
    const [got, expected] = [measure(kernel, many), measure(kernel, tree)];
    expect(Math.abs(got.volume - expected.volume)).toBeLessThanOrEqual(1e-6 * expected.volume);
    expect(got.faces).toBe(expected.faces);
    expect(got.volume).toBeCloseTo(2 * 11 * 2 * 2 + 3 * 2 * 2, 6);
  });

  it('a 400-tool subtract finishes inside the budget (timings logged)', () => {
    const many = measure(kernel, drilledPlate(20, 20, true));
    expect(many.volume).toBeCloseTo(80 * 80 * 2 - 400 * Math.PI * 2, 4);
    const tree = measure(kernel, drilledPlate(20, 20, false));
    console.warn(`[asc m1a] 400 cylinder tools: one general cut ${Math.round(many.ms)} ms, balanced tree ${Math.round(tree.ms)} ms`);
    expect(many.ms).toBeLessThan(10_000);
  }, 180_000);
});

describeMany('native deadline and cancel (ASC TR-ASC-04)', () => {
  it('answers KRN_TIMEOUT at the deadline, keeps the worker alive and builds the next recipe', () => {
    const kernel = createNativeTestKernel({ callTimeoutMs: 40 });
    try {
      const refused = kernel.evaluate(drilledPlate(20, 20, true));
      expect(refused).toBeNull();
      expect(kernel.lastRefusal!()).toMatch(/^KRN_TIMEOUT: stage=.+ fraction=/);
      expect(kernel.crashCount()).toBe(0);
      expect(kernel.evaluate(leaf(box([0, 0, 0], [1, 1, 1])))).not.toBeNull();
      expect(kernel.crashCount()).toBe(0);
    } finally {
      kernel.dispose();
    }
  }, 60_000);

  it('a hard kill comes only after the deadline plus the grace period', () => {
    const kernel = createNativeKernel(nativeKernelBinary!, { testHooks: true, callTimeoutMs: 300, killGraceMs: 700 });
    expect(kernel.start()).toBe(true);
    try {
      const started = performance.now();
      kernel.forceFailure('__hang');
      const waited = performance.now() - started;
      expect(kernel.crashCount()).toBe(1);
      expect(waited).toBeGreaterThanOrEqual(950);
      expect(kernel.evaluate(leaf(box([0, 0, 0], [1, 1, 1])))).not.toBeNull();
    } finally {
      kernel.dispose();
    }
  }, 60_000);

  it('a cancel message stops the running boolean; the sidecar answers the next request', async () => {
    const session = createKernelSession(spawnKernelChild(nativeKernelBinary!));
    try {
      const recipe = drilledPlate(20, 20, true);
      const running = session.request('evaluate', [{ key: 'big', recipe }]);
      await new Promise((resolve) => setTimeout(resolve, 150));
      session.cancel();
      const reply = await running;
      expect(reply.error).toMatch(/^KRN_TIMEOUT: stage=/);
      expect(reply.result).toBeNull();
      expect(session.alive()).toBe(true);
      const next = await session.request('evaluate', [{ key: 'unit', recipe: leaf(box([0, 0, 0], [1, 1, 1])) }]);
      expect(next.error).toBeUndefined();
    } finally {
      session.close();
    }
  }, 60_000);
});

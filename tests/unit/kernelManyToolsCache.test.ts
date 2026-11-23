import { describe, expect, it } from 'vitest';
import { kernelFromOps, type KernelOps } from '@core/geometry/shapeKernel';
import type { Entity, ShapeRecipe } from '@core/model/types';

const leaf = (k: number): ShapeRecipe => ({ op: 'solid', entity: { id: `t${k}`, kind: 'box', size: [k + 1, 1, 1] } as unknown as Entity });

/** Balanced union of `tools` (split at ceil(n / 2)), as `boolean` builds it. */
const balanced = (tools: readonly ShapeRecipe[]): ShapeRecipe => {
  if (tools.length === 1) return tools[0] as ShapeRecipe;
  const head = Math.ceil(tools.length / 2);
  return { op: 'boolean', boolean: 'union', a: balanced(tools.slice(0, head)), b: balanced(tools.slice(head)) };
};

const ops = (): KernelOps<number> => ({ solid: () => 1, boolean: () => 1, release: () => undefined }) as unknown as KernelOps<number>;

describe('many-tool boolean vs the shape cache', () => {
  it('builds each of 300 leaves once, also when the result is evaluated again after other work', () => {
    const kernel = kernelFromOps(ops(), 32);
    const tools = Array.from({ length: 300 }, (_, k) => leaf(k));
    const many: ShapeRecipe = { op: 'boolean', boolean: 'subtract', a: leaf(1000), b: balanced(tools), many: 300 };
    expect(kernel.evaluate(many)).not.toBeNull();
    const built = kernel.buildCount();
    expect(kernel.cachedShapeCount()).toBeGreaterThan(300);
    for (const tool of tools) expect(kernel.evaluate(tool)).not.toBeNull();
    expect(kernel.buildCount()).toBe(built);
  });

  it('a plain list without `many` still obeys the bound', () => {
    const kernel = kernelFromOps(ops(), 32);
    const tools = Array.from({ length: 300 }, (_, k) => leaf(k));
    kernel.evaluate({ op: 'boolean', boolean: 'subtract', a: leaf(1000), b: balanced(tools) });
    expect(kernel.cachedShapeCount()).toBeLessThanOrEqual(32);
  });

  it('a hostile `many` does not raise the bound', () => {
    const kernel = kernelFromOps(ops(), 32);
    kernel.evaluate({ op: 'boolean', boolean: 'subtract', a: leaf(1), b: leaf(2), many: 1e9 });
    expect(kernel.cachedShapeCount()).toBeLessThanOrEqual(32);
  });
});

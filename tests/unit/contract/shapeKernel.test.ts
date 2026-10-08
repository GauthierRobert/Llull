/** kernelFromOps: recipe evaluation, per-recipe shape cache, handle lifetime, native ownership. */
import { describe, it, expect, vi } from 'vitest';
import type { BoxEntity, Entity } from '@core/model/types';
import type { ShapeRecipe } from '@core/geometry/shapeRecipe';
import {
  handleOf,
  keyOnlyHandle,
  kernelFromOps,
  SHAPE_NOT_CACHED,
  type KernelOps,
} from '@core/geometry/shapeKernel';
import type { MeshData, ShapeTopology } from '@core/geometry/kernel';
import { TETRA } from '../../helpers/fakeKernel';

/** Native shape of the counting ops: a serial number plus how it was built. */
interface Native {
  readonly serial: number;
  readonly label: string;
}

const TOPOLOGY: ShapeTopology = { solids: 1, faces: [], edges: [], vertices: 0, volume: 1 };

function countingOps(overrides: Partial<KernelOps<Native>> = {}): {
  ops: KernelOps<Native>;
  released: number[];
  built: string[];
} {
  let serial = 0;
  const released: number[] = [];
  const built: string[] = [];
  const make = (label: string): Native => {
    built.push(label);
    return { serial: ++serial, label };
  };
  const ops: KernelOps<Native> = {
    solid: (entity) => make(`solid:${entity.id}`),
    boolean: (op, a, b) => make(`${op}(${a.label},${b.label})`),
    fillet: (s, edges, size) => make(`fillet(${s.label},${edges.join('|')},${size})`),
    chamfer: (s) => make(`chamfer(${s.label})`),
    shell: (s) => make(`shell(${s.label})`),
    place: (s) => make(`place(${s.label})`),
    scale: (s) => make(`scale(${s.label})`),
    tessellate: (): MeshData => TETRA,
    topology: () => TOPOLOGY,
    exportStep: (shapes) => `STEP:${shapes.map((s) => s.label).join(',')}`,
    release: (s) => void released.push(s.serial),
    ...overrides,
  };
  return { ops, released, built };
}

const box = (id: string, x = 0): BoxEntity => ({
  id,
  kind: 'box',
  position: [x, 0, 0],
  rotation: [0, 0, 0],
  layerId: 'layer-0',
  color: '#888888',
  size: [1, 1, 1],
});
const leaf = (entity: Entity): ShapeRecipe => ({ op: 'solid', entity });
const union = (a: ShapeRecipe, b: ShapeRecipe): ShapeRecipe => ({
  op: 'boolean',
  boolean: 'union',
  a,
  b,
});

describe('kernelFromOps', () => {
  it('walks every recipe node with the native ops', () => {
    const { ops, built } = countingOps();
    const kernel = kernelFromOps(ops);
    const base = union(leaf(box('a')), leaf(box('b', 1)));
    const recipes: ShapeRecipe[] = [
      { op: 'fillet', source: base, edges: [0, 2], size: 0.5 },
      { op: 'chamfer', source: base, edges: [], size: 0.5 },
      { op: 'shell', source: base, thickness: 0.1 },
      { op: 'place', source: base, position: [1, 0, 0], rotation: [0, 0, 0] },
      { op: 'scale', source: base, factor: 2 },
    ];
    for (const recipe of recipes) expect(kernel.evaluate(recipe)).not.toBeNull();
    expect(built).toEqual([
      'solid:a',
      'solid:b',
      'union(solid:a,solid:b)',
      'fillet(union(solid:a,solid:b),0|2,0.5)',
      'chamfer(union(solid:a,solid:b))',
      'shell(union(solid:a,solid:b))',
      'place(union(solid:a,solid:b))',
      'scale(union(solid:a,solid:b))',
    ]);
  });

  it('rebuilds nothing for an unchanged recipe (a recolored operand included)', () => {
    const { ops } = countingOps();
    const kernel = kernelFromOps(ops);
    kernel.evaluate(union(leaf(box('a')), leaf(box('b', 1))));
    const builds = kernel.buildCount();
    kernel.evaluate(union(leaf({ ...box('a'), color: '#ff0000' }), leaf(box('b', 1))));
    expect(kernel.buildCount()).toBe(builds);
  });

  it('caches a refused recipe and short-circuits everything built on it', () => {
    const { ops, built } = countingOps({ fillet: () => null });
    const kernel = kernelFromOps(ops);
    const refused: ShapeRecipe = { op: 'fillet', source: leaf(box('a')), edges: [], size: 9 };
    expect(kernel.evaluate(refused)).toBeNull();
    expect(kernel.evaluate(union(refused, leaf(box('b'))))).toBeNull();
    expect(kernel.evaluate(refused)).toBeNull();
    expect(built).toEqual(['solid:a']);
  });

  it('maps a throwing op to null with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { ops } = countingOps({
      solid: () => {
        throw new Error('boom');
      },
    });
    expect(kernelFromOps(ops).evaluate(leaf(box('a')))).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
    warn.mockRestore();
  });

  it('lets the kernel rewrite boolean operands before building them', () => {
    const { ops, built } = countingOps({
      prepareBoolean: (a, b) => [b, a],
    });
    kernelFromOps(ops).evaluate(union(leaf(box('a')), leaf(box('b', 1))));
    expect(built.at(-1)).toBe('union(solid:b,solid:a)');
  });

  it('evicts least-recent shapes past capacity and releases each exactly once', () => {
    const { ops, released } = countingOps();
    const kernel = kernelFromOps(ops, 2);
    for (let i = 0; i < 5; i++) kernel.evaluate(leaf(box(`b${i}`, i)));
    expect(kernel.cachedShapeCount()).toBe(2);
    expect(released).toEqual([1, 2, 3]);
    kernel.clear();
    expect(released.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(kernel.cachedShapeCount()).toBe(0);
  });

  it('defers eviction to the end of the outermost call (tree larger than the cache)', () => {
    const { ops, released, built } = countingOps();
    const kernel = kernelFromOps(ops, 1);
    const left = union(leaf(box('a')), leaf(box('b', 1)));
    const right = union(leaf(box('c', 2)), leaf(box('d', 3)));
    expect(kernel.evaluate(union(left, right))).not.toBeNull();
    expect(built.at(-1)).toBe('union(union(solid:a,solid:b),union(solid:c,solid:d))');
    expect(kernel.cachedShapeCount()).toBe(1);
    expect(new Set(released).size).toBe(released.length);
    expect(released).toHaveLength(6);
  });

  it('keeps a handle valid after its shape was evicted: it is rebuilt from the recipe', () => {
    const { ops } = countingOps();
    const kernel = kernelFromOps(ops);
    const handle = kernel.evaluate(leaf(box('a')))!;
    kernel.clear();
    expect(kernel.tessellate(handle)).toBe(TETRA);
    expect(kernel.topology(handle)).toBe(TOPOLOGY);
    expect(kernel.exportStep([handle])).toBe('STEP:solid:a');
  });

  it('memoizes tessellations and reports null outputs for refused handles', () => {
    const tessellate = vi.fn(() => TETRA);
    const { ops } = countingOps({ tessellate });
    const kernel = kernelFromOps(ops);
    const handle = kernel.evaluate(leaf(box('a')))!;
    kernel.tessellate(handle);
    kernel.tessellate(handle);
    expect(tessellate).toHaveBeenCalledTimes(1);

    const refusing = kernelFromOps(countingOps({ solid: () => null }).ops);
    const stale = handle; // minted by another kernel: rebuilt here, and refused
    expect(refusing.tessellate(stale)).toBeNull();
    expect(refusing.topology(stale)).toBeNull();
    expect(refusing.exportStep([stale])).toBeNull();
  });

  it('retries cached failures once the native module reports degradation', () => {
    let epoch = 0;
    let healthy = false;
    const { ops } = countingOps({
      failureEpoch: () => epoch,
      solid: (entity) => (healthy ? { serial: 1, label: entity.id } : null),
    });
    const kernel = kernelFromOps(ops);
    expect(kernel.evaluate(leaf(box('a')))).toBeNull();
    healthy = true;
    expect(kernel.evaluate(leaf(box('a')))).toBeNull(); // cached refusal
    epoch++;
    expect(kernel.evaluate(leaf(box('a')))).not.toBeNull();
  });

  it('reports its capability gaps', () => {
    const kernel = kernelFromOps(countingOps({ unsupported: new Set(['fillet']) }).ops);
    expect(kernel.supports('fillet')).toBe(false);
    expect(kernel.supports('boolean')).toBe(true);
  });

  it('serves key-only handles from the cache and asks for the recipe on a miss', () => {
    const { ops } = countingOps();
    const kernel = kernelFromOps(ops);
    const handle = kernel.evaluate(leaf(box('a')))!;
    expect(kernel.topology(keyOnlyHandle(handle))).toBe(TOPOLOGY);
    expect(handleOf(leaf(box('a')))).toEqual(handle);
    kernel.clear();
    expect(() => kernel.topology(keyOnlyHandle(handle))).toThrow(SHAPE_NOT_CACHED);
    expect(kernel.topology(handle)).toBe(TOPOLOGY);
  });

  it('survives a release that throws', () => {
    const { ops } = countingOps({
      release: () => {
        throw new Error('already gone');
      },
    });
    const kernel = kernelFromOps(ops, 1);
    kernel.evaluate(leaf(box('a')));
    expect(() => kernel.evaluate(leaf(box('b', 1)))).not.toThrow();
    expect(() => kernel.clear()).not.toThrow();
  });
});

import { describe, it, expect, vi } from 'vitest';
import type { BoxEntity, Entity, MeshSolidEntity, ShapeRecipe, MeshData } from '@core/model/types';
import { geometryKey, meshRecipeOf, recipeKey, recipeOf, validateShapeRecipe } from '@core/geometry/shapeRecipe';
import { TETRA } from '../../helpers/fakeKernel';
import { handleOf, keyOnlyHandle, kernelFromOps, SHAPE_NOT_CACHED, type KernelOps } from '@core/geometry/shapeKernel';
import type { ShapeTopology } from '@core/geometry/kernel';

function box(id: string, color: string, x = 0): BoxEntity {
  return { id, kind: 'box', position: [x, 0, 0], rotation: [0, 0, 0], layerId: 'layer-0', color, size: [1, 1, 1] };
}

const union = (a: Entity, b: Entity): ShapeRecipe => ({ op: 'boolean', boolean: 'union', a: recipeOf(a), b: recipeOf(b) });

function result(brep: ShapeRecipe, position: [number, number, number] = [0, 0, 0]): MeshSolidEntity {
  return { id: 'mesh-1', kind: 'mesh', position, rotation: [0, 0, 0], layerId: 'layer-0', color: '#888888', mesh: TETRA, brep };
}

describe('recipeKey', () => {
  it('ignores presentation fields (id, name, color, layer, tags, material)', () => {
    const recolored = { ...box('b', '#000000'), name: 'n', tags: ['t'], materialId: 'm' };
    expect(geometryKey(box('a', '#ffffff'))).toBe(geometryKey(recolored));
    expect(recipeKey(union(box('a', '#fff'), box('b', '#fff', 1)))).toBe(recipeKey(union(box('x', '#000', 0), box('y', '#123', 1))));
  });
  it('differs when any geometric input differs (operands, op, size, edges, placement)', () => {
    const base = recipeOf(box('a', '#fff'));
    const keys = [
      base,
      recipeOf(box('a', '#fff', 2)),
      union(box('a', '#fff'), box('b', '#fff', 1)),
      { ...union(box('a', '#fff'), box('b', '#fff', 1)), boolean: 'subtract' as const },
      { op: 'fillet' as const, source: base, edges: [0], size: 1 },
      { op: 'fillet' as const, source: base, edges: [1], size: 1 },
      { op: 'chamfer' as const, source: base, edges: [0], size: 1 },
      { op: 'shell' as const, source: base, thickness: 1 },
      { op: 'scale' as const, source: base, factor: 2 },
      { op: 'place' as const, source: base, position: [1, 0, 0] as const, rotation: [0, 0, 0] as const },
    ].map(recipeKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('is memoized per recipe object and stable across equal objects', () => {
    const recipe = union(box('a', '#fff'), box('b', '#fff', 1));
    expect(recipeKey(recipe)).toBe(recipeKey(recipe));
    expect(recipeKey(recipe)).toBe(recipeKey(JSON.parse(JSON.stringify(recipe)) as ShapeRecipe));
  });
});

describe('recipeOf / meshRecipeOf', () => {
  const tree = union(box('a', '#fff'), box('b', '#fff', 1));
  it('a primitive is a solid leaf', () => {
    expect(recipeOf(box('a', '#fff'))).toEqual({ op: 'solid', entity: box('a', '#fff') });
    expect(meshRecipeOf(box('a', '#fff'))).toBeNull();
  });
  it('a kernel result resumes its construction tree, placed by its own position', () => {
    expect(recipeOf(result(tree))).toBe(tree);
    expect(recipeOf(result(tree, [5, 0, 0]))).toEqual({ op: 'place', source: tree, position: [5, 0, 0], rotation: [0, 0, 0] });
  });
  it('the mesh fallback is the entity triangles without the brep', () => {
    const fallback = meshRecipeOf(result(tree));
    expect(fallback?.op).toBe('solid');
    expect(fallback?.op === 'solid' && 'brep' in fallback.entity).toBe(false);
  });
});

describe('validateShapeRecipe', () => {
  const leaf = recipeOf(box('a', '#fff'));
  it('accepts every well-formed node', () => {
    const recipes: ShapeRecipe[] = [
      leaf,
      { op: 'boolean', boolean: 'intersect', a: leaf, b: leaf },
      { op: 'fillet', source: leaf, edges: [0, 3], size: 0.5 },
      { op: 'chamfer', source: leaf, edges: [], size: 0.5 },
      { op: 'shell', source: leaf, thickness: 0.1 },
      { op: 'place', source: leaf, position: [1, 2, 3], rotation: [0, 0, 1] },
      { op: 'scale', source: leaf, factor: 2 },
    ];
    for (const recipe of recipes) expect(validateShapeRecipe(recipe)).toBeNull();
  });
  it.each([
    ['not an object', 42, /not an object/],
    ['unknown op', { op: 'loft' }, /unknown recipe op 'loft'/],
    ['leaf without entity', { op: 'solid' }, /needs an entity/],
    ['bad boolean', { op: 'boolean', boolean: 'xor', a: leaf, b: leaf }, /unknown boolean 'xor'/],
    ['bad nested operand', { op: 'boolean', boolean: 'union', a: leaf, b: 1 }, /not an object/],
    ['fractional edge', { op: 'fillet', source: leaf, edges: [0.5], size: 1 }, /non-negative integers/],
    ['zero size', { op: 'chamfer', source: leaf, edges: [], size: 0 }, /size must be > 0/],
    ['zero thickness', { op: 'shell', source: leaf, thickness: 0 }, /thickness must be > 0/],
    ['bad placement', { op: 'place', source: leaf, position: [1, 2], rotation: [0, 0, 0] }, /finite Vec3/],
    ['negative scale', { op: 'scale', source: leaf, factor: -1 }, /factor must be > 0/],
  ])('rejects %s', (_label, value, message) => {
    expect(validateShapeRecipe(value)).toMatch(message);
  });
  it.each([
    ['a 2D leaf', { op: 'solid', entity: { kind: 'line' } }, /kind 'line', expected a 3D solid/],
    ['an instance leaf', { op: 'solid', entity: { kind: 'instance' } }, /kind 'instance'/],
    [
      'a mesh leaf with ragged positions',
      { op: 'solid', entity: { kind: 'mesh', mesh: { positions: [0, 0], indices: [] } } },
      /positions must be finite xyz triples/,
    ],
    [
      'a mesh leaf indexing past its vertices',
      { op: 'solid', entity: { kind: 'mesh', mesh: { positions: [0, 0, 0], indices: [0, 1, 2] } } },
      /indices must be integers within the vertex range/,
    ],
  ])('rejects %s', (_label, value, message) => {
    expect(validateShapeRecipe(value)).toMatch(message);
  });
  it('runs the injected leaf validator on every leaf', () => {
    const tree = { op: 'boolean', boolean: 'union', a: leaf, b: leaf };
    expect(validateShapeRecipe(tree, (entity) => (entity['id'] === 'a' ? 'bad leaf a' : null))).toBe('bad leaf a');
  });
  it('rejects a tree nested deeper than the limit', () => {
    let deep: ShapeRecipe = leaf;
    for (let i = 0; i < 300; i++) deep = { op: 'scale', source: deep, factor: 1 };
    expect(validateShapeRecipe(deep)).toMatch(/nested deeper/);
  });
});

/** Native shape of the counting ops: a serial number plus how it was built. */
interface Native {
  readonly serial: number;
  readonly label: string;
}

const TOPOLOGY: ShapeTopology = { solids: 1, faces: [], edges: [], vertices: 0, volume: 1 };

function countingOps(overrides: Partial<KernelOps<Native>> = {}): { ops: KernelOps<Native>; released: number[]; built: string[] } {
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
    blend: (shapes, radius) => make(`blend(${shapes.map((s) => s.label).join('|')},${radius})`),
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

const box2 = (id: string, x = 0): BoxEntity => ({
  id,
  kind: 'box',
  position: [x, 0, 0],
  rotation: [0, 0, 0],
  layerId: 'layer-0',
  color: '#888888',
  size: [1, 1, 1],
});
const leaf = (entity: Entity): ShapeRecipe => ({ op: 'solid', entity });
const union2 = (a: ShapeRecipe, b: ShapeRecipe): ShapeRecipe => ({ op: 'boolean', boolean: 'union', a, b });

describe('kernelFromOps', () => {
  it('walks every recipe node with the native ops', () => {
    const { ops, built } = countingOps();
    const kernel = kernelFromOps(ops);
    const base = union2(leaf(box2('a')), leaf(box2('b', 1)));
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
    kernel.evaluate(union2(leaf(box2('a')), leaf(box2('b', 1))));
    const builds = kernel.buildCount();
    kernel.evaluate(union2(leaf({ ...box2('a'), color: '#ff0000' }), leaf(box2('b', 1))));
    expect(kernel.buildCount()).toBe(builds);
  });
  it('caches a refused recipe and short-circuits everything built on it', () => {
    const { ops, built } = countingOps({ fillet: () => null });
    const kernel = kernelFromOps(ops);
    const refused: ShapeRecipe = { op: 'fillet', source: leaf(box2('a')), edges: [], size: 9 };
    expect(kernel.evaluate(refused)).toBeNull();
    expect(kernel.evaluate(union2(refused, leaf(box2('b'))))).toBeNull();
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
    expect(kernelFromOps(ops).evaluate(leaf(box2('a')))).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
    warn.mockRestore();
  });
  it('lets the kernel rewrite boolean operands before building them', () => {
    const { ops, built } = countingOps({ prepareBoolean: (a, b) => [b, a] });
    kernelFromOps(ops).evaluate(union2(leaf(box2('a')), leaf(box2('b', 1))));
    expect(built.at(-1)).toBe('union(solid:b,solid:a)');
  });
  it('evicts least-recent shapes past capacity and releases each exactly once', () => {
    const { ops, released } = countingOps();
    const kernel = kernelFromOps(ops, 2);
    for (let i = 0; i < 5; i++) kernel.evaluate(leaf(box2(`b${i}`, i)));
    expect(kernel.cachedShapeCount()).toBe(2);
    expect(released).toEqual([1, 2, 3]);
    kernel.clear();
    expect(released.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(kernel.cachedShapeCount()).toBe(0);
  });
  it('defers eviction to the end of the outermost call (tree larger than the cache)', () => {
    const { ops, released, built } = countingOps();
    const kernel = kernelFromOps(ops, 1);
    const left = union2(leaf(box2('a')), leaf(box2('b', 1)));
    const right = union2(leaf(box2('c', 2)), leaf(box2('d', 3)));
    expect(kernel.evaluate(union2(left, right))).not.toBeNull();
    expect(built.at(-1)).toBe('union(union(solid:a,solid:b),union(solid:c,solid:d))');
    expect(kernel.cachedShapeCount()).toBe(1);
    expect(new Set(released).size).toBe(released.length);
    expect(released).toHaveLength(6);
  });
  it('keeps a handle valid after its shape was evicted: it is rebuilt from the recipe', () => {
    const { ops } = countingOps();
    const kernel = kernelFromOps(ops);
    const handle = kernel.evaluate(leaf(box2('a')))!;
    kernel.clear();
    expect(kernel.tessellate(handle)).toBe(TETRA);
    expect(kernel.topology(handle)).toBe(TOPOLOGY);
    expect(kernel.exportStep([handle])).toBe('STEP:solid:a');
  });
  it('memoizes tessellations and reports null outputs for refused handles', () => {
    const tessellate = vi.fn(() => TETRA);
    const { ops } = countingOps({ tessellate });
    const kernel = kernelFromOps(ops);
    const handle = kernel.evaluate(leaf(box2('a')))!;
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
    const { ops } = countingOps({ failureEpoch: () => epoch, solid: (entity) => (healthy ? { serial: 1, label: entity.id } : null) });
    const kernel = kernelFromOps(ops);
    expect(kernel.evaluate(leaf(box2('a')))).toBeNull();
    healthy = true;
    expect(kernel.evaluate(leaf(box2('a')))).toBeNull(); // cached refusal
    epoch++;
    expect(kernel.evaluate(leaf(box2('a')))).not.toBeNull();
  });
  it('reports its capability gaps', () => {
    const kernel = kernelFromOps(countingOps({ unsupported: new Set(['fillet']) }).ops);
    expect(kernel.supports('fillet')).toBe(false);
    expect(kernel.supports('boolean')).toBe(true);
  });
  it('serves key-only handles from the cache and asks for the recipe on a miss', () => {
    const { ops } = countingOps();
    const kernel = kernelFromOps(ops);
    const handle = kernel.evaluate(leaf(box2('a')))!;
    expect(kernel.topology(keyOnlyHandle(handle))).toBe(TOPOLOGY);
    expect(handleOf(leaf(box2('a')))).toEqual(handle);
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
    kernel.evaluate(leaf(box2('a')));
    expect(() => kernel.evaluate(leaf(box2('b', 1)))).not.toThrow();
    expect(() => kernel.clear()).not.toThrow();
  });
});

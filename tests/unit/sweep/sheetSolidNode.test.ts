/** DES-2c: the `sheetSolid` ShapeRecipe node: validation, recipe key, kernels without the op, and a save / load round trip of a recipe holding it. */
import { describe, it, expect } from 'vitest';
import { DEFAULT_LAYER_ID, createEmptyDocument, type MeshSolidEntity, type ShapeRecipe } from '@core/model/types';
import type { SheetSolidRecipe } from '@core/model/sheetSolid';
import { recipeKey, recipeOf, validateShapeRecipe } from '@core/geometry/shapeRecipe';
import { kernelFromOps } from '@core/geometry/shapeKernel';
import { unsupportedOp } from '@core/geometry/operandRecipe';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { TETRA } from '../../helpers/fakeKernel';

/** A clamped bilinear patch (degree 1 x 1, 2 x 2 poles) in the `encodeSurface` layout. */
const patch = (z: number): number[] => [1, 1, 2, 2, 2, 2, 0, 0, 0, z, 0, 1, z, 1, 0, z, 1, 1, z, 0, 1, 2, 2, 0, 1, 2, 2];

const node = (extra: Record<string, unknown> = {}): SheetSolidRecipe =>
  ({
    op: 'sheetSolid',
    faces: [patch(0), patch(1)],
    tolerance: 1e-6,
    caps: 2,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    ...extra,
  }) as SheetSolidRecipe;

const shell = {
  spine: [0, 0, 0, 0, 0, 0, 2],
  circle: { center: [0, 0, 0], normal: [0, 0, 1], radius: 1 },
  mode: 0,
  direction: [0, 0, 1],
  transition: 0,
  tolerance: 1e-6,
  probes: [1, 0, 1],
  check: 1e-6,
};

describe('sheetSolid recipe node', () => {
  it('validates a well-formed node, with a bore, a name and a pipe-shell attempt', () => {
    expect(validateShapeRecipe(node())).toBeNull();
    expect(validateShapeRecipe(node({ bore: [patch(0)], name: 'sweep-1.1', pipeShell: shell, caps: 0 }))).toBeNull();
    expect(validateShapeRecipe({ op: 'boolean', boolean: 'subtract', a: node(), b: recipeOf({ ...fixtureBox() }) })).toBeNull();
  });
  it.each<[string, Record<string, unknown>, string]>([
    ['no faces', { faces: [] }, 'faces must be a non-empty list'],
    ['a face that is not numbers', { faces: [['x']] }, 'faces surface'],
    ['a face with a broken layout', { faces: [[1, 2, 3]] }, 'faces surface'],
    ['a bad bore', { bore: [] }, 'bore must be a non-empty list'],
    ['a zero tolerance', { tolerance: 0 }, 'tolerance must be > 0'],
    ['caps outside 0..2', { caps: 3 }, 'caps must be 0, 1 or 2'],
    ['a bad position', { position: [0, 0] }, 'position and rotation'],
    ['a non-string name', { name: 4 }, 'name must be a string'],
    ['a pipeShell that is not an object', { pipeShell: 3 }, 'pipeShell must be an object'],
    ['a pipeShell spine of strings', { pipeShell: { ...shell, spine: ['a'] } }, 'spine and probes'],
    ['a pipeShell chain of strings', { pipeShell: { ...shell, chain: ['a'] } }, 'chain must be a list'],
    ['a pipeShell law of strings', { pipeShell: { ...shell, law: ['a'] } }, 'law must be a list'],
    ['a fractional pipeShell mode', { pipeShell: { ...shell, mode: 0.5 } }, 'mode and transition'],
    ['a bad pipeShell direction', { pipeShell: { ...shell, direction: [0, 0] } }, 'direction must be a finite Vec3'],
    ['a zero pipeShell check', { pipeShell: { ...shell, check: 0 } }, 'tolerance and check'],
  ])('refuses %s', (_label, extra, message) => {
    expect(validateShapeRecipe(node(extra))).toContain(message);
  });
  it('has a recipe key that follows every input a kernel reads, and is stable across equal copies', () => {
    const base = node();
    const keys = [
      base,
      node({ faces: [patch(0), patch(2)] }),
      node({ bore: [patch(0)] }),
      node({ tolerance: 1e-5 }),
      node({ caps: 0 }),
      node({ position: [1, 0, 0] }),
      node({ rotation: [0, 0, 1] }),
      node({ name: 'a' }),
      node({ pipeShell: shell }),
    ].map(recipeKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(recipeKey(base)).toBe(recipeKey(JSON.parse(JSON.stringify(base)) as ShapeRecipe));
  });
  it('is unsupported by an in-process kernel (no op), which evaluates it to null instead of a wrong mesh', () => {
    const kernel = kernelFromOps<{ mesh: typeof TETRA }>({
      name: 'mesh',
      unsupported: new Set(['sheetSolid']),
      solid: () => ({ mesh: TETRA }),
      boolean: () => null,
      fillet: () => null,
      blend: () => null,
      chamfer: () => null,
      shell: () => null,
      place: (shape) => shape,
      scale: (shape) => shape,
      tessellate: (shape) => shape.mesh,
      topology: () => null,
      exportStep: () => null,
      release: () => undefined,
    });
    expect(kernel.supports('sheetSolid')).toBe(false);
    expect(unsupportedOp(kernel, node())).toBe('sheetSolid');
    expect(kernel.evaluate(node())).toBeNull();
  });
  it('round-trips through save and load inside the stored recipe of a kernel result, and a tampered node is refused on load', () => {
    const recipe: ShapeRecipe = {
      op: 'boolean',
      boolean: 'union',
      a: node({ bore: [patch(0)], name: 'sweep-1.1' }),
      b: recipeOf(fixtureBox()),
    };
    const result: MeshSolidEntity = {
      id: 'mesh-1',
      kind: 'mesh',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      layerId: DEFAULT_LAYER_ID,
      color: '#888888',
      mesh: TETRA,
      brep: recipe,
    };
    const doc = { ...createEmptyDocument(), entities: { 'mesh-1': result }, order: ['mesh-1'] };
    const loaded = deserializeDocument(serializeDocument(doc));
    const stored = (loaded.entities['mesh-1'] as MeshSolidEntity).brep as ShapeRecipe;
    expect(stored).toEqual(recipe);
    expect(recipeKey(stored)).toBe(recipeKey(recipe));
    const json = JSON.parse(serializeDocument(doc)) as { document: { entities: Record<string, { brep: { a: { caps: number } } }> } };
    (json.document.entities['mesh-1'] as { brep: { a: { caps: number } } }).brep.a.caps = 7;
    expect(() => deserializeDocument(JSON.stringify(json))).toThrow(/caps must be 0, 1 or 2/);
  });
});

function fixtureBox(): Parameters<typeof recipeOf>[0] {
  return { id: 'b', kind: 'box', position: [0, 0, 0], rotation: [0, 0, 0], layerId: DEFAULT_LAYER_ID, color: '#ffffff', size: [1, 1, 1] };
}

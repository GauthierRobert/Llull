import { describe, it, expect, vi } from 'vitest';
import type { BoxEntity, CadDocument, DocumentBlob, MeshSolidEntity, ShapeRecipe } from '@core/model/types';
import { createEmptyDocument } from '@core/model/types';
import { meshRecipeOf, recipeKey, recipeOf } from '@core/geometry/shapeRecipe';
import { localBounds } from '@core/geometry/bounds';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { GeometryKernel } from '@core/geometry/kernel';
import { TETRA } from '../helpers/fakeKernel';

const box: BoxEntity = {
  id: 'b',
  kind: 'box',
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  layerId: 'layer-0',
  color: '#fff',
  size: [1, 1, 1],
};
const brep: ShapeRecipe = { op: 'solid', entity: box };
const imported: MeshSolidEntity = {
  id: 'm',
  kind: 'mesh',
  position: [1, 0, 0],
  rotation: [0, 0, 0],
  layerId: 'layer-0',
  color: '#888',
  mesh: TETRA,
  brep,
};

describe('recipe identity memo', () => {
  it('returns one recipe object per entity object (so the recipeKey memo hits)', () => {
    expect(recipeOf(box)).toBe(recipeOf(box));
    expect(recipeOf(imported)).toBe(recipeOf(imported));
    expect(meshRecipeOf(imported)).toBe(meshRecipeOf(imported));
    expect(recipeKey(recipeOf(imported))).toBe(recipeKey(recipeOf({ ...imported })));
  });
  it('keeps the recipe contents unchanged', () => {
    expect(recipeOf(box)).toEqual({ op: 'solid', entity: box });
    expect(recipeOf(imported)).toEqual({ op: 'place', source: brep, position: [1, 0, 0], rotation: [0, 0, 0] });
    const plain = meshRecipeOf(imported);
    expect(plain).toEqual({ op: 'solid', entity: { ...imported, brep: undefined } });
    expect(plain?.op === 'solid' && 'brep' in plain.entity).toBe(false);
    expect(meshRecipeOf(box)).toBeNull();
  });
});

describe('local bounds memo', () => {
  it('computes mesh bounds once per entity and gives the same extent', () => {
    const first = localBounds(imported);
    expect(localBounds(imported)).toBe(first);
    expect(first).toEqual({ min: [0, 0, 0], max: [1, 1, 1] });
  });
});

describe('constraint solver entity identity', () => {
  it('keeps unmoved entities and moves constrained ones', () => {
    let doc = createEmptyDocument();
    const ids: string[] = [];
    for (const x of [0, 5, 20]) {
      const r = execute(doc, 'add_box', { size: [1, 1, 1], position: [x, 0, 0] });
      doc = r.document;
      ids.push(r.affected[0] as string);
    }
    const [a, b, free] = ids as [string, string, string];
    doc = execute(doc, 'add_constraint', { constraint: { kind: 'coincident', a: { entityId: a }, b: { entityId: b } } }).document;
    const solved = execute(doc, 'solve_constraints', {});
    expect(solved.document.entities[free]).toBe(doc.entities[free]);
    expect(solved.document.entities[a]).not.toBe(doc.entities[a]);
    expect(solved.document.entities[a]?.position).not.toEqual(doc.entities[a]?.position);
  });
});

describe('blob feeding memo', () => {
  it('walks an unchanged blob table once per kernel', () => {
    const loadBlob = vi.fn();
    const kernel = { ...defaultContext().kernel, loadBlob } as unknown as GeometryKernel;
    const ctx = { ...defaultContext(), kernel };
    const blob: DocumentBlob = { sha256: 'abc', mediaType: 'model/step', bytes: '', size: 0 };
    let walks = 0;
    const blobs = new Proxy({ abc: blob }, { ownKeys: (target) => (walks++, Reflect.ownKeys(target)) });
    const doc: CadDocument = { ...createEmptyDocument(), blobs };
    execute(doc, 'check_model', {}, ctx);
    execute(doc, 'check_model', {}, ctx);
    expect(walks).toBe(1);
  });
});

/** Shape recipes: content keys, entity -> recipe, mesh fallback, validation of untrusted trees. */
import { describe, it, expect } from 'vitest';
import type { BoxEntity, Entity, MeshSolidEntity } from '@core/model/types';
import type { ShapeRecipe } from '@core/geometry/shapeRecipe';
import {
  geometryKey,
  meshRecipeOf,
  recipeKey,
  recipeOf,
  validateShapeRecipe,
} from '@core/geometry/shapeRecipe';
import { TETRA } from '../../helpers/fakeKernel';

function box(id: string, color: string, x = 0): BoxEntity {
  return {
    id,
    kind: 'box',
    position: [x, 0, 0],
    rotation: [0, 0, 0],
    layerId: 'layer-0',
    color,
    size: [1, 1, 1],
  };
}

const union = (a: Entity, b: Entity): ShapeRecipe => ({
  op: 'boolean',
  boolean: 'union',
  a: recipeOf(a),
  b: recipeOf(b),
});

function result(
  brep: ShapeRecipe,
  position: [number, number, number] = [0, 0, 0],
): MeshSolidEntity {
  return {
    id: 'mesh-1',
    kind: 'mesh',
    position,
    rotation: [0, 0, 0],
    layerId: 'layer-0',
    color: '#888888',
    mesh: TETRA,
    brep,
  };
}

describe('recipeKey', () => {
  it('ignores presentation fields (id, name, color, layer, tags, material)', () => {
    const recolored = { ...box('b', '#000000'), name: 'n', tags: ['t'], materialId: 'm' };
    expect(geometryKey(box('a', '#ffffff'))).toBe(geometryKey(recolored));
    expect(recipeKey(union(box('a', '#fff'), box('b', '#fff', 1)))).toBe(
      recipeKey(union(box('x', '#000', 0), box('y', '#123', 1))),
    );
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
      {
        op: 'place' as const,
        source: base,
        position: [1, 0, 0] as const,
        rotation: [0, 0, 0] as const,
      },
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
    expect(recipeOf(result(tree, [5, 0, 0]))).toEqual({
      op: 'place',
      source: tree,
      position: [5, 0, 0],
      rotation: [0, 0, 0],
    });
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
    [
      'fractional edge',
      { op: 'fillet', source: leaf, edges: [0.5], size: 1 },
      /non-negative integers/,
    ],
    ['zero size', { op: 'chamfer', source: leaf, edges: [], size: 0 }, /size must be > 0/],
    ['zero thickness', { op: 'shell', source: leaf, thickness: 0 }, /thickness must be > 0/],
    [
      'bad placement',
      { op: 'place', source: leaf, position: [1, 2], rotation: [0, 0, 0] },
      /finite Vec3/,
    ],
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
    expect(
      validateShapeRecipe(tree, (entity) => (entity['id'] === 'a' ? 'bad leaf a' : null)),
    ).toBe('bad leaf a');
  });

  it('rejects a tree nested deeper than the limit', () => {
    let deep: ShapeRecipe = leaf;
    for (let i = 0; i < 300; i++) deep = { op: 'scale', source: deep, factor: 1 };
    expect(validateShapeRecipe(deep)).toMatch(/nested deeper/);
  });
});

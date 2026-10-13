import { describe, it, expect, afterEach } from 'vitest';
import { type CadDocument, type MeshSolidEntity, type MeshData, type ShapeRecipe, createEmptyDocument } from '@core/model/types';
import { execute, getCommand } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { recipeKey, validateShapeRecipe } from '@core/geometry/shapeRecipe';
import { fakeKernel } from '../helpers/fakeKernel';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';

const BLEND_MESH: MeshData = { positions: [0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0], indices: [0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3] };

function frame(): { doc: CadDocument; ids: string[] } {
  const result = execute(createEmptyDocument(), 'build_project', {
    actions: [
      { command: 'add_cylinder', params: { radius: 1, height: 10, color: '#112233' } },
      { command: 'add_cylinder', params: { radius: 0.7, height: 10, rotation: [0, Math.PI / 2, 0] } },
      { command: 'add_box', params: { size: [1, 1, 1], position: [0, 0, 5] } },
      { command: 'draw_arc', params: { center: [0, 0], radius: 1 } },
    ],
  });
  return { doc: result.document, ids: result.document.order };
}

describe('blend_union', () => {
  afterEach(() => setGeometryKernel(null));
  it('is registered and requires a kernel', () => {
    expect(getCommand('blend_union')?.annotations?.requiresKernel).toBe(true);
  });
  it('welds the solids into one mesh whose recipe blends their exact shapes', () => {
    const fake = fakeKernel({ blend: BLEND_MESH });
    setGeometryKernel(fake);
    const { doc, ids } = frame();
    const solids = ids.slice(0, 3);
    const result = execute(doc, 'blend_union', { ids: solids, radius: 0.2 });
    expect(result.affected).toHaveLength(1);
    const piece = result.document.entities[result.affected[0] as string] as MeshSolidEntity;
    expect(piece.kind).toBe('mesh');
    expect(piece.color).toBe('#112233');
    expect(piece.brep).toMatchObject({ op: 'blend', radius: 0.2 });
    expect((piece.brep as Extract<ShapeRecipe, { op: 'blend' }>).sources).toHaveLength(3);
    for (const id of solids) expect(result.document.entities[id]).toBeUndefined();
    expect(fake.calls.filter((call) => call.op === 'blend')[0]?.operands).toHaveLength(3);
    expect(result.summary).toContain('welded 3 solids');
    expect(result.summary).toContain('radius 0.2;');
  });
  it('is pure', () => {
    setGeometryKernel(fakeKernel({ blend: BLEND_MESH }));
    const { doc, ids } = frame();
    expectPure(doc, () => execute(doc, 'blend_union', { ids: ids.slice(0, 2), radius: 0.3 }));
  });
  it.each([
    ['one solid', (ids: string[]) => ({ ids: ids.slice(0, 1), radius: 1 }), 'needs 2..200'],
    ['duplicates', (ids: string[]) => ({ ids: [ids[0], ids[0]], radius: 1 }), 'distinct'],
    ['bad radius', (ids: string[]) => ({ ids: ids.slice(0, 2), radius: 0 }), 'radius must be > 0'],
    ['missing', (ids: string[]) => ({ ids: [ids[0], 'nope'], radius: 1 }), "'nope' not found"],
    ['2D operand', (ids: string[]) => ({ ids: [ids[0], ids[3]], radius: 1 }), '2D shape'],
  ])('%s → no-op', (_label, params, text) => {
    setGeometryKernel(fakeKernel({ blend: BLEND_MESH }));
    const { doc, ids } = frame();
    expectNoOp(execute(doc, 'blend_union', params(ids)), doc, text);
  });
  it('refuses instances, a missing kernel, a kernel without blends and a kernel refusal', () => {
    const { doc, ids } = frame();
    const two = { ids: ids.slice(0, 2), radius: 0.2 };
    expectNoOp(execute(doc, 'blend_union', two), doc, 'kernel');
    setGeometryKernel(fakeKernel({ blend: BLEND_MESH, unsupported: ['blend'] }));
    expectNoOp(execute(doc, 'blend_union', two), doc, 'cannot fillet joints');
    setGeometryKernel(fakeKernel({ blend: null }));
    expectNoOp(execute(doc, 'blend_union', two), doc, 'try another radius');
    setGeometryKernel(fakeKernel({ blend: { positions: [], indices: [] } }));
    expectNoOp(execute(doc, 'blend_union', two), doc, 'empty');
    const withInstance = execute(doc, 'build_project', {
      actions: [
        { command: 'create_component', params: { name: 'C', componentId: 'c', entityIds: [ids[2]] } },
        { command: 'insert_instance', params: { componentId: 'c' } },
      ],
    }).document;
    const instance = Object.values(withInstance.entities).find((e) => e.kind === 'instance');
    setGeometryKernel(fakeKernel({ blend: BLEND_MESH }));
    expectNoOp(execute(withInstance, 'blend_union', { ids: [ids[0], instance?.id], radius: 0.2 }), withInstance, 'explode_instance');
  });
});

describe('variable-radius fillet_edge', () => {
  afterEach(() => setGeometryKernel(null));
  it('stores sizeEnd in the fillet recipe', () => {
    setGeometryKernel(fakeKernel({ fillet: BLEND_MESH }));
    const created = execute(createEmptyDocument(), 'add_box', { size: [4, 4, 4] });
    const result = execute(created.document, 'fillet_edge', { id: created.affected[0], edgeIndices: [0], radius: 0.2, radiusEnd: 0.8 });
    const piece = result.document.entities[result.affected[0] as string] as MeshSolidEntity;
    expect(piece.brep).toMatchObject({ op: 'fillet', size: 0.2, sizeEnd: 0.8 });
  });
  it('refuses a non-positive radiusEnd', () => {
    setGeometryKernel(fakeKernel({ fillet: BLEND_MESH }));
    const created = execute(createEmptyDocument(), 'add_box', { size: [4, 4, 4] });
    expectNoOp(
      execute(created.document, 'fillet_edge', { id: created.affected[0], radius: 1, radiusEnd: 0 }),
      created.document,
      'radiusEnd must be > 0',
    );
  });
});

describe('blend recipes', () => {
  const leaf = (id: string): ShapeRecipe => ({
    op: 'solid',
    entity: { id, kind: 'box', size: [1, 1, 1], position: [0, 0, 0], rotation: [0, 0, 0], layerId: 'layer-default', color: '#888888' },
  });
  it('keys distinguish radii and validation checks every field', () => {
    const blend: ShapeRecipe = { op: 'blend', sources: [leaf('a'), leaf('b')], radius: 1 };
    expect(recipeKey(blend)).not.toBe(recipeKey({ ...blend, radius: 2 }));
    const fillet: ShapeRecipe = { op: 'fillet', source: leaf('a'), edges: [], size: 1 };
    expect(recipeKey(fillet)).not.toBe(recipeKey({ ...fillet, sizeEnd: 2 }));
    expect(validateShapeRecipe(blend)).toBeNull();
    expect(validateShapeRecipe({ ...blend, sources: [leaf('a')] })).toContain('>= 2 sources');
    expect(validateShapeRecipe({ ...blend, radius: 0 })).toContain('radius must be > 0');
    expect(validateShapeRecipe({ ...blend, sources: [leaf('a'), { op: 'nope' } as never] })).toContain('unknown recipe op');
    expect(validateShapeRecipe({ ...fillet, sizeEnd: 0 })).toContain('sizeEnd must be > 0');
  });
});

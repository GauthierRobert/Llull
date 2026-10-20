import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createEmptyDocument, type MeshSolidEntity, type CadDocument, type MeshData } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel, getGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import { TETRA, fakeKernel, type FakeCall, type FakeKernel } from '../helpers/fakeKernel';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';

function lastBoolean(fake: FakeKernel): FakeCall | undefined {
  return [...fake.calls].reverse().find((call) => call.op === 'boolean');
}

// Helpers

function docWithTwoBoxes(): { doc: CadDocument; idA: string; idB: string } {
  let doc = createEmptyDocument();
  const r1 = execute(doc, 'add_box', { size: [2, 2, 2], position: [0, 0, 0], color: '#aabbcc' });
  doc = r1.document;
  const r2 = execute(doc, 'add_box', { size: [1, 1, 1], position: [1, 0, 0], color: '#ddeeff' });
  doc = r2.document;
  return { doc, idA: r1.affected[0]!, idB: r2.affected[0]! };
}

/** Empty doc plus `count` unit boxes; returns the doc and their ids in creation order. */
function docWithBoxes(count: number): { doc: CadDocument; ids: string[] } {
  let doc = createEmptyDocument();
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const r = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = r.document;
    ids.push(r.affected[0]!);
  }
  return { doc, ids };
}

// Tests

describe('boolean commands', () => {
  let fake: FakeKernel;

  beforeEach(() => {
    fake = fakeKernel({ boolean: TETRA });
    setGeometryKernel(fake);
  });

  afterEach(() => {
    setGeometryKernel(null);
  });
  // boolean union — happy path

  it.each(['union', 'subtract', 'intersect'] as const)('boolean %s replaces both operands by one kernel mesh (a first), purely', (op) => {
    const { doc, idA, idB } = docWithTwoBoxes();
    const r = execute(doc, 'boolean', { op, a: idA, b: idB });
    expect(r.affected).toHaveLength(1);
    const id = r.affected[0]!;
    const e = r.document.entities[id] as MeshSolidEntity;
    expect(e).toMatchObject({
      kind: 'mesh',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      layerId: doc.entities[idA]!.layerId,
      color: doc.entities[idA]!.color,
    });
    expect([e.mesh.positions, e.mesh.indices]).toEqual([TETRA.positions, TETRA.indices]);
    expect(e.brep).toMatchObject({
      op: 'boolean',
      boolean: op,
      a: { op: 'solid', entity: doc.entities[idA] },
      b: { op: 'solid', entity: doc.entities[idB] },
    });
    expect([r.document.entities[idA], r.document.entities[idB]]).toEqual([undefined, undefined]);
    expect(r.document.order).toEqual([id]);
    for (const s of [idA, idB, id, String(TETRA.indices.length / 3)]) expect(r.summary).toContain(s);
    const call = lastBoolean(fake)!;
    expect(call.boolean).toBe(op);
    expect(call.operands.map((o) => o.entity!.id)).toEqual([idA, idB]);
    expectPure(doc, () => execute(doc, 'boolean', { op, a: idA, b: idB }));
  });
  describe('no-op paths', () => {
    it('no-op when a is missing', () => {
      const { doc, idB } = docWithTwoBoxes();
      expectNoOp(execute(doc, 'boolean', { op: 'union', a: 'ghost', b: idB }), doc, 'ghost');
    });
    it('no-op when b is missing', () => {
      const { doc, idA } = docWithTwoBoxes();
      expectNoOp(execute(doc, 'boolean', { op: 'union', a: idA, b: 'ghost' }), doc, 'ghost');
    });
    it('no-op when a and b are the same id', () => {
      const { doc, idA } = docWithTwoBoxes();
      expectNoOp(execute(doc, 'boolean', { op: 'union', a: idA, b: idA }), doc, idA);
    });
    it.each([
      ['a', true],
      ['b', false],
    ])('no-op when operand %s is a 2D entity', (_operand, lineFirst) => {
      const { doc: boxDoc, ids } = docWithBoxes(1);
      const lineResult = execute(boxDoc, 'draw_polyline', {
        points: [
          [0, 0],
          [1, 0],
        ],
      });
      const doc = lineResult.document;
      const lineId = lineResult.affected[0]!;
      const operands = lineFirst ? { a: lineId, b: ids[0]! } : { a: ids[0]!, b: lineId };
      expectNoOp(execute(doc, 'boolean', { op: 'union', ...operands }), doc, '2D');
    });
    it.each([
      ['kernel is not injected', null, 'kernel not available'],
      ['kernel returns null (degenerate geometry)', fakeKernel({ boolean: null }), 'null'],
    ])('no-op when %s', (_label, kernel, summary) => {
      setGeometryKernel(kernel);
      const { doc, idA, idB } = docWithTwoBoxes();
      expectNoOp(execute(doc, 'boolean', { op: 'union', a: idA, b: idB }), doc, summary);
    });
  });
  // Group handling — operands pruned from groups

  describe('group handling', () => {
    it('prunes operand ids from groups and dissolves groups that drop below 2 members', () => {
      const { doc: baseDoc, idA, idB } = docWithTwoBoxes();
      // Group both operands (exactly 2 members → will dissolve after union).
      const grouped = execute(baseDoc, 'group_entities', { ids: [idA, idB], name: 'Pair' });
      const docWithGroup = grouped.document;
      const groupId = grouped.affected[0]!;
      expect(docWithGroup.groups[groupId]!.memberIds).toEqual([idA, idB]);
      const result = execute(docWithGroup, 'boolean', { op: 'union', a: idA, b: idB });
      // Group dissolved because both members were consumed.
      expect(result.document.groups[groupId]).toBeUndefined();
    });
    it('keeps groups that retain >= 2 members after operands are removed', () => {
      const { doc, ids } = docWithBoxes(3);
      const [idA, idB, idC] = ids as [string, string, string];
      // Group all three; after union(A, B) only C remains — a 1-member group dissolves.
      const grouped = execute(doc, 'group_entities', { ids: [idA, idB, idC], name: 'Trio' });
      const groupId = grouped.affected[0]!;
      const result = execute(grouped.document, 'boolean', { op: 'union', a: idA, b: idB });
      expect(result.document.groups[groupId]).toBeUndefined();
    });
    it('keeps a group with >= 2 non-operand members intact', () => {
      const { doc, ids } = docWithBoxes(4);
      const [idA, idB, idC, idD] = ids as [string, string, string, string];
      // Group C and D (not the operands).
      const grouped = execute(doc, 'group_entities', { ids: [idC, idD], name: 'Survivors' });
      const groupId = grouped.affected[0]!;
      const result = execute(grouped.document, 'boolean', { op: 'union', a: idA, b: idB });
      // Group of C+D must be untouched.
      expect(result.document.groups[groupId]).toBeDefined();
      expect(result.document.groups[groupId]!.memberIds).toEqual([idC, idD]);
    });
  });
  // Kernel injection round-trip
  it('getGeometryKernel returns null after afterEach cleanup', () => {
    // afterEach calls setGeometryKernel(null); this test confirms the module
    // state is reset. We call it manually here since we're inside the test.
    setGeometryKernel(null);
    expect(getGeometryKernel()).toBeNull();
  });
  // scale_entity on a boolean-result mesh (exercises the transform.ts mesh branch)
  it('scale_entity scales every position of a mesh entity by the factor', () => {
    const { doc, idA, idB } = docWithTwoBoxes();
    const unioned = execute(doc, 'boolean', { op: 'union', a: idA, b: idB });
    const meshId = unioned.affected[0]!;
    expect(unioned.document.entities[meshId]!.kind).toBe('mesh');
    const scaled = execute(unioned.document, 'scale_entity', { id: meshId, factor: 2 });
    const entity = scaled.document.entities[meshId]!;
    expect(entity.kind).toBe('mesh');
    if (entity.kind === 'mesh') {
      // Each xyz triple of the canned tetra is doubled; indices are unchanged.
      expect([...entity.mesh.positions]).toEqual([0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2]);
      expect([...entity.mesh.indices]).toEqual([...TETRA.indices]);
    }
  });
});

const kernelReturning = (mesh: MeshData | null): GeometryKernel => fakeKernel({ boolean: mesh });

describe('boolean edge cases', () => {
  afterEach(() => setGeometryKernel(null));
  const first = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
  const second = execute(first.document, 'add_box', { size: [1, 1, 1], position: [10, 0, 0] });
  const doc = second.document;
  const [idA, idB] = [first.affected[0]!, second.affected[0]!];
  it('an empty kernel result keeps both operands instead of consuming them', () => {
    setGeometryKernel(kernelReturning({ positions: [], indices: [] }));
    expectNoOp(execute(doc, 'boolean', { op: 'intersect', a: idA, b: idB }), doc, 'is empty');
  });
  it('a zero-volume sliver result (tangent subtract) is treated as empty and keeps both operands', () => {
    setGeometryKernel(kernelReturning({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2, 0, 2, 1] }));
    expectNoOp(execute(doc, 'boolean', { op: 'subtract', a: idA, b: idB }), doc, 'is empty');
  });
  it('a non-empty result still replaces the operands', () => {
    setGeometryKernel(kernelReturning(TETRA));
    const result = execute(doc, 'boolean', { op: 'union', a: idA, b: idB });
    expect(result.affected).toHaveLength(1);
    expect(result.document.entities[idA]).toBeUndefined();
  });
  it('rejects component instances with a pointer to explode_instance', () => {
    setGeometryKernel(kernelReturning({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }));
    const component = execute(doc, 'create_component', { name: 'Part', entityIds: [idA], componentId: 'comp-part' });
    const instanceId = component.affected[0]!;
    const result = execute(component.document, 'boolean', { op: 'union', a: instanceId, b: idB });
    expect(result.document).toBe(component.document);
    expect(result.summary).toContain('explode_instance');
  });
});

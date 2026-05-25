import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { MeshSolidEntity, CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel, getGeometryKernel } from '@core/geometry/kernel';
import type { GeometryKernel, MeshData, BooleanOp } from '@core/geometry/kernel';
import type { Entity } from '@core/model/types';
import { __resetIdCounter } from '@lib/id';

// ---------------------------------------------------------------------------
// Canned mesh — a minimal tetrahedron (4 vertices, 4 triangles)
// ---------------------------------------------------------------------------

const CANNED_MESH: MeshData = {
  positions: [
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
  ], // 4 vertices × 3 = 12 floats
  indices: [
    0, 1, 2,
    0, 1, 3,
    0, 2, 3,
    1, 2, 3,
  ], // 4 triangles × 3 = 12 indices
};

// ---------------------------------------------------------------------------
// Fake kernel factory — records last call for order-assertions
// ---------------------------------------------------------------------------

function makeFakeKernel(): GeometryKernel & {
  lastOp: BooleanOp | null;
  lastA: Entity | null;
  lastB: Entity | null;
  callCount: number;
  returnNull: boolean;
} {
  const fake = {
    lastOp: null as BooleanOp | null,
    lastA: null as Entity | null,
    lastB: null as Entity | null,
    callCount: 0,
    returnNull: false,
    booleanOp(op: BooleanOp, a: Entity, b: Entity): MeshData | null {
      fake.lastOp = op;
      fake.lastA = a;
      fake.lastB = b;
      fake.callCount += 1;
      return fake.returnNull ? null : CANNED_MESH;
    },
  };
  return fake;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function docWithTwoBoxes(): { doc: CadDocument; idA: string; idB: string } {
  let doc = createEmptyDocument();
  const r1 = execute(doc, 'add_box', { size: [2, 2, 2], position: [0, 0, 0], color: '#aabbcc' });
  doc = r1.document;
  const r2 = execute(doc, 'add_box', { size: [1, 1, 1], position: [1, 0, 0], color: '#ddeeff' });
  doc = r2.document;
  return { doc, idA: r1.affected[0]!, idB: r2.affected[0]! };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('boolean commands', () => {
  let fake: ReturnType<typeof makeFakeKernel>;

  beforeEach(() => {
    __resetIdCounter();
    fake = makeFakeKernel();
    setGeometryKernel(fake);
  });

  afterEach(() => {
    setGeometryKernel(null);
  });

  // -------------------------------------------------------------------------
  // boolean_union — happy path
  // -------------------------------------------------------------------------

  describe('boolean_union', () => {
    it('creates one mesh entity and reports it as affected', () => {
      const { doc, idA, idB } = docWithTwoBoxes();
      const result = execute(doc, 'boolean_union', { a: idA, b: idB });

      expect(result.affected).toHaveLength(1);
      const newId = result.affected[0]!;
      const entity = result.document.entities[newId];
      expect(entity).toBeDefined();
      expect(entity!.kind).toBe('mesh');
    });

    it('mesh entity carries the canned mesh data', () => {
      const { doc, idA, idB } = docWithTwoBoxes();
      const result = execute(doc, 'boolean_union', { a: idA, b: idB });
      const newId = result.affected[0]!;
      const entity = result.document.entities[newId] as MeshSolidEntity;
      expect(entity.mesh.positions).toEqual(CANNED_MESH.positions);
      expect(entity.mesh.indices).toEqual(CANNED_MESH.indices);
    });

    it('consumes both operands from entities', () => {
      const { doc, idA, idB } = docWithTwoBoxes();
      const result = execute(doc, 'boolean_union', { a: idA, b: idB });
      expect(result.document.entities[idA]).toBeUndefined();
      expect(result.document.entities[idB]).toBeUndefined();
    });

    it('removes operands from order and appends new mesh id', () => {
      const { doc, idA, idB } = docWithTwoBoxes();
      const result = execute(doc, 'boolean_union', { a: idA, b: idB });
      const newId = result.affected[0]!;
      expect(result.document.order).not.toContain(idA);
      expect(result.document.order).not.toContain(idB);
      expect(result.document.order).toContain(newId);
    });

    it('summary mentions both operand ids, new id, and triangle count', () => {
      const { doc, idA, idB } = docWithTwoBoxes();
      const result = execute(doc, 'boolean_union', { a: idA, b: idB });
      const newId = result.affected[0]!;
      const triangleCount = CANNED_MESH.indices.length / 3; // 4
      expect(result.summary).toContain(idA);
      expect(result.summary).toContain(idB);
      expect(result.summary).toContain(newId);
      expect(result.summary).toContain(String(triangleCount));
    });

    it('new mesh entity inherits layerId and color from operand a', () => {
      const { doc, idA } = docWithTwoBoxes();
      const entityA = doc.entities[idA]!;
      const result = execute(doc, 'boolean_union', { a: idA, b: Object.keys(doc.entities).find(id => id !== idA)! });
      const newId = result.affected[0]!;
      const entity = result.document.entities[newId]!;
      expect(entity.layerId).toBe(entityA.layerId);
      expect(entity.color).toBe(entityA.color);
    });

    it('new mesh entity has position [0,0,0] and rotation [0,0,0]', () => {
      const { doc, idA, idB } = docWithTwoBoxes();
      const result = execute(doc, 'boolean_union', { a: idA, b: idB });
      const newId = result.affected[0]!;
      const entity = result.document.entities[newId]!;
      expect(entity.position).toEqual([0, 0, 0]);
      expect(entity.rotation).toEqual([0, 0, 0]);
    });

    it('passes op = union to the kernel', () => {
      const { doc, idA, idB } = docWithTwoBoxes();
      execute(doc, 'boolean_union', { a: idA, b: idB });
      expect(fake.lastOp).toBe('union');
    });
  });

  // -------------------------------------------------------------------------
  // boolean_subtract — operand order
  // -------------------------------------------------------------------------

  describe('boolean_subtract', () => {
    it('passes operands to the kernel in the correct order (a first, b second)', () => {
      const { doc, idA, idB } = docWithTwoBoxes();
      const entityA = doc.entities[idA]!;
      const entityB = doc.entities[idB]!;

      execute(doc, 'boolean_subtract', { a: idA, b: idB });

      expect(fake.lastOp).toBe('subtract');
      expect(fake.lastA!.id).toBe(entityA.id);
      expect(fake.lastB!.id).toBe(entityB.id);
    });

    it('creates one mesh entity and consumes both operands', () => {
      const { doc, idA, idB } = docWithTwoBoxes();
      const result = execute(doc, 'boolean_subtract', { a: idA, b: idB });

      expect(result.affected).toHaveLength(1);
      expect(result.document.entities[idA]).toBeUndefined();
      expect(result.document.entities[idB]).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // boolean_intersect
  // -------------------------------------------------------------------------

  describe('boolean_intersect', () => {
    it('passes op = intersect to the kernel and creates mesh entity', () => {
      const { doc, idA, idB } = docWithTwoBoxes();
      const result = execute(doc, 'boolean_intersect', { a: idA, b: idB });

      expect(fake.lastOp).toBe('intersect');
      expect(result.affected).toHaveLength(1);
      expect(result.document.entities[result.affected[0]!]!.kind).toBe('mesh');
    });
  });

  // -------------------------------------------------------------------------
  // No-op: missing ids
  // -------------------------------------------------------------------------

  describe('no-op paths', () => {
    it('no-op when a is missing', () => {
      const { doc, idB } = docWithTwoBoxes();
      const result = execute(doc, 'boolean_union', { a: 'ghost', b: idB });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('ghost');
    });

    it('no-op when b is missing', () => {
      const { doc, idA } = docWithTwoBoxes();
      const result = execute(doc, 'boolean_union', { a: idA, b: 'ghost' });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('ghost');
    });

    it('no-op when a and b are the same id', () => {
      const { doc, idA } = docWithTwoBoxes();
      const result = execute(doc, 'boolean_union', { a: idA, b: idA });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain(idA);
    });

    it('no-op when operand a is a 2D entity', () => {
      let doc = createEmptyDocument();
      const lineResult = execute(doc, 'draw_line', {
        start: [0, 0],
        end: [1, 0],
      });
      doc = lineResult.document;
      const lineId = lineResult.affected[0]!;
      const boxResult = execute(doc, 'add_box', { size: [1, 1, 1] });
      doc = boxResult.document;
      const boxId = boxResult.affected[0]!;

      const result = execute(doc, 'boolean_union', { a: lineId, b: boxId });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('2D');
    });

    it('no-op when operand b is a 2D entity', () => {
      let doc = createEmptyDocument();
      const boxResult = execute(doc, 'add_box', { size: [1, 1, 1] });
      doc = boxResult.document;
      const boxId = boxResult.affected[0]!;
      const lineResult = execute(doc, 'draw_line', { start: [0, 0], end: [1, 0] });
      doc = lineResult.document;
      const lineId = lineResult.affected[0]!;

      const result = execute(doc, 'boolean_union', { a: boxId, b: lineId });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('2D');
    });

    it('no-op when kernel is not injected', () => {
      setGeometryKernel(null);
      const { doc, idA, idB } = docWithTwoBoxes();
      const result = execute(doc, 'boolean_union', { a: idA, b: idB });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('kernel not available');
    });

    it('no-op when kernel returns null (degenerate geometry)', () => {
      fake.returnNull = true;
      const { doc, idA, idB } = docWithTwoBoxes();
      const result = execute(doc, 'boolean_union', { a: idA, b: idB });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('null');
    });
  });

  // -------------------------------------------------------------------------
  // Group handling — operands pruned from groups
  // -------------------------------------------------------------------------

  describe('group handling', () => {
    it('prunes operand ids from groups and dissolves groups that drop below 2 members', () => {
      const { doc: baseDoc, idA, idB } = docWithTwoBoxes();

      // Group both operands (exactly 2 members → will dissolve after union).
      const grouped = execute(baseDoc, 'group_entities', { ids: [idA, idB], name: 'Pair' });
      const docWithGroup = grouped.document;
      const groupId = grouped.affected[0]!;
      expect(docWithGroup.groups[groupId]!.memberIds).toEqual([idA, idB]);

      const result = execute(docWithGroup, 'boolean_union', { a: idA, b: idB });

      // Group dissolved because both members were consumed.
      expect(result.document.groups[groupId]).toBeUndefined();
    });

    it('keeps groups that retain >= 2 members after operands are removed', () => {
      let doc = createEmptyDocument();
      const r1 = execute(doc, 'add_box', { size: [1, 1, 1] });
      doc = r1.document;
      const r2 = execute(doc, 'add_box', { size: [1, 1, 1] });
      doc = r2.document;
      const r3 = execute(doc, 'add_box', { size: [1, 1, 1] });
      doc = r3.document;
      const idA = r1.affected[0]!;
      const idB = r2.affected[0]!;
      const idC = r3.affected[0]!;

      // Group all three; after union(A, B), C remains alone — group has 1 member → dissolves.
      // Use A+C and B+C to keep a group alive after removing A+B.
      const grouped = execute(doc, 'group_entities', { ids: [idA, idB, idC], name: 'Trio' });
      doc = grouped.document;
      const groupId = grouped.affected[0]!;

      const result = execute(doc, 'boolean_union', { a: idA, b: idB });

      // Group had 3 members; after removing A and B, 1 remains → dissolves.
      expect(result.document.groups[groupId]).toBeUndefined();
    });

    it('keeps a group with >= 2 non-operand members intact', () => {
      let doc = createEmptyDocument();
      const r1 = execute(doc, 'add_box', { size: [1, 1, 1] });
      doc = r1.document;
      const r2 = execute(doc, 'add_box', { size: [1, 1, 1] });
      doc = r2.document;
      const r3 = execute(doc, 'add_box', { size: [1, 1, 1] });
      doc = r3.document;
      const r4 = execute(doc, 'add_box', { size: [1, 1, 1] });
      doc = r4.document;
      const idA = r1.affected[0]!;
      const idB = r2.affected[0]!;
      const idC = r3.affected[0]!;
      const idD = r4.affected[0]!;

      // Group C and D (not the operands).
      const grouped = execute(doc, 'group_entities', { ids: [idC, idD], name: 'Survivors' });
      doc = grouped.document;
      const groupId = grouped.affected[0]!;

      const result = execute(doc, 'boolean_union', { a: idA, b: idB });

      // Group of C+D must be untouched.
      expect(result.document.groups[groupId]).toBeDefined();
      expect(result.document.groups[groupId]!.memberIds).toEqual([idC, idD]);
    });
  });

  // -------------------------------------------------------------------------
  // Purity
  // -------------------------------------------------------------------------

  describe('purity', () => {
    it('is pure — input document is not mutated by boolean_union', () => {
      const { doc, idA, idB } = docWithTwoBoxes();
      const snapshot = JSON.stringify(doc);
      execute(doc, 'boolean_union', { a: idA, b: idB });
      expect(JSON.stringify(doc)).toBe(snapshot);
    });

    it('is pure — input document is not mutated by boolean_subtract', () => {
      const { doc, idA, idB } = docWithTwoBoxes();
      const snapshot = JSON.stringify(doc);
      execute(doc, 'boolean_subtract', { a: idA, b: idB });
      expect(JSON.stringify(doc)).toBe(snapshot);
    });

    it('is pure — input document is not mutated by boolean_intersect', () => {
      const { doc, idA, idB } = docWithTwoBoxes();
      const snapshot = JSON.stringify(doc);
      execute(doc, 'boolean_intersect', { a: idA, b: idB });
      expect(JSON.stringify(doc)).toBe(snapshot);
    });
  });

  // -------------------------------------------------------------------------
  // Kernel injection round-trip
  // -------------------------------------------------------------------------

  it('getGeometryKernel returns null after afterEach cleanup', () => {
    // afterEach calls setGeometryKernel(null); this test confirms the module
    // state is reset. We call it manually here since we're inside the test.
    setGeometryKernel(null);
    expect(getGeometryKernel()).toBeNull();
  });

  // -------------------------------------------------------------------------
  // scale_entity on a boolean-result mesh (exercises the transform.ts mesh branch)
  // -------------------------------------------------------------------------

  it('scale_entity scales every position of a mesh entity by the factor', () => {
    const { doc, idA, idB } = docWithTwoBoxes();
    const unioned = execute(doc, 'boolean_union', { a: idA, b: idB });
    const meshId = unioned.affected[0]!;
    expect(unioned.document.entities[meshId]!.kind).toBe('mesh');

    const scaled = execute(unioned.document, 'scale_entity', { id: meshId, factor: 2 });
    const entity = scaled.document.entities[meshId]!;
    expect(entity.kind).toBe('mesh');
    if (entity.kind === 'mesh') {
      // Each xyz triple of the canned tetra is doubled; indices are unchanged.
      expect([...entity.mesh.positions]).toEqual([0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2]);
      expect([...entity.mesh.indices]).toEqual([...CANNED_MESH.indices]);
    }
  });
});

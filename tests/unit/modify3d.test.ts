import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { type MeshSolidEntity, type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { type MeshData, setGeometryKernel } from '@core/geometry/kernel';
import {
  fakeKernel,
  type FakeCall,
  type FakeKernel,
  type FakeKernelSpec,
} from '../helpers/fakeKernel';

// ---------------------------------------------------------------------------
// Canned meshes
// ---------------------------------------------------------------------------

const CANNED_MESH: MeshData = {
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
  indices: [0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3],
};

const FILLET_MESH: MeshData = {
  positions: [0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2, 1, 1, 0, 1, 0, 1],
  indices: [0, 1, 4, 0, 2, 4, 1, 3, 5, 2, 3, 5, 0, 1, 2, 3, 4, 5],
};

const CHAMFER_MESH: MeshData = {
  positions: [0, 0, 0, 3, 0, 0, 0, 3, 0, 0, 0, 3],
  indices: [0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3],
};

function countOf(fake: FakeKernel, op: string): number {
  return fake.calls.filter((call) => call.op === op).length;
}

function lastCall(fake: FakeKernel, op: string): FakeCall | undefined {
  return [...fake.calls].reverse().find((call) => call.op === op);
}

function freshKernel(spec: FakeKernelSpec = {}): FakeKernel {
  return fakeKernel({ solid: CANNED_MESH, fillet: FILLET_MESH, chamfer: CHAMFER_MESH, ...spec });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function docWithBox(): { doc: CadDocument; boxId: string } {
  const doc = createEmptyDocument();
  const r = execute(doc, 'add_box', { size: [2, 2, 2], position: [0, 0, 0], color: '#aabbcc' });
  return { doc: r.document, boxId: r.affected[0]! };
}

function docWithLine(): { doc: CadDocument; lineId: string } {
  const doc = createEmptyDocument();
  const r = execute(doc, 'draw_line', { start: [0, 0], end: [1, 0] });
  return { doc: r.document, lineId: r.affected[0]! };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('modify3d commands', () => {
  let fake: FakeKernel;

  beforeEach(() => {
    fake = freshKernel();
    setGeometryKernel(fake);
  });

  afterEach(() => {
    setGeometryKernel(null);
  });

  // -------------------------------------------------------------------------
  // fillet_edge — happy path
  // -------------------------------------------------------------------------

  describe('fillet_edge', () => {
    it('creates a new mesh entity and marks it as affected', () => {
      const { doc, boxId } = docWithBox();
      const result = execute(doc, 'fillet_edge', { id: boxId, radius: 0.2 });

      expect(result.affected).toHaveLength(1);
      const newId = result.affected[0]!;
      const entity = result.document.entities[newId];
      expect(entity).toBeDefined();
      expect(entity!.kind).toBe('mesh');
    });

    it('new mesh entity carries the filleted mesh data', () => {
      const { doc, boxId } = docWithBox();
      const result = execute(doc, 'fillet_edge', { id: boxId, radius: 0.2 });
      const newId = result.affected[0]!;
      const entity = result.document.entities[newId] as MeshSolidEntity;
      expect(entity.mesh.positions).toEqual(FILLET_MESH.positions);
      expect(entity.mesh.indices).toEqual(FILLET_MESH.indices);
    });

    it('stores the fillet recipe of the source as brep', () => {
      const { doc, boxId } = docWithBox();
      const result = execute(doc, 'fillet_edge', { id: boxId, radius: 0.2, edgeIndices: [1, 2] });
      const entity = result.document.entities[result.affected[0]!] as MeshSolidEntity;
      expect(entity.brep).toMatchObject({
        op: 'fillet',
        source: { op: 'solid', entity: doc.entities[boxId] },
        edges: [1, 2],
        size: 0.2,
      });
    });

    it('prunes the source entity from entities and order', () => {
      const { doc, boxId } = docWithBox();
      const result = execute(doc, 'fillet_edge', { id: boxId, radius: 0.2 });
      expect(result.document.entities[boxId]).toBeUndefined();
      expect(result.document.order).not.toContain(boxId);
    });

    it('appends new mesh id to order', () => {
      const { doc, boxId } = docWithBox();
      const result = execute(doc, 'fillet_edge', { id: boxId, radius: 0.2 });
      const newId = result.affected[0]!;
      expect(result.document.order).toContain(newId);
    });

    it('new mesh entity inherits layerId and color from source', () => {
      const { doc, boxId } = docWithBox();
      const source = doc.entities[boxId]!;
      const result = execute(doc, 'fillet_edge', { id: boxId, radius: 0.2 });
      const newId = result.affected[0]!;
      const entity = result.document.entities[newId]!;
      expect(entity.layerId).toBe(source.layerId);
      expect(entity.color).toBe(source.color);
    });

    it('new mesh entity has position [0,0,0] and rotation [0,0,0]', () => {
      const { doc, boxId } = docWithBox();
      const result = execute(doc, 'fillet_edge', { id: boxId, radius: 0.2 });
      const newId = result.affected[0]!;
      const entity = result.document.entities[newId]!;
      expect(entity.position).toEqual([0, 0, 0]);
      expect(entity.rotation).toEqual([0, 0, 0]);
    });

    it('passes radius to the kernel', () => {
      const { doc, boxId } = docWithBox();
      execute(doc, 'fillet_edge', { id: boxId, radius: 0.5 });
      expect(lastCall(fake, 'fillet')?.size).toBe(0.5);
    });

    it('passes edgeIndices to the kernel when provided', () => {
      const { doc, boxId } = docWithBox();
      execute(doc, 'fillet_edge', { id: boxId, radius: 0.2, edgeIndices: [0, 3, 7] });
      expect(lastCall(fake, 'fillet')?.edges).toEqual([0, 3, 7]);
    });

    it('defaults edgeIndices to [] (all edges) when omitted', () => {
      const { doc, boxId } = docWithBox();
      execute(doc, 'fillet_edge', { id: boxId, radius: 0.2 });
      expect(lastCall(fake, 'fillet')?.edges).toEqual([]);
    });

    it('summary includes source id, new id, radius, triangle count', () => {
      const { doc, boxId } = docWithBox();
      const result = execute(doc, 'fillet_edge', { id: boxId, radius: 0.2 });
      const newId = result.affected[0]!;
      const triCount = FILLET_MESH.indices.length / 3;
      expect(result.summary).toContain(boxId);
      expect(result.summary).toContain(newId);
      expect(result.summary).toContain('0.2');
      expect(result.summary).toContain(String(triCount));
    });

    it('builds the source leaf then fillets it once', () => {
      const { doc, boxId } = docWithBox();
      execute(doc, 'fillet_edge', { id: boxId, radius: 0.2 });
      expect(countOf(fake, 'solid')).toBe(1);
      expect(countOf(fake, 'fillet')).toBe(1);
    });

    // -----------------------------------------------------------------------
    // fillet_edge — failure paths
    // -----------------------------------------------------------------------

    it('no-op when target id does not exist', () => {
      const { doc } = docWithBox();
      const result = execute(doc, 'fillet_edge', { id: 'ghost', radius: 0.2 });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('ghost');
      expect(countOf(fake, 'solid')).toBe(0);
      expect(countOf(fake, 'fillet')).toBe(0);
    });

    it('no-op when target is a 2D entity', () => {
      const { doc, lineId } = docWithLine();
      const result = execute(doc, 'fillet_edge', { id: lineId, radius: 0.2 });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('2D');
      expect(countOf(fake, 'solid')).toBe(0);
      expect(countOf(fake, 'fillet')).toBe(0);
    });

    it('no-op when radius is zero', () => {
      const { doc, boxId } = docWithBox();
      const result = execute(doc, 'fillet_edge', { id: boxId, radius: 0 });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('radius');
      expect(countOf(fake, 'solid')).toBe(0);
      expect(countOf(fake, 'fillet')).toBe(0);
    });

    it('no-op when radius is negative', () => {
      const { doc, boxId } = docWithBox();
      const result = execute(doc, 'fillet_edge', { id: boxId, radius: -1 });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(countOf(fake, 'fillet')).toBe(0);
    });

    it('no-op when kernel is not injected', () => {
      setGeometryKernel(null);
      const { doc, boxId } = docWithBox();
      const result = execute(doc, 'fillet_edge', { id: boxId, radius: 0.2 });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('kernel not available');
    });

    it('no-op when the kernel cannot build the source; source not pruned', () => {
      setGeometryKernel((fake = freshKernel({ solid: null })));
      const { doc, boxId } = docWithBox();
      const result = execute(doc, 'fillet_edge', { id: boxId, radius: 0.2 });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.document.entities[boxId]).toBeDefined();
      expect(countOf(fake, 'fillet')).toBe(0);
    });

    it('no-op when kernel fillet returns null; source not pruned', () => {
      setGeometryKernel((fake = freshKernel({ fillet: null })));
      const { doc, boxId } = docWithBox();
      const result = execute(doc, 'fillet_edge', { id: boxId, radius: 0.2 });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.document.entities[boxId]).toBeDefined();
      expect(result.summary).toContain('returned null');
      expect(result.summary).toContain('LLULL_KERNEL=occt on the server');
      expect(result.summary).not.toContain('Try ?kernel=occt');
    });

    // -----------------------------------------------------------------------
    // fillet_edge — purity
    // -----------------------------------------------------------------------

    it('is pure — input doc not mutated on success', () => {
      const { doc, boxId } = docWithBox();
      const snapshot = JSON.stringify(doc);
      execute(doc, 'fillet_edge', { id: boxId, radius: 0.2 });
      expect(JSON.stringify(doc)).toBe(snapshot);
    });

    it('is pure — input doc not mutated on failure (missing id)', () => {
      const { doc } = docWithBox();
      const snapshot = JSON.stringify(doc);
      execute(doc, 'fillet_edge', { id: 'ghost', radius: 0.2 });
      expect(JSON.stringify(doc)).toBe(snapshot);
    });

    it('is pure — input doc not mutated when kernel returns null', () => {
      setGeometryKernel((fake = freshKernel({ fillet: null })));
      const { doc, boxId } = docWithBox();
      const snapshot = JSON.stringify(doc);
      execute(doc, 'fillet_edge', { id: boxId, radius: 0.2 });
      expect(JSON.stringify(doc)).toBe(snapshot);
    });
  });

  // -------------------------------------------------------------------------
  // chamfer_edge — happy path
  // -------------------------------------------------------------------------

  describe('chamfer_edge', () => {
    it('creates a new mesh entity and marks it as affected', () => {
      const { doc, boxId } = docWithBox();
      const result = execute(doc, 'chamfer_edge', { id: boxId, distance: 0.1 });

      expect(result.affected).toHaveLength(1);
      const newId = result.affected[0]!;
      const entity = result.document.entities[newId];
      expect(entity).toBeDefined();
      expect(entity!.kind).toBe('mesh');
    });

    it('new mesh entity carries the chamfered mesh data', () => {
      const { doc, boxId } = docWithBox();
      const result = execute(doc, 'chamfer_edge', { id: boxId, distance: 0.1 });
      const newId = result.affected[0]!;
      const entity = result.document.entities[newId] as MeshSolidEntity;
      expect(entity.mesh.positions).toEqual(CHAMFER_MESH.positions);
      expect(entity.mesh.indices).toEqual(CHAMFER_MESH.indices);
    });

    it('stores the chamfer recipe of the source as brep', () => {
      const { doc, boxId } = docWithBox();
      const result = execute(doc, 'chamfer_edge', {
        id: boxId,
        distance: 0.1,
        edgeIndices: [1, 2],
      });
      const entity = result.document.entities[result.affected[0]!] as MeshSolidEntity;
      expect(entity.brep).toMatchObject({
        op: 'chamfer',
        source: { op: 'solid', entity: doc.entities[boxId] },
        edges: [1, 2],
        size: 0.1,
      });
    });

    it('prunes the source entity from entities and order', () => {
      const { doc, boxId } = docWithBox();
      const result = execute(doc, 'chamfer_edge', { id: boxId, distance: 0.1 });
      expect(result.document.entities[boxId]).toBeUndefined();
      expect(result.document.order).not.toContain(boxId);
    });

    it('passes distance to the kernel', () => {
      const { doc, boxId } = docWithBox();
      execute(doc, 'chamfer_edge', { id: boxId, distance: 0.3 });
      expect(lastCall(fake, 'chamfer')?.size).toBe(0.3);
    });

    it('passes edgeIndices to the kernel when provided', () => {
      const { doc, boxId } = docWithBox();
      execute(doc, 'chamfer_edge', { id: boxId, distance: 0.1, edgeIndices: [1, 5] });
      expect(lastCall(fake, 'chamfer')?.edges).toEqual([1, 5]);
    });

    it('defaults edgeIndices to [] (all edges) when omitted', () => {
      const { doc, boxId } = docWithBox();
      execute(doc, 'chamfer_edge', { id: boxId, distance: 0.1 });
      expect(lastCall(fake, 'chamfer')?.edges).toEqual([]);
    });

    it('summary includes source id, new id, distance, triangle count', () => {
      const { doc, boxId } = docWithBox();
      const result = execute(doc, 'chamfer_edge', { id: boxId, distance: 0.1 });
      const newId = result.affected[0]!;
      const triCount = CHAMFER_MESH.indices.length / 3;
      expect(result.summary).toContain(boxId);
      expect(result.summary).toContain(newId);
      expect(result.summary).toContain('0.1');
      expect(result.summary).toContain(String(triCount));
    });

    it('builds the source leaf then chamfers it once', () => {
      const { doc, boxId } = docWithBox();
      execute(doc, 'chamfer_edge', { id: boxId, distance: 0.1 });
      expect(countOf(fake, 'solid')).toBe(1);
      expect(countOf(fake, 'chamfer')).toBe(1);
    });

    // -----------------------------------------------------------------------
    // chamfer_edge — failure paths
    // -----------------------------------------------------------------------

    it('no-op when target id does not exist', () => {
      const { doc } = docWithBox();
      const result = execute(doc, 'chamfer_edge', { id: 'ghost', distance: 0.1 });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('ghost');
      expect(countOf(fake, 'solid')).toBe(0);
      expect(countOf(fake, 'chamfer')).toBe(0);
    });

    it('no-op when target is a 2D entity', () => {
      const { doc, lineId } = docWithLine();
      const result = execute(doc, 'chamfer_edge', { id: lineId, distance: 0.1 });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('2D');
      expect(countOf(fake, 'solid')).toBe(0);
      expect(countOf(fake, 'chamfer')).toBe(0);
    });

    it('no-op when distance is zero', () => {
      const { doc, boxId } = docWithBox();
      const result = execute(doc, 'chamfer_edge', { id: boxId, distance: 0 });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('distance');
      expect(countOf(fake, 'solid')).toBe(0);
      expect(countOf(fake, 'chamfer')).toBe(0);
    });

    it('no-op when distance is negative', () => {
      const { doc, boxId } = docWithBox();
      const result = execute(doc, 'chamfer_edge', { id: boxId, distance: -0.5 });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(countOf(fake, 'chamfer')).toBe(0);
    });

    it('no-op when kernel is not injected', () => {
      setGeometryKernel(null);
      const { doc, boxId } = docWithBox();
      const result = execute(doc, 'chamfer_edge', { id: boxId, distance: 0.1 });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('kernel not available');
    });

    it('no-op when the kernel cannot build the source; source not pruned', () => {
      setGeometryKernel((fake = freshKernel({ solid: null })));
      const { doc, boxId } = docWithBox();
      const result = execute(doc, 'chamfer_edge', { id: boxId, distance: 0.1 });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.document.entities[boxId]).toBeDefined();
      expect(countOf(fake, 'chamfer')).toBe(0);
    });

    it('no-op when kernel chamfer returns null; source not pruned', () => {
      setGeometryKernel((fake = freshKernel({ chamfer: null })));
      const { doc, boxId } = docWithBox();
      const result = execute(doc, 'chamfer_edge', { id: boxId, distance: 0.1 });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.document.entities[boxId]).toBeDefined();
      expect(result.summary).toContain('returned null');
      expect(result.summary).toContain('LLULL_KERNEL=occt on the server');
      expect(result.summary).not.toContain('Try ?kernel=occt');
    });

    // -----------------------------------------------------------------------
    // chamfer_edge — purity
    // -----------------------------------------------------------------------

    it('is pure — input doc not mutated on success', () => {
      const { doc, boxId } = docWithBox();
      const snapshot = JSON.stringify(doc);
      execute(doc, 'chamfer_edge', { id: boxId, distance: 0.1 });
      expect(JSON.stringify(doc)).toBe(snapshot);
    });

    it('is pure — input doc not mutated on failure (missing id)', () => {
      const { doc } = docWithBox();
      const snapshot = JSON.stringify(doc);
      execute(doc, 'chamfer_edge', { id: 'ghost', distance: 0.1 });
      expect(JSON.stringify(doc)).toBe(snapshot);
    });

    it('is pure — input doc not mutated when kernel returns null', () => {
      setGeometryKernel((fake = freshKernel({ chamfer: null })));
      const { doc, boxId } = docWithBox();
      const snapshot = JSON.stringify(doc);
      execute(doc, 'chamfer_edge', { id: boxId, distance: 0.1 });
      expect(JSON.stringify(doc)).toBe(snapshot);
    });
  });

  // -------------------------------------------------------------------------
  // Group handling — source pruned from groups
  // -------------------------------------------------------------------------

  describe('group handling', () => {
    it('fillet_edge: dissolves a group that drops below 2 members after source is consumed', () => {
      const { doc: baseDoc, boxId } = docWithBox();
      // Add a second box so the group has exactly 2 members; filleting the first will dissolve it.
      const r2 = execute(baseDoc, 'add_box', { size: [1, 1, 1] });
      const boxId2 = r2.affected[0]!;
      let doc = r2.document;
      const grouped = execute(doc, 'group_entities', { ids: [boxId, boxId2], name: 'Pair' });
      doc = grouped.document;
      const groupId = grouped.affected[0]!;

      const result = execute(doc, 'fillet_edge', { id: boxId, distance: 0.1, radius: 0.1 });
      expect(result.document.groups[groupId]).toBeUndefined();
    });

    it('chamfer_edge: keeps a group that retains >= 2 members', () => {
      const { doc: baseDoc, boxId } = docWithBox();
      const r2 = execute(baseDoc, 'add_box', { size: [1, 1, 1] });
      const boxId2 = r2.affected[0]!;
      const r3 = execute(r2.document, 'add_box', { size: [1, 1, 1] });
      const boxId3 = r3.affected[0]!;
      let doc = r3.document;

      // Group box2 and box3 — chamfer boxId should not affect this group.
      const grouped = execute(doc, 'group_entities', { ids: [boxId2, boxId3], name: 'Pair' });
      doc = grouped.document;
      const groupId = grouped.affected[0]!;

      const result = execute(doc, 'chamfer_edge', { id: boxId, distance: 0.1 });
      expect(result.document.groups[groupId]).toBeDefined();
      expect(result.document.groups[groupId]!.memberIds).toContain(boxId2);
      expect(result.document.groups[groupId]!.memberIds).toContain(boxId3);
    });
  });
});

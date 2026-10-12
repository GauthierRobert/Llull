import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { type MeshSolidEntity, type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import type { MeshData } from '@core/model/types';
import {
  TETRA,
  fakeKernel,
  type FakeCall,
  type FakeKernel,
  type FakeKernelSpec,
} from '../helpers/fakeKernel';

// Canned meshes

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

function expectUnchanged(result: ReturnType<typeof execute>, doc: CadDocument): void {
  expect(result.affected).toHaveLength(0);
  expect(result.document).toBe(doc);
}

function expectSourceKept(result: ReturnType<typeof execute>, doc: CadDocument, id: string): void {
  expectUnchanged(result, doc);
  expect(result.document.entities[id]).toBeDefined();
}

function lastCall(fake: FakeKernel, op: string): FakeCall | undefined {
  return [...fake.calls].reverse().find((call) => call.op === op);
}

function freshKernel(spec: FakeKernelSpec = {}): FakeKernel {
  return fakeKernel({ solid: TETRA, fillet: FILLET_MESH, chamfer: CHAMFER_MESH, ...spec });
}

// Helpers

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

// Tests

const CASES = [
  {
    cmd: 'fillet_edge',
    op: 'fillet',
    key: 'radius',
    size: 0.2,
    other: 0.5,
    mesh: FILLET_MESH,
    edges: [0, 3, 7],
  },
  {
    cmd: 'chamfer_edge',
    op: 'chamfer',
    key: 'distance',
    size: 0.1,
    other: 0.3,
    mesh: CHAMFER_MESH,
    edges: [1, 5],
  },
] as const;

describe('modify3d commands', () => {
  let fake: FakeKernel;

  beforeEach(() => {
    fake = freshKernel();
    setGeometryKernel(fake);
  });

  afterEach(() => {
    setGeometryKernel(null);
  });

  describe.each(CASES)('$cmd', ({ cmd, op, key, size, other, mesh, edges }) => {
    const run = (
      doc: CadDocument,
      id: string,
      extra: Record<string, unknown> = {},
    ): ReturnType<typeof execute> => execute(doc, cmd, { id, [key]: size, ...extra });

    it('creates a new mesh entity and marks it as affected', () => {
      const { doc, boxId } = docWithBox();
      const result = run(doc, boxId);

      expect(result.affected).toHaveLength(1);
      const entity = result.document.entities[result.affected[0]!];
      expect(entity).toBeDefined();
      expect(entity!.kind).toBe('mesh');
    });

    it('new mesh entity carries the resulting mesh data', () => {
      const { doc, boxId } = docWithBox();
      const result = run(doc, boxId);
      const entity = result.document.entities[result.affected[0]!] as MeshSolidEntity;
      expect(entity.mesh.positions).toEqual(mesh.positions);
      expect(entity.mesh.indices).toEqual(mesh.indices);
    });

    it('stores the recipe of the source as brep', () => {
      const { doc, boxId } = docWithBox();
      const result = run(doc, boxId, { edgeIndices: [1, 2] });
      const entity = result.document.entities[result.affected[0]!] as MeshSolidEntity;
      expect(entity.brep).toMatchObject({
        op,
        source: { op: 'solid', entity: doc.entities[boxId] },
        edges: [1, 2],
        size,
      });
    });

    it('prunes the source entity from entities and order', () => {
      const { doc, boxId } = docWithBox();
      const result = run(doc, boxId);
      expect(result.document.entities[boxId]).toBeUndefined();
      expect(result.document.order).not.toContain(boxId);
    });

    it('appends new mesh id to order', () => {
      const { doc, boxId } = docWithBox();
      const result = run(doc, boxId);
      expect(result.document.order).toContain(result.affected[0]!);
    });

    it('new mesh entity inherits layerId and color from source', () => {
      const { doc, boxId } = docWithBox();
      const source = doc.entities[boxId]!;
      const result = run(doc, boxId);
      const entity = result.document.entities[result.affected[0]!]!;
      expect(entity.layerId).toBe(source.layerId);
      expect(entity.color).toBe(source.color);
    });

    it('new mesh entity has position [0,0,0] and rotation [0,0,0]', () => {
      const { doc, boxId } = docWithBox();
      const result = run(doc, boxId);
      const entity = result.document.entities[result.affected[0]!]!;
      expect(entity.position).toEqual([0, 0, 0]);
      expect(entity.rotation).toEqual([0, 0, 0]);
    });

    it('passes the size to the kernel', () => {
      const { doc, boxId } = docWithBox();
      run(doc, boxId, { [key]: other });
      expect(lastCall(fake, op)?.size).toBe(other);
    });

    it('passes edgeIndices to the kernel when provided', () => {
      const { doc, boxId } = docWithBox();
      run(doc, boxId, { edgeIndices: [...edges] });
      expect(lastCall(fake, op)?.edges).toEqual(edges);
    });

    it('defaults edgeIndices to [] (all edges) when omitted', () => {
      const { doc, boxId } = docWithBox();
      run(doc, boxId);
      expect(lastCall(fake, op)?.edges).toEqual([]);
    });

    it('summary includes source id, new id, size, triangle count', () => {
      const { doc, boxId } = docWithBox();
      const result = run(doc, boxId);
      expect(result.summary).toContain(boxId);
      expect(result.summary).toContain(result.affected[0]!);
      expect(result.summary).toContain(String(size));
      expect(result.summary).toContain(String(mesh.indices.length / 3));
    });

    it('builds the source leaf then runs the op once', () => {
      const { doc, boxId } = docWithBox();
      run(doc, boxId);
      expect(countOf(fake, 'solid')).toBe(1);
      expect(countOf(fake, op)).toBe(1);
    });

    it('no-op when target id does not exist', () => {
      const { doc } = docWithBox();
      const result = run(doc, 'ghost');
      expectUnchanged(result, doc);
      expect(result.summary).toContain('ghost');
      expect(countOf(fake, 'solid')).toBe(0);
      expect(countOf(fake, op)).toBe(0);
    });

    it('no-op when target is a 2D entity', () => {
      const { doc, lineId } = docWithLine();
      const result = run(doc, lineId);
      expectUnchanged(result, doc);
      expect(result.summary).toContain('2D');
      expect(countOf(fake, 'solid')).toBe(0);
      expect(countOf(fake, op)).toBe(0);
    });

    it('no-op when size is zero', () => {
      const { doc, boxId } = docWithBox();
      const result = run(doc, boxId, { [key]: 0 });
      expectUnchanged(result, doc);
      expect(result.summary).toContain(key);
      expect(countOf(fake, 'solid')).toBe(0);
      expect(countOf(fake, op)).toBe(0);
    });

    it('no-op when size is negative', () => {
      const { doc, boxId } = docWithBox();
      const result = run(doc, boxId, { [key]: -1 });
      expectUnchanged(result, doc);
      expect(countOf(fake, op)).toBe(0);
    });

    it('no-op when kernel is not injected', () => {
      setGeometryKernel(null);
      const { doc, boxId } = docWithBox();
      const result = run(doc, boxId);
      expectUnchanged(result, doc);
      expect(result.summary).toContain('kernel not available');
    });

    it('no-op when the kernel cannot build the source; source not pruned', () => {
      setGeometryKernel((fake = freshKernel({ solid: null })));
      const { doc, boxId } = docWithBox();
      const result = run(doc, boxId);
      expectSourceKept(result, doc, boxId);
      expect(countOf(fake, op)).toBe(0);
    });

    it('no-op when the kernel op returns null; source not pruned', () => {
      setGeometryKernel((fake = freshKernel({ [op]: null })));
      const { doc, boxId } = docWithBox();
      const result = run(doc, boxId);
      expectSourceKept(result, doc, boxId);
      expect(result.summary).toContain('returned null');
      expect(result.summary).toContain('could not round these edges into a valid solid');
      expect(result.summary).not.toContain('Try ?kernel=occt');
    });

    it('no-op when the result has no closed mesh; source not pruned', () => {
      setGeometryKernel((fake = freshKernel({ [op]: { positions: [], indices: [] } })));
      const { doc, boxId } = docWithBox();
      const result = run(doc, boxId);
      expectSourceKept(result, doc, boxId);
      expect(result.summary).toContain('could not be tessellated into a closed mesh');
    });

    it('no-op naming the OCC kernel when this kernel lacks the op; source not pruned', () => {
      setGeometryKernel((fake = freshKernel({ unsupported: [op], [op]: null })));
      const { doc, boxId } = docWithBox();
      const result = run(doc, boxId);
      expectSourceKept(result, doc, boxId);
      expect(result.summary).toContain(`does not support`);
      expect(result.summary).toContain('LLULL_KERNEL=occt on the server');
    });

    it('is pure — input doc not mutated on success', () => {
      const { doc, boxId } = docWithBox();
      const snapshot = JSON.stringify(doc);
      run(doc, boxId);
      expect(JSON.stringify(doc)).toBe(snapshot);
    });

    it('is pure — input doc not mutated on failure (missing id)', () => {
      const { doc } = docWithBox();
      const snapshot = JSON.stringify(doc);
      run(doc, 'ghost');
      expect(JSON.stringify(doc)).toBe(snapshot);
    });

    it('is pure — input doc not mutated when kernel returns null', () => {
      setGeometryKernel((fake = freshKernel({ [op]: null })));
      const { doc, boxId } = docWithBox();
      const snapshot = JSON.stringify(doc);
      run(doc, boxId);
      expect(JSON.stringify(doc)).toBe(snapshot);
    });
  });

  // Group handling — source pruned from groups

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

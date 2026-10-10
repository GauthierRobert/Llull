import { describe, it, expect } from 'vitest';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

function twoBoxes(): { doc: CadDocument; id1: string; id2: string } {
  const r1 = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
  const r2 = execute(r1.document, 'add_box', { size: [2, 2, 2] });
  return { doc: r2.document, id1: r1.affected[0]!, id2: r2.affected[0]! };
}

function groupedBoxes(name?: string): {
  doc: CadDocument;
  id1: string;
  id2: string;
  groupId: string;
} {
  const { doc, id1, id2 } = twoBoxes();
  const grouped = execute(doc, 'group_entities', { ids: [id1, id2], ...(name ? { name } : {}) });
  return { doc: grouped.document, id1, id2, groupId: grouped.affected[0]! };
}

function singleBox(params: Record<string, unknown> = {}): { doc: CadDocument; sourceId: string } {
  const created = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1], ...params });
  return { doc: created.document, sourceId: created.affected[0]! };
}

function expectMissingNoOp(
  cmd: string,
  params: Record<string, unknown>,
  summaryPart: string,
): void {
  const doc = createEmptyDocument();
  const result = execute(doc, cmd, params);
  expect(result.affected).toHaveLength(0);
  expect(result.document).toBe(doc);
  expect(result.summary).toContain(summaryPart);
}

function expectPure(doc: CadDocument, cmd: string, params: Record<string, unknown>): void {
  const snapshot = JSON.stringify(doc);
  execute(doc, cmd, params);
  expect(JSON.stringify(doc)).toBe(snapshot);
}

describe('edit commands', () => {
  it('createEmptyDocument initializes groups as {}', () => {
    expect(createEmptyDocument().groups).toEqual({});
  });

  describe('duplicate_entity', () => {
    it('creates a distinct entity with copied geometry', () => {
      const { doc, sourceId } = singleBox({ size: [2, 3, 4], position: [1, 1, 1] });
      const result = execute(doc, 'duplicate_entity', { id: sourceId });

      expect(result.affected).toHaveLength(1);
      const newId = result.affected[0]!;
      expect(newId).not.toBe(sourceId);

      const newEntity = result.document.entities[newId]!;
      expect(newEntity.kind).toBe('box');
      expect(newEntity.id).toBe(newId);
      // Original still intact
      expect(result.document.entities[sourceId]!.id).toBe(sourceId);
    });

    it('places copy at original position when no offset is given', () => {
      const { doc, sourceId } = singleBox({ position: [5, 6, 7] });
      const result = execute(doc, 'duplicate_entity', { id: sourceId });
      expect(result.document.entities[result.affected[0]!]!.position).toEqual([5, 6, 7]);
    });

    it('applies offset to the copy position', () => {
      const { doc, sourceId } = singleBox({ position: [0, 0, 0] });
      const result = execute(doc, 'duplicate_entity', { id: sourceId, offset: [10, 0, -3] });

      expect(result.document.entities[result.affected[0]!]!.position).toEqual([10, 0, -3]);
      // original unaffected
      expect(result.document.entities[sourceId]!.position).toEqual([0, 0, 0]);
    });

    it('appends the new id to doc.order', () => {
      const { doc, sourceId } = singleBox();
      const result = execute(doc, 'duplicate_entity', { id: sourceId });
      const newId = result.affected[0]!;

      expect(result.document.order).toContain(sourceId);
      expect(result.document.order).toContain(newId);
      expect(result.document.order.at(-1)).toBe(newId);
    });

    it('missing id is a graceful no-op', () => {
      expectMissingNoOp('duplicate_entity', { id: 'ghost' }, 'ghost');
    });

    it('is pure — input document is not mutated', () => {
      const { doc, sourceId } = singleBox();
      expectPure(doc, 'duplicate_entity', { id: sourceId });
    });
  });

  describe('group_entities', () => {
    it('creates a new group containing the provided entity ids', () => {
      const { doc, id1, id2 } = twoBoxes();
      const result = execute(doc, 'group_entities', { ids: [id1, id2], name: 'Test group' });

      expect(result.affected).toHaveLength(1);
      const group = result.document.groups[result.affected[0]!];
      expect(group).toBeDefined();
      expect(group!.name).toBe('Test group');
      expect(group!.memberIds).toContain(id1);
      expect(group!.memberIds).toContain(id2);
    });

    it('defaults group name to "Group" when not provided', () => {
      const { doc, groupId } = groupedBoxes();
      expect(doc.groups[groupId]!.name).toBe('Group');
    });

    it('filters out ids that do not exist in the document', () => {
      const { doc, id1, id2 } = twoBoxes();
      // 'phantom' does not exist — should still create a group with id1 + id2
      const result = execute(doc, 'group_entities', { ids: [id1, id2, 'phantom'] });
      const group = result.document.groups[result.affected[0]!]!;
      expect(group.memberIds).not.toContain('phantom');
      expect(group.memberIds).toHaveLength(2);
    });

    it('is a no-op when fewer than 2 valid ids are provided', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'group_entities', { ids: ['ghost1', 'ghost2'] });

      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toMatch(/0/);
    });

    it('is a no-op when exactly 1 valid id is provided', () => {
      const { doc, sourceId } = singleBox();
      const result = execute(doc, 'group_entities', { ids: [sourceId] });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
    });

    it('is pure — input document is not mutated', () => {
      const { doc, id1, id2 } = twoBoxes();
      expectPure(doc, 'group_entities', { ids: [id1, id2] });
    });
  });

  describe('ungroup_entities', () => {
    it('removes the group from doc.groups', () => {
      const { doc, groupId } = groupedBoxes('ToDissolve');
      const result = execute(doc, 'ungroup_entities', { groupId });
      expect(result.document.groups[groupId]).toBeUndefined();
    });

    it('keeps member entities in the document after ungroup', () => {
      const { doc, id1, id2, groupId } = groupedBoxes();
      const result = execute(doc, 'ungroup_entities', { groupId });
      expect(result.document.entities[id1]).toBeDefined();
      expect(result.document.entities[id2]).toBeDefined();
    });

    it('returns freed member ids in affected', () => {
      const { doc, id1, id2, groupId } = groupedBoxes();
      const result = execute(doc, 'ungroup_entities', { groupId });
      expect(result.affected).toContain(id1);
      expect(result.affected).toContain(id2);
    });

    it('missing groupId is a graceful no-op', () => {
      expectMissingNoOp('ungroup_entities', { groupId: 'no-such-group' }, 'no-such-group');
    });

    it('is pure — input document is not mutated', () => {
      const { doc, groupId } = groupedBoxes();
      expectPure(doc, 'ungroup_entities', { groupId });
    });
  });
});

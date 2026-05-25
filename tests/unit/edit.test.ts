import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { __resetIdCounter } from '@lib/id';

describe('edit commands', () => {
  beforeEach(() => __resetIdCounter());

  // -------------------------------------------------------------------------
  // createEmptyDocument baseline
  // -------------------------------------------------------------------------

  it('createEmptyDocument initializes groups as {}', () => {
    const doc = createEmptyDocument();
    expect(doc.groups).toEqual({});
  });

  // -------------------------------------------------------------------------
  // duplicate_entity
  // -------------------------------------------------------------------------

  describe('duplicate_entity', () => {
    it('creates a distinct entity with copied geometry', () => {
      let doc = createEmptyDocument();
      const created = execute(doc, 'add_box', { size: [2, 3, 4], position: [1, 1, 1] });
      doc = created.document;
      const sourceId = created.affected[0]!;

      const result = execute(doc, 'duplicate_entity', { id: sourceId });

      expect(result.affected).toHaveLength(1);
      const newId = result.affected[0]!;
      expect(newId).not.toBe(sourceId);

      const newEntity = result.document.entities[newId]!;
      const sourceEntity = result.document.entities[sourceId]!;

      expect(newEntity.kind).toBe('box');
      expect(newEntity.id).toBe(newId);
      // Original still intact
      expect(sourceEntity.id).toBe(sourceId);
    });

    it('places copy at original position when no offset is given', () => {
      let doc = createEmptyDocument();
      const created = execute(doc, 'add_box', { size: [1, 1, 1], position: [5, 6, 7] });
      doc = created.document;
      const sourceId = created.affected[0]!;

      const result = execute(doc, 'duplicate_entity', { id: sourceId });
      const newId = result.affected[0]!;

      expect(result.document.entities[newId]!.position).toEqual([5, 6, 7]);
    });

    it('applies offset to the copy position', () => {
      let doc = createEmptyDocument();
      const created = execute(doc, 'add_box', { size: [1, 1, 1], position: [0, 0, 0] });
      doc = created.document;
      const sourceId = created.affected[0]!;

      const result = execute(doc, 'duplicate_entity', {
        id: sourceId,
        offset: [10, 0, -3],
      });
      const newId = result.affected[0]!;

      expect(result.document.entities[newId]!.position).toEqual([10, 0, -3]);
      // original unaffected
      expect(result.document.entities[sourceId]!.position).toEqual([0, 0, 0]);
    });

    it('appends the new id to doc.order', () => {
      let doc = createEmptyDocument();
      const created = execute(doc, 'add_box', { size: [1, 1, 1] });
      doc = created.document;
      const sourceId = created.affected[0]!;

      const result = execute(doc, 'duplicate_entity', { id: sourceId });
      const newId = result.affected[0]!;

      expect(result.document.order).toContain(sourceId);
      expect(result.document.order).toContain(newId);
      expect(result.document.order.at(-1)).toBe(newId);
    });

    it('missing id is a graceful no-op', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'duplicate_entity', { id: 'ghost' });

      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('ghost');
    });

    it('is pure — input document is not mutated', () => {
      let doc = createEmptyDocument();
      const created = execute(doc, 'add_box', { size: [1, 1, 1] });
      doc = created.document;
      const sourceId = created.affected[0]!;
      const snapshot = JSON.stringify(doc);

      execute(doc, 'duplicate_entity', { id: sourceId });

      expect(JSON.stringify(doc)).toBe(snapshot);
    });
  });

  // -------------------------------------------------------------------------
  // group_entities
  // -------------------------------------------------------------------------

  describe('group_entities', () => {
    it('creates a new group containing the provided entity ids', () => {
      let doc = createEmptyDocument();
      const r1 = execute(doc, 'add_box', { size: [1, 1, 1] });
      doc = r1.document;
      const r2 = execute(doc, 'add_box', { size: [2, 2, 2] });
      doc = r2.document;
      const id1 = r1.affected[0]!;
      const id2 = r2.affected[0]!;

      const result = execute(doc, 'group_entities', { ids: [id1, id2], name: 'Test group' });

      expect(result.affected).toHaveLength(1);
      const groupId = result.affected[0]!;
      const group = result.document.groups[groupId];
      expect(group).toBeDefined();
      expect(group!.name).toBe('Test group');
      expect(group!.memberIds).toContain(id1);
      expect(group!.memberIds).toContain(id2);
    });

    it('defaults group name to "Group" when not provided', () => {
      let doc = createEmptyDocument();
      const r1 = execute(doc, 'add_box', { size: [1, 1, 1] });
      doc = r1.document;
      const r2 = execute(doc, 'add_box', { size: [2, 2, 2] });
      doc = r2.document;

      const result = execute(doc, 'group_entities', {
        ids: [r1.affected[0]!, r2.affected[0]!],
      });
      const groupId = result.affected[0]!;
      expect(result.document.groups[groupId]!.name).toBe('Group');
    });

    it('filters out ids that do not exist in the document', () => {
      let doc = createEmptyDocument();
      const r1 = execute(doc, 'add_box', { size: [1, 1, 1] });
      doc = r1.document;
      const r2 = execute(doc, 'add_box', { size: [2, 2, 2] });
      doc = r2.document;
      const id1 = r1.affected[0]!;
      const id2 = r2.affected[0]!;

      // 'phantom' does not exist — should still create a group with id1 + id2
      const result = execute(doc, 'group_entities', { ids: [id1, id2, 'phantom'] });
      const groupId = result.affected[0]!;
      expect(result.document.groups[groupId]!.memberIds).not.toContain('phantom');
      expect(result.document.groups[groupId]!.memberIds).toHaveLength(2);
    });

    it('is a no-op when fewer than 2 valid ids are provided', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'group_entities', { ids: ['ghost1', 'ghost2'] });

      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toMatch(/0/);
    });

    it('is a no-op when exactly 1 valid id is provided', () => {
      let doc = createEmptyDocument();
      const r1 = execute(doc, 'add_box', { size: [1, 1, 1] });
      doc = r1.document;

      const result = execute(doc, 'group_entities', { ids: [r1.affected[0]!] });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
    });

    it('is pure — input document is not mutated', () => {
      let doc = createEmptyDocument();
      const r1 = execute(doc, 'add_box', { size: [1, 1, 1] });
      doc = r1.document;
      const r2 = execute(doc, 'add_box', { size: [2, 2, 2] });
      doc = r2.document;
      const snapshot = JSON.stringify(doc);

      execute(doc, 'group_entities', { ids: [r1.affected[0]!, r2.affected[0]!] });

      expect(JSON.stringify(doc)).toBe(snapshot);
    });
  });

  // -------------------------------------------------------------------------
  // ungroup_entities
  // -------------------------------------------------------------------------

  describe('ungroup_entities', () => {
    it('removes the group from doc.groups', () => {
      let doc = createEmptyDocument();
      const r1 = execute(doc, 'add_box', { size: [1, 1, 1] });
      doc = r1.document;
      const r2 = execute(doc, 'add_box', { size: [2, 2, 2] });
      doc = r2.document;
      const grouped = execute(doc, 'group_entities', {
        ids: [r1.affected[0]!, r2.affected[0]!],
        name: 'ToDissolve',
      });
      doc = grouped.document;
      const groupId = grouped.affected[0]!;

      const result = execute(doc, 'ungroup_entities', { groupId });

      expect(result.document.groups[groupId]).toBeUndefined();
    });

    it('keeps member entities in the document after ungroup', () => {
      let doc = createEmptyDocument();
      const r1 = execute(doc, 'add_box', { size: [1, 1, 1] });
      doc = r1.document;
      const r2 = execute(doc, 'add_box', { size: [2, 2, 2] });
      doc = r2.document;
      const id1 = r1.affected[0]!;
      const id2 = r2.affected[0]!;
      const grouped = execute(doc, 'group_entities', { ids: [id1, id2] });
      doc = grouped.document;
      const groupId = grouped.affected[0]!;

      const result = execute(doc, 'ungroup_entities', { groupId });

      expect(result.document.entities[id1]).toBeDefined();
      expect(result.document.entities[id2]).toBeDefined();
    });

    it('returns freed member ids in affected', () => {
      let doc = createEmptyDocument();
      const r1 = execute(doc, 'add_box', { size: [1, 1, 1] });
      doc = r1.document;
      const r2 = execute(doc, 'add_box', { size: [2, 2, 2] });
      doc = r2.document;
      const id1 = r1.affected[0]!;
      const id2 = r2.affected[0]!;
      const grouped = execute(doc, 'group_entities', { ids: [id1, id2] });
      doc = grouped.document;
      const groupId = grouped.affected[0]!;

      const result = execute(doc, 'ungroup_entities', { groupId });

      expect(result.affected).toContain(id1);
      expect(result.affected).toContain(id2);
    });

    it('missing groupId is a graceful no-op', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'ungroup_entities', { groupId: 'no-such-group' });

      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('no-such-group');
    });

    it('is pure — input document is not mutated', () => {
      let doc = createEmptyDocument();
      const r1 = execute(doc, 'add_box', { size: [1, 1, 1] });
      doc = r1.document;
      const r2 = execute(doc, 'add_box', { size: [2, 2, 2] });
      doc = r2.document;
      const grouped = execute(doc, 'group_entities', { ids: [r1.affected[0]!, r2.affected[0]!] });
      doc = grouped.document;
      const groupId = grouped.affected[0]!;
      const snapshot = JSON.stringify(doc);

      execute(doc, 'ungroup_entities', { groupId });

      expect(JSON.stringify(doc)).toBe(snapshot);
    });
  });
});

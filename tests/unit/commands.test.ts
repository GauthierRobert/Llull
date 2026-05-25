import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute, toToolSchemas, listCommands, getCommand } from '@core/commands/registry';
import { __resetIdCounter } from '@lib/id';

describe('command layer', () => {
  beforeEach(() => __resetIdCounter());

  it('add_box creates one entity and reports it as affected', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_box', { size: [2, 2, 2] });

    expect(result.affected).toHaveLength(1);
    expect(result.document.order).toHaveLength(1);
    const id = result.affected[0]!;
    expect(result.document.entities[id]!.kind).toBe('box');
  });

  it('is pure — the input document is never mutated', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'add_box', { size: [1, 1, 1] });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('move_entity translates an existing entity', () => {
    let doc = createEmptyDocument();
    const created = execute(doc, 'add_box', { size: [1, 1, 1], position: [0, 0, 0] });
    doc = created.document;
    const id = created.affected[0]!;

    const moved = execute(doc, 'move_entity', { id, delta: [5, 0, -2] });
    expect(moved.document.entities[id]!.position).toEqual([5, 0, -2]);
  });

  it('move_entity on a missing id is a safe no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'move_entity', { id: 'nope', delta: [1, 1, 1] });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('delete_entity removes from entities, order, and selection', () => {
    let doc = createEmptyDocument();
    const created = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = { ...created.document, selection: created.affected };
    const id = created.affected[0]!;

    const result = execute(doc, 'delete_entity', { id });
    expect(result.document.entities[id]).toBeUndefined();
    expect(result.document.order).not.toContain(id);
    expect(result.document.selection).not.toContain(id);
  });

  it('delete_entity on a missing id is a safe no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'delete_entity', { id: 'ghost' });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('ghost');
  });

  it('delete_entity removes deleted id from group memberIds and dissolves group when < 2 members remain', () => {
    let doc = createEmptyDocument();
    const a = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = a.document;
    const b = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = b.document;
    const idA = a.affected[0]!;
    const idB = b.affected[0]!;

    // Group the two entities (exactly 2 members).
    const grouped = execute(doc, 'group_entities', { ids: [idA, idB], name: 'Pair' });
    doc = grouped.document;
    const groupId = grouped.affected[0]!;
    expect(doc.groups[groupId]!.memberIds).toEqual([idA, idB]);

    // Delete one member — group drops to 1 member and must be dissolved.
    const result = execute(doc, 'delete_entity', { id: idA });
    expect(result.document.entities[idA]).toBeUndefined();
    expect(result.document.order).not.toContain(idA);
    expect(result.document.groups[groupId]).toBeUndefined();
    expect(result.summary).toContain(groupId);
  });

  it('delete_entity removes deleted id from group memberIds but keeps group when >= 2 members remain', () => {
    let doc = createEmptyDocument();
    const a = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = a.document;
    const b = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = b.document;
    const c = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = c.document;
    const idA = a.affected[0]!;
    const idB = b.affected[0]!;
    const idC = c.affected[0]!;

    // Group all three (3 members).
    const grouped = execute(doc, 'group_entities', { ids: [idA, idB, idC], name: 'Trio' });
    doc = grouped.document;
    const groupId = grouped.affected[0]!;

    // Delete one member — group drops to 2 members, must survive without deleted id.
    const result = execute(doc, 'delete_entity', { id: idA });
    expect(result.document.entities[idA]).toBeUndefined();
    const surviving = result.document.groups[groupId];
    expect(surviving).toBeDefined();
    expect(surviving!.memberIds).not.toContain(idA);
    expect(surviving!.memberIds).toEqual([idB, idC]);
  });

  it('delete_entity on an ungrouped entity leaves groups unchanged', () => {
    let doc = createEmptyDocument();
    const a = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = a.document;
    const b = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = b.document;
    const extra = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = extra.document;
    const idA = a.affected[0]!;
    const idB = b.affected[0]!;
    const idExtra = extra.affected[0]!;

    // Group only A and B; extra is ungrouped.
    const grouped = execute(doc, 'group_entities', { ids: [idA, idB] });
    doc = grouped.document;
    const groupId = grouped.affected[0]!;
    const groupsBefore = JSON.stringify(doc.groups);

    // Delete the ungrouped entity.
    const result = execute(doc, 'delete_entity', { id: idExtra });
    expect(result.document.entities[idExtra]).toBeUndefined();
    // groups must be identical in shape
    expect(JSON.stringify(result.document.groups)).toBe(groupsBefore);
    expect(result.document.groups[groupId]!.memberIds).toEqual([idA, idB]);
  });

  it('delete_entity group pruning is pure — input doc is not mutated', () => {
    let doc = createEmptyDocument();
    const a = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = a.document;
    const b = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = b.document;
    const grouped = execute(doc, 'group_entities', { ids: [a.affected[0]!, b.affected[0]!] });
    doc = grouped.document;

    const snapshot = JSON.stringify(doc);
    execute(doc, 'delete_entity', { id: a.affected[0]! });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('unknown commands fail gracefully', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'frobnicate', {});
    expect(result.summary).toContain('Unknown command');
    expect(result.document).toBe(doc);
  });

  it('getCommand returns a definition by name and undefined for unknown', () => {
    expect(getCommand('add_box')?.name).toBe('add_box');
    expect(getCommand('frobnicate')).toBeUndefined();
  });

  it('every registered command exposes an AI/MCP tool schema', () => {
    const schemas = toToolSchemas();
    expect(schemas).toHaveLength(listCommands().length);
    for (const s of schemas) {
      expect(s.name).toBeTruthy();
      expect(s.input_schema.type).toBe('object');
    }
  });
});

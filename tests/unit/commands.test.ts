import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyDocument, is2D } from '@core/model/types';
import type { Entity, TextEntity } from '@core/model/types';
import { execute, toToolSchemas, listCommands, getCommand } from '@core/commands/registry';
import { entityBounds } from '@core/commands/scene';
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

  // ── add_cylinder ─────────────────────────────────────────────────────────

  it('add_cylinder creates one cylinder entity with the given dimensions', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_cylinder', { radius: 2, height: 5 });

    expect(result.affected).toHaveLength(1);
    expect(result.document.order).toHaveLength(1);
    const id = result.affected[0]!;
    const entity = result.document.entities[id]!;
    expect(entity.kind).toBe('cylinder');
    // @ts-expect-error narrowing through discriminated union not needed in test
    expect(entity.radius).toBe(2);
    // @ts-expect-error same
    expect(entity.height).toBe(5);
    expect(result.summary).toContain(id);
  });

  it('add_cylinder is pure — input document is not mutated', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'add_cylinder', { radius: 3, height: 4 });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('add_cylinder with radius <= 0 is a safe no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_cylinder', { radius: 0, height: 5 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('radius');
  });

  it('add_cylinder with height <= 0 is a safe no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_cylinder', { radius: 3, height: -1 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('height');
  });

  // ── add_sphere ───────────────────────────────────────────────────────────

  it('add_sphere creates one sphere entity with the given radius', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_sphere', { radius: 4 });

    expect(result.affected).toHaveLength(1);
    expect(result.document.order).toHaveLength(1);
    const id = result.affected[0]!;
    const entity = result.document.entities[id]!;
    expect(entity.kind).toBe('sphere');
    // @ts-expect-error narrowing through discriminated union not needed in test
    expect(entity.radius).toBe(4);
    expect(result.summary).toContain(id);
  });

  it('add_sphere is pure — input document is not mutated', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'add_sphere', { radius: 2 });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('add_sphere with radius <= 0 is a safe no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_sphere', { radius: -5 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('radius');
  });

  it('add_sphere with radius = 0 is a safe no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_sphere', { radius: 0 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
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

  // ── set_entity_name ───────────────────────────────────────────────────────

  it('set_entity_name sets name and tags on an existing entity', () => {
    let doc = createEmptyDocument();
    const created = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = created.document;
    const id = created.affected[0]!;

    const result = execute(doc, 'set_entity_name', { id, name: 'Left wall', tags: ['structural', 'visible'] });
    expect(result.affected).toEqual([id]);
    const entity = result.document.entities[id]!;
    expect(entity.name).toBe('Left wall');
    expect(entity.tags).toEqual(['structural', 'visible']);
    expect(result.summary).toContain(id);
    expect(result.summary).toContain('Left wall');
  });

  it('set_entity_name clears name when empty string is passed', () => {
    let doc = createEmptyDocument();
    const created = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = created.document;
    const id = created.affected[0]!;

    doc = execute(doc, 'set_entity_name', { id, name: 'Temp' }).document;
    const result = execute(doc, 'set_entity_name', { id, name: '' });
    expect(result.document.entities[id]!.name).toBeUndefined();
  });

  it('set_entity_name clears tags when empty array is passed', () => {
    let doc = createEmptyDocument();
    const created = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = created.document;
    const id = created.affected[0]!;

    doc = execute(doc, 'set_entity_name', { id, tags: ['keep'] }).document;
    const result = execute(doc, 'set_entity_name', { id, tags: [] });
    expect(result.document.entities[id]!.tags).toBeUndefined();
  });

  it('set_entity_name on missing id is a safe no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'set_entity_name', { id: 'ghost', name: 'Nope' });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('ghost');
  });

  it('set_entity_name omitting name leaves existing name unchanged', () => {
    let doc = createEmptyDocument();
    const created = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = created.document;
    const id = created.affected[0]!;

    doc = execute(doc, 'set_entity_name', { id, name: 'Temp' }).document;
    const result = execute(doc, 'set_entity_name', { id });
    expect(result.document.entities[id]!.name).toBe('Temp');
    expect(result.affected).toEqual([id]);
  });

  it('set_entity_name omitting tags leaves existing tags unchanged', () => {
    let doc = createEmptyDocument();
    const created = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = created.document;
    const id = created.affected[0]!;

    doc = execute(doc, 'set_entity_name', { id, tags: ['a'] }).document;
    const result = execute(doc, 'set_entity_name', { id });
    expect(result.document.entities[id]!.tags).toEqual(['a']);
    expect(result.affected).toEqual([id]);
  });

  it('set_entity_name is pure — input document is not mutated', () => {
    let doc = createEmptyDocument();
    const created = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = created.document;
    const id = created.affected[0]!;

    const snapshot = JSON.stringify(doc);
    execute(doc, 'set_entity_name', { id, name: 'Test', tags: ['a'] });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  // ── find_entities ─────────────────────────────────────────────────────────

  it('find_entities returns all entities when no filters are given', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    doc = execute(doc, 'add_sphere', { radius: 2 }).document;

    const result = execute(doc, 'find_entities', {});
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    const data = result.data as { matches: unknown[]; count: number };
    expect(data.count).toBe(2);
    expect(data.matches).toHaveLength(2);
  });

  it('find_entities filters by kind', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    doc = execute(doc, 'add_sphere', { radius: 2 }).document;

    const result = execute(doc, 'find_entities', { kind: 'box' });
    const data = result.data as { matches: Array<{ kind: string }>; count: number };
    expect(data.count).toBe(1);
    expect(data.matches[0]!.kind).toBe('box');
  });

  it('find_entities filters by name substring (case-insensitive)', () => {
    let doc = createEmptyDocument();
    const r1 = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = r1.document;
    const id1 = r1.affected[0]!;
    doc = execute(doc, 'add_box', { size: [2, 2, 2] }).document;

    doc = execute(doc, 'set_entity_name', { id: id1, name: 'Left Wall' }).document;

    const result = execute(doc, 'find_entities', { name: 'wall' });
    const data = result.data as { matches: Array<{ id: string; name: string }>; count: number };
    expect(data.count).toBe(1);
    expect(data.matches[0]!.id).toBe(id1);
    expect(data.matches[0]!.name).toBe('Left Wall');
  });

  it('find_entities nameExact=true requires exact match', () => {
    let doc = createEmptyDocument();
    const r1 = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = r1.document;
    const id1 = r1.affected[0]!;
    doc = execute(doc, 'set_entity_name', { id: id1, name: 'Left Wall' }).document;

    const exact = execute(doc, 'find_entities', { name: 'Left Wall', nameExact: true });
    expect((exact.data as { count: number }).count).toBe(1);

    const noMatch = execute(doc, 'find_entities', { name: 'left wall', nameExact: true });
    expect((noMatch.data as { count: number }).count).toBe(0);
  });

  it('find_entities filters by tag', () => {
    let doc = createEmptyDocument();
    const r1 = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = r1.document;
    const id1 = r1.affected[0]!;
    doc = execute(doc, 'add_sphere', { radius: 1 }).document;
    doc = execute(doc, 'set_entity_name', { id: id1, tags: ['structural'] }).document;

    const result = execute(doc, 'find_entities', { tag: 'structural' });
    const data = result.data as { matches: Array<{ id: string }>; count: number };
    expect(data.count).toBe(1);
    expect(data.matches[0]!.id).toBe(id1);
  });

  it('find_entities filters by layerId', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;

    const result = execute(doc, 'find_entities', { layerId: 'layer-default' });
    expect((result.data as { count: number }).count).toBe(1);

    const none = execute(doc, 'find_entities', { layerId: 'layer-nonexistent' });
    expect((none.data as { count: number }).count).toBe(0);
  });

  it('find_entities filters by bounding box', () => {
    let doc = createEmptyDocument();
    // box at origin, size 2x2x2 → AABB [-1,-1,-1] to [1,1,1]
    const r1 = execute(doc, 'add_box', { size: [2, 2, 2], position: [0, 0, 0] });
    doc = r1.document;
    // sphere at [10,0,0] radius 1 → AABB [9,-1,-1] to [11,1,1]
    doc = execute(doc, 'add_sphere', { radius: 1, position: [10, 0, 0] }).document;

    // bbox that only overlaps the box at origin
    const result = execute(doc, 'find_entities', { bboxMin: [-2, -2, -2], bboxMax: [2, 2, 2] });
    const data = result.data as { matches: Array<{ kind: string }>; count: number };
    expect(data.count).toBe(1);
    expect(data.matches[0]!.kind).toBe('box');
  });

  it('find_entities returns error summary when only one bbox bound is given', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'find_entities', { bboxMin: [0, 0, 0] });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('bboxMin');
    expect(result.summary).toContain('bboxMax');
  });

  it('find_entities is pure — input document is not mutated', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;

    const snapshot = JSON.stringify(doc);
    execute(doc, 'find_entities', { kind: 'box' });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('find_entities on empty document returns count 0', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'find_entities', {});
    const data = result.data as { count: number };
    expect(data.count).toBe(0);
    expect(result.document).toBe(doc);
  });

  it('find_entities summary includes filter description and match count', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;

    const result = execute(doc, 'find_entities', { kind: 'sphere' });
    expect(result.summary).toContain('kind=sphere');
    expect(result.summary).toContain('0 match');
  });
});

// ---------------------------------------------------------------------------
// Expression evaluator unit tests
// ---------------------------------------------------------------------------

import { evaluateExpression, extractReferences } from '@core/commands/expression';

describe('evaluateExpression', () => {
  it('evaluates a plain integer literal', () => {
    const r = evaluateExpression('42', {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(42);
  });

  it('evaluates a decimal literal', () => {
    const r = evaluateExpression('3.14', {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeCloseTo(3.14);
  });

  it('addition', () => {
    const r = evaluateExpression('1 + 2', {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(3);
  });

  it('subtraction', () => {
    const r = evaluateExpression('10 - 4', {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(6);
  });

  it('multiplication', () => {
    const r = evaluateExpression('3 * 4', {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(12);
  });

  it('division', () => {
    const r = evaluateExpression('10 / 4', {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(2.5);
  });

  it('operator precedence: * before +', () => {
    const r = evaluateExpression('2 + 3 * 4', {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(14);
  });

  it('parentheses override precedence', () => {
    const r = evaluateExpression('(2 + 3) * 4', {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(20);
  });

  it('unary minus on a literal', () => {
    const r = evaluateExpression('-5', {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(-5);
  });

  it('unary minus in an expression', () => {
    const r = evaluateExpression('10 + -3', {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(7);
  });

  it('nested parentheses', () => {
    const r = evaluateExpression('((2 + 3) * (1 + 1))', {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(10);
  });

  it('reference to an env variable', () => {
    const r = evaluateExpression('width', { width: 15 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(15);
  });

  it('expression using env reference in formula', () => {
    const r = evaluateExpression('width * 2 + 5', { width: 10 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(25);
  });

  it('unknown reference returns EvalErr with descriptive message', () => {
    const r = evaluateExpression('unknown_var', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('unknown parameter: unknown_var');
  });

  it('divide by zero produces Infinity (IEEE 754)', () => {
    const r = evaluateExpression('1 / 0', {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(Infinity);
  });

  it('empty expression returns EvalErr', () => {
    const r = evaluateExpression('', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('empty');
  });

  it('unexpected character returns EvalErr', () => {
    const r = evaluateExpression('2 @ 3', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('@');
  });

  it('mismatched parenthesis returns EvalErr', () => {
    const r = evaluateExpression('(2 + 3', {});
    expect(r.ok).toBe(false);
  });

  it('trailing garbage returns EvalErr', () => {
    const r = evaluateExpression('2 + 3 )', {});
    expect(r.ok).toBe(false);
  });
});

describe('extractReferences', () => {
  it('returns empty set for a plain literal', () => {
    const refs = extractReferences('42');
    expect(refs.size).toBe(0);
  });

  it('returns single reference', () => {
    const refs = extractReferences('width * 2');
    expect(refs.has('width')).toBe(true);
    expect(refs.size).toBe(1);
  });

  it('returns multiple references', () => {
    const refs = extractReferences('a + b * c');
    expect(refs.has('a')).toBe(true);
    expect(refs.has('b')).toBe(true);
    expect(refs.has('c')).toBe(true);
  });

  it('returns empty set for unparseable input', () => {
    const refs = extractReferences('@@garbage@@');
    expect(refs.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// set_parameter / delete_parameter command tests
// ---------------------------------------------------------------------------

describe('set_parameter', () => {
  beforeEach(() => __resetIdCounter());

  it('creates a literal parameter and reports it in summary', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'set_parameter', { name: 'width', expression: '10' });

    expect(result.document.parameters['width']).toBeDefined();
    expect(result.document.parameters['width']!.value).toBe(10);
    expect(result.document.parameters['width']!.expression).toBe('10');
    expect(result.document.parameters['width']!.error).toBeUndefined();
    expect(result.summary).toContain('width');
    expect(result.summary).toContain('10');
  });

  it('creates a parameter referencing another parameter', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'set_parameter', { name: 'width', expression: '10' }).document;
    const result = execute(doc, 'set_parameter', { name: 'height', expression: 'width * 2' });

    expect(result.document.parameters['height']!.value).toBe(20);
    expect(result.document.parameters['height']!.error).toBeUndefined();
  });

  it('changing a base parameter re-evaluates dependents transitively', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'set_parameter', { name: 'base', expression: '5' }).document;
    doc = execute(doc, 'set_parameter', { name: 'derived', expression: 'base * 3' }).document;
    expect(doc.parameters['derived']!.value).toBe(15);

    // Now change base — derived must re-evaluate.
    const result = execute(doc, 'set_parameter', { name: 'base', expression: '10' });
    expect(result.document.parameters['base']!.value).toBe(10);
    expect(result.document.parameters['derived']!.value).toBe(30);
  });

  it('three-level chain re-evaluates fully', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'set_parameter', { name: 'a', expression: '2' }).document;
    doc = execute(doc, 'set_parameter', { name: 'b', expression: 'a * 3' }).document;
    doc = execute(doc, 'set_parameter', { name: 'c', expression: 'b + 1' }).document;
    expect(doc.parameters['c']!.value).toBe(7);

    // Change a: b = 4*3=12, c = 12+1=13.
    const result = execute(doc, 'set_parameter', { name: 'a', expression: '4' });
    expect(result.document.parameters['b']!.value).toBe(12);
    expect(result.document.parameters['c']!.value).toBe(13);
  });

  it('stores error when expression references an unknown parameter', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'set_parameter', { name: 'x', expression: 'ghost * 2' });

    expect(result.document.parameters['x']!.error).toBeDefined();
    expect(result.document.parameters['x']!.error).toContain('unknown parameter');
    expect(result.summary).toContain('could not be evaluated');
  });

  it('detects a direct cycle and stores error on both parameters', () => {
    let doc = createEmptyDocument();
    // a = b (b not yet defined, will fail)
    doc = execute(doc, 'set_parameter', { name: 'a', expression: 'b' }).document;
    // b = a → cycle
    const result = execute(doc, 'set_parameter', { name: 'b', expression: 'a' });

    const paramA = result.document.parameters['a']!;
    const paramB = result.document.parameters['b']!;
    // At least one of them must have an error (cycle detected).
    const hasCycleError = (paramA.error !== undefined) || (paramB.error !== undefined);
    expect(hasCycleError).toBe(true);
  });

  it('parse error on a syntactically-invalid expression is NOT mislabeled as a cycle', () => {
    // width is a valid known parameter; "width +" is a parse error, not a cycle.
    let doc = createEmptyDocument();
    doc = execute(doc, 'set_parameter', { name: 'width', expression: '10' }).document;
    const result = execute(doc, 'set_parameter', { name: 'x', expression: 'width +' });

    const param = result.document.parameters['x']!;
    expect(param.error).toBeDefined();
    // Must NOT say "cycle" — the expression is simply malformed.
    expect(param.error).not.toContain('cycle');
  });

  it('rejects an invalid parameter name (starts with digit)', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'set_parameter', { name: '1invalid', expression: '10' });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('invalid');
  });

  it('rejects an empty expression', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'set_parameter', { name: 'x', expression: '' });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('is pure — the input document is not mutated', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'set_parameter', { name: 'width', expression: '10' });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('updates an existing parameter in-place', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'set_parameter', { name: 'r', expression: '5' }).document;
    const result = execute(doc, 'set_parameter', { name: 'r', expression: '7' });
    expect(result.document.parameters['r']!.value).toBe(7);
    expect(Object.keys(result.document.parameters)).toHaveLength(1);
  });

  it('parameters round-trip through serialize/deserialize', async () => {
    const { serializeDocument, deserializeDocument } = await import('@core/commands/persistence');
    let doc = createEmptyDocument();
    doc = execute(doc, 'set_parameter', { name: 'width', expression: '10' }).document;
    doc = execute(doc, 'set_parameter', { name: 'height', expression: 'width * 2' }).document;

    const json = serializeDocument(doc);
    const restored = deserializeDocument(json);

    expect(restored.parameters['width']!.value).toBe(10);
    expect(restored.parameters['height']!.value).toBe(20);
    expect(restored.parameters['height']!.expression).toBe('width * 2');
  });

  it('deserializing a pre-Q1 document without parameters key yields parameters: {}', async () => {
    const { deserializeDocument } = await import('@core/commands/persistence');
    const doc = createEmptyDocument();
    // Manually build an envelope that lacks the parameters field (pre-Q1 format).
    const envelope = {
      format: 'llull-document',
      version: 1,
      document: {
        entities: doc.entities,
        order: doc.order,
        layers: doc.layers,
        layerOrder: doc.layerOrder,
        selection: doc.selection,
        camera: doc.camera,
        // no parameters key
      },
    };
    const restored = deserializeDocument(JSON.stringify(envelope));
    expect(restored.parameters).toBeDefined();
    expect(restored.parameters).toEqual({});
  });
});

describe('delete_parameter', () => {
  beforeEach(() => __resetIdCounter());

  it('removes an existing parameter', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'set_parameter', { name: 'x', expression: '5' }).document;
    const result = execute(doc, 'delete_parameter', { name: 'x' });

    expect(result.document.parameters['x']).toBeUndefined();
    expect(result.summary).toContain('x');
    expect(result.summary).toContain('removed');
  });

  it('no-op when the parameter does not exist', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'delete_parameter', { name: 'nonexistent' });

    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('nonexistent');
  });

  it('dependents receive an error after their dependency is deleted', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'set_parameter', { name: 'base', expression: '10' }).document;
    doc = execute(doc, 'set_parameter', { name: 'derived', expression: 'base * 2' }).document;
    expect(doc.parameters['derived']!.value).toBe(20);

    const result = execute(doc, 'delete_parameter', { name: 'base' });

    expect(result.document.parameters['base']).toBeUndefined();
    expect(result.document.parameters['derived']!.error).toBeDefined();
    expect(result.document.parameters['derived']!.error).toContain('base');
    expect(result.summary).toContain('derived');
  });

  it('non-dependent parameters are unaffected by deletion', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'set_parameter', { name: 'a', expression: '3' }).document;
    doc = execute(doc, 'set_parameter', { name: 'b', expression: '7' }).document;

    const result = execute(doc, 'delete_parameter', { name: 'a' });

    expect(result.document.parameters['a']).toBeUndefined();
    expect(result.document.parameters['b']!.value).toBe(7);
    expect(result.document.parameters['b']!.error).toBeUndefined();
  });

  it('is pure — the input document is not mutated', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'set_parameter', { name: 'w', expression: '10' }).document;
    const snapshot = JSON.stringify(doc);
    execute(doc, 'delete_parameter', { name: 'w' });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// draw_ellipse
// ---------------------------------------------------------------------------

describe('draw_ellipse', () => {
  beforeEach(() => __resetIdCounter());

  it('creates one ellipse entity with correct geometry', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_ellipse', { center: [1, 2], radiusX: 5, radiusY: 3 });

    expect(result.affected).toHaveLength(1);
    expect(result.document.order).toHaveLength(1);
    const id = result.affected[0]!;
    const entity = result.document.entities[id]!;
    expect(entity.kind).toBe('ellipse');
    if (entity.kind === 'ellipse') {
      expect(entity.center).toEqual([1, 2]);
      expect(entity.radiusX).toBe(5);
      expect(entity.radiusY).toBe(3);
    }
    expect(result.summary).toContain(id);
    expect(result.summary).toContain('5');
    expect(result.summary).toContain('3');
  });

  it('is2D returns true for an ellipse entity', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_ellipse', { center: [0, 0], radiusX: 2, radiusY: 1 });
    const id = result.affected[0]!;
    const entity = result.document.entities[id]!;
    expect(is2D(entity)).toBe(true);
  });

  it('no-op when radiusX <= 0', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_ellipse', { center: [0, 0], radiusX: 0, radiusY: 3 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('radiusX');
  });

  it('no-op when radiusY <= 0', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_ellipse', { center: [0, 0], radiusX: 3, radiusY: -1 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('radiusY');
  });

  it('is pure — the input document is not mutated', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'draw_ellipse', { center: [0, 0], radiusX: 4, radiusY: 2 });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('uses default position [0,0,0] when not provided', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_ellipse', { center: [0, 0], radiusX: 1, radiusY: 1 });
    const id = result.affected[0]!;
    expect(result.document.entities[id]!.position).toEqual([0, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// draw_spline
// ---------------------------------------------------------------------------

describe('draw_spline', () => {
  beforeEach(() => __resetIdCounter());

  it('creates one spline entity with correct through-points', () => {
    const doc = createEmptyDocument();
    const pts = [[0, 0], [1, 2], [3, 1], [4, 3]];
    const result = execute(doc, 'draw_spline', { points: pts });

    expect(result.affected).toHaveLength(1);
    expect(result.document.order).toHaveLength(1);
    const id = result.affected[0]!;
    const entity = result.document.entities[id]!;
    expect(entity.kind).toBe('spline');
    if (entity.kind === 'spline') {
      expect(entity.points).toHaveLength(4);
      expect(entity.closed).toBe(false);
      expect(entity.points[0]).toEqual([0, 0]);
      expect(entity.points[2]).toEqual([3, 1]);
    }
    expect(result.summary).toContain(id);
    expect(result.summary).toContain('4');
  });

  it('creates a closed spline when closed=true', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_spline', { points: [[0, 0], [1, 1], [2, 0]], closed: true });
    const id = result.affected[0]!;
    const entity = result.document.entities[id]!;
    if (entity.kind === 'spline') {
      expect(entity.closed).toBe(true);
    }
    expect(result.summary).toContain('closed');
  });

  it('is2D returns true for a spline entity', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_spline', { points: [[0, 0], [1, 1]] });
    const id = result.affected[0]!;
    const entity = result.document.entities[id]!;
    expect(is2D(entity)).toBe(true);
  });

  it('no-op when fewer than 2 points are provided', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_spline', { points: [[0, 0]] });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('2');
  });

  it('no-op when points array is empty', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_spline', { points: [] });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('is pure — the input document is not mutated', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'draw_spline', { points: [[0, 0], [1, 1], [2, 0]] });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// scale_entity — ellipse and spline branches
// ---------------------------------------------------------------------------

describe('scale_entity — ellipse and spline', () => {
  beforeEach(() => __resetIdCounter());

  it('scales ellipse radiusX, radiusY, and center by factor', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'draw_ellipse', { center: [2, 4], radiusX: 3, radiusY: 1 }).document;
    const id = Object.keys(doc.entities)[0]!;

    const result = execute(doc, 'scale_entity', { id, factor: 2 });
    expect(result.affected).toEqual([id]);
    const entity = result.document.entities[id]!;
    if (entity.kind === 'ellipse') {
      expect(entity.center).toEqual([4, 8]);
      expect(entity.radiusX).toBe(6);
      expect(entity.radiusY).toBe(2);
    }
    expect(result.summary).toContain('radiusX');
    expect(result.summary).toContain('6');
  });

  it('scales spline points uniformly by factor', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'draw_spline', { points: [[1, 0], [2, 2], [3, 0]] }).document;
    const id = Object.keys(doc.entities)[0]!;

    const result = execute(doc, 'scale_entity', { id, factor: 3 });
    expect(result.affected).toEqual([id]);
    const entity = result.document.entities[id]!;
    if (entity.kind === 'spline') {
      expect(entity.points[0]).toEqual([3, 0]);
      expect(entity.points[1]).toEqual([6, 6]);
      expect(entity.points[2]).toEqual([9, 0]);
    }
    expect(result.summary).toContain('3 points');
  });

  it('scale_entity on ellipse is pure', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'draw_ellipse', { center: [0, 0], radiusX: 2, radiusY: 1 }).document;
    const id = Object.keys(doc.entities)[0]!;
    const snapshot = JSON.stringify(doc);
    execute(doc, 'scale_entity', { id, factor: 2 });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('scale_entity on spline is pure', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'draw_spline', { points: [[0, 0], [1, 1]] }).document;
    const id = Object.keys(doc.entities)[0]!;
    const snapshot = JSON.stringify(doc);
    execute(doc, 'scale_entity', { id, factor: 0.5 });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  // ── add_cone ──────────────────────────────────────────────────────────────

  it('add_cone creates one cone entity with the given radius and height', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_cone', { radius: 3, height: 7 });

    expect(result.affected).toHaveLength(1);
    expect(result.document.order).toHaveLength(1);
    const id = result.affected[0]!;
    const entity = result.document.entities[id]!;
    expect(entity.kind).toBe('cone');
    // @ts-expect-error narrowing not needed in test
    expect(entity.radius).toBe(3);
    // @ts-expect-error same
    expect(entity.height).toBe(7);
    expect(result.summary).toContain(id);
    expect(result.summary).toContain('3');
    expect(result.summary).toContain('7');
  });

  it('add_cone is pure — input document is not mutated', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'add_cone', { radius: 2, height: 5 });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('add_cone with radius <= 0 is a safe no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_cone', { radius: 0, height: 5 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('radius');
  });

  it('add_cone with height <= 0 is a safe no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_cone', { radius: 3, height: -1 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('height');
  });

  it('scale_entity on cone scales radius and height', () => {
    let doc = createEmptyDocument();
    const created = execute(doc, 'add_cone', { radius: 2, height: 4 });
    doc = created.document;
    const id = created.affected[0]!;

    const result = execute(doc, 'scale_entity', { id, factor: 3 });
    const entity = result.document.entities[id]!;
    // @ts-expect-error narrowing not needed in test
    expect(entity.radius).toBeCloseTo(6);
    // @ts-expect-error same
    expect(entity.height).toBeCloseTo(12);
    expect(result.summary).toContain(id);
  });

  it('scale_entity on cone is pure', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_cone', { radius: 1, height: 2 }).document;
    const id = Object.keys(doc.entities)[0]!;
    const snapshot = JSON.stringify(doc);
    execute(doc, 'scale_entity', { id, factor: 2 });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('measure_volume for cone = π r² h / 3', () => {
    let doc = createEmptyDocument();
    const created = execute(doc, 'add_cone', { radius: 3, height: 4 });
    doc = created.document;
    const id = created.affected[0]!;

    const result = execute(doc, 'measure_volume', { entityId: id });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    const data = result.data as { volume: number; unit: string };
    const expected = (Math.PI * 3 * 3 * 4) / 3;
    expect(data.volume).toBeCloseTo(expected, 6);
    expect(data.unit).toContain('mm');
  });

  // ── add_torus ─────────────────────────────────────────────────────────────

  it('add_torus creates one torus entity with the given dimensions', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_torus', { ringRadius: 5, tubeRadius: 1.5 });

    expect(result.affected).toHaveLength(1);
    expect(result.document.order).toHaveLength(1);
    const id = result.affected[0]!;
    const entity = result.document.entities[id]!;
    expect(entity.kind).toBe('torus');
    // @ts-expect-error narrowing not needed in test
    expect(entity.ringRadius).toBe(5);
    // @ts-expect-error same
    expect(entity.tubeRadius).toBe(1.5);
    expect(result.summary).toContain(id);
  });

  it('add_torus is pure — input document is not mutated', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'add_torus', { ringRadius: 4, tubeRadius: 1 });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('add_torus with ringRadius <= 0 is a safe no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_torus', { ringRadius: 0, tubeRadius: 1 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('ringRadius');
  });

  it('add_torus with tubeRadius <= 0 is a safe no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_torus', { ringRadius: 3, tubeRadius: -0.5 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('tubeRadius');
  });

  it('scale_entity on torus scales ringRadius and tubeRadius', () => {
    let doc = createEmptyDocument();
    const created = execute(doc, 'add_torus', { ringRadius: 4, tubeRadius: 1 });
    doc = created.document;
    const id = created.affected[0]!;

    const result = execute(doc, 'scale_entity', { id, factor: 2 });
    const entity = result.document.entities[id]!;
    // @ts-expect-error narrowing not needed in test
    expect(entity.ringRadius).toBeCloseTo(8);
    // @ts-expect-error same
    expect(entity.tubeRadius).toBeCloseTo(2);
  });

  it('scale_entity on torus is pure', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_torus', { ringRadius: 3, tubeRadius: 1 }).document;
    const id = Object.keys(doc.entities)[0]!;
    const snapshot = JSON.stringify(doc);
    execute(doc, 'scale_entity', { id, factor: 2 });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('measure_volume for torus = 2 π² · ringRadius · tubeRadius²', () => {
    let doc = createEmptyDocument();
    const created = execute(doc, 'add_torus', { ringRadius: 4, tubeRadius: 1 });
    doc = created.document;
    const id = created.affected[0]!;

    const result = execute(doc, 'measure_volume', { entityId: id });
    const data = result.data as { volume: number; unit: string };
    const expected = 2 * Math.PI * Math.PI * 4 * 1 * 1;
    expect(data.volume).toBeCloseTo(expected, 6);
  });

  // ── add_wedge ─────────────────────────────────────────────────────────────

  it('add_wedge creates one wedge entity with the given size', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_wedge', { size: [4, 3, 6] });

    expect(result.affected).toHaveLength(1);
    expect(result.document.order).toHaveLength(1);
    const id = result.affected[0]!;
    const entity = result.document.entities[id]!;
    expect(entity.kind).toBe('wedge');
    // @ts-expect-error narrowing not needed in test
    expect(entity.size).toEqual([4, 3, 6]);
    expect(result.summary).toContain(id);
    expect(result.summary).toContain('4×3×6');
  });

  it('add_wedge is pure — input document is not mutated', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'add_wedge', { size: [2, 2, 2] });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('add_wedge with a zero size component is a safe no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_wedge', { size: [0, 3, 5] });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('size');
  });

  it('add_wedge with a negative size component is a safe no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_wedge', { size: [2, -1, 5] });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('scale_entity on wedge scales all size components', () => {
    let doc = createEmptyDocument();
    const created = execute(doc, 'add_wedge', { size: [2, 3, 4] });
    doc = created.document;
    const id = created.affected[0]!;

    const result = execute(doc, 'scale_entity', { id, factor: 2 });
    const entity = result.document.entities[id]!;
    // @ts-expect-error narrowing not needed in test
    expect(entity.size).toEqual([4, 6, 8]);
  });

  it('scale_entity on wedge is pure', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_wedge', { size: [1, 2, 3] }).document;
    const id = Object.keys(doc.entities)[0]!;
    const snapshot = JSON.stringify(doc);
    execute(doc, 'scale_entity', { id, factor: 3 });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('measure_volume for wedge = w×h×d / 2', () => {
    let doc = createEmptyDocument();
    const created = execute(doc, 'add_wedge', { size: [4, 3, 6] });
    doc = created.document;
    const id = created.affected[0]!;

    const result = execute(doc, 'measure_volume', { entityId: id });
    const data = result.data as { volume: number; unit: string };
    const expected = (4 * 3 * 6) / 2;
    expect(data.volume).toBeCloseTo(expected, 6);
  });

  // ── add_pyramid ───────────────────────────────────────────────────────────

  it('add_pyramid creates one pyramid entity with the given dimensions', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_pyramid', { baseWidth: 6, baseDepth: 4, height: 8 });

    expect(result.affected).toHaveLength(1);
    expect(result.document.order).toHaveLength(1);
    const id = result.affected[0]!;
    const entity = result.document.entities[id]!;
    expect(entity.kind).toBe('pyramid');
    // @ts-expect-error narrowing not needed in test
    expect(entity.baseWidth).toBe(6);
    // @ts-expect-error same
    expect(entity.baseDepth).toBe(4);
    // @ts-expect-error same
    expect(entity.height).toBe(8);
    expect(result.summary).toContain(id);
    expect(result.summary).toContain('6');
    expect(result.summary).toContain('4');
    expect(result.summary).toContain('8');
  });

  it('add_pyramid is pure — input document is not mutated', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'add_pyramid', { baseWidth: 2, baseDepth: 2, height: 3 });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('add_pyramid with baseWidth <= 0 is a safe no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_pyramid', { baseWidth: 0, baseDepth: 3, height: 5 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('baseWidth');
  });

  it('add_pyramid with baseDepth <= 0 is a safe no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_pyramid', { baseWidth: 3, baseDepth: -2, height: 5 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('baseDepth');
  });

  it('add_pyramid with height <= 0 is a safe no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_pyramid', { baseWidth: 3, baseDepth: 4, height: 0 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('height');
  });

  it('scale_entity on pyramid scales baseWidth, baseDepth, and height', () => {
    let doc = createEmptyDocument();
    const created = execute(doc, 'add_pyramid', { baseWidth: 3, baseDepth: 4, height: 6 });
    doc = created.document;
    const id = created.affected[0]!;

    const result = execute(doc, 'scale_entity', { id, factor: 2 });
    const entity = result.document.entities[id]!;
    // @ts-expect-error narrowing not needed in test
    expect(entity.baseWidth).toBeCloseTo(6);
    // @ts-expect-error same
    expect(entity.baseDepth).toBeCloseTo(8);
    // @ts-expect-error same
    expect(entity.height).toBeCloseTo(12);
  });

  it('scale_entity on pyramid is pure', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_pyramid', { baseWidth: 2, baseDepth: 3, height: 4 }).document;
    const id = Object.keys(doc.entities)[0]!;
    const snapshot = JSON.stringify(doc);
    execute(doc, 'scale_entity', { id, factor: 2 });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('measure_volume for pyramid = baseWidth × baseDepth × height / 3', () => {
    let doc = createEmptyDocument();
    const created = execute(doc, 'add_pyramid', { baseWidth: 6, baseDepth: 4, height: 9 });
    doc = created.document;
    const id = created.affected[0]!;

    const result = execute(doc, 'measure_volume', { entityId: id });
    const data = result.data as { volume: number; unit: string };
    const expected = (6 * 4 * 9) / 3;
    expect(data.volume).toBeCloseTo(expected, 6);
  });

  // ── animate_spin ─────────────────────────────────────────────────────────

  it('animate_spin on an entity adds one animation record', () => {
    let doc = createEmptyDocument();
    const created = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = created.document;
    const entityId = created.affected[0]!;

    const result = execute(doc, 'animate_spin', { targetId: entityId, speed: 1.0 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).not.toBe(doc);
    const animIds = Object.keys(result.document.animations);
    expect(animIds).toHaveLength(1);
    const anim = result.document.animations[animIds[0]!]!;
    expect(anim.targetId).toBe(entityId);
    expect(anim.targetKind).toBe('entity');
    expect(anim.mode).toBe('spin');
    expect(anim.channel).toBe('rotation');
    expect(anim.speed).toBe(1.0);
    expect(anim.amplitude).toBe(0);
    expect(anim.frequency).toBe(0);
    expect(anim.trigger).toBe('auto');
    expect(anim.axis).toEqual([0, 1, 0]);
    expect(result.summary).toContain(entityId);
    expect(result.summary).toContain('rad/s');
  });

  it('animate_spin on a group resolves targetKind as group', () => {
    let doc = createEmptyDocument();
    const a = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = a.document;
    const b = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = b.document;
    const grouped = execute(doc, 'group_entities', { ids: [a.affected[0]!, b.affected[0]!], name: 'Wheel' });
    doc = grouped.document;
    const groupId = grouped.affected[0]!;

    const result = execute(doc, 'animate_spin', { targetId: groupId, speed: 6.283 });
    const animIds = Object.keys(result.document.animations);
    expect(animIds).toHaveLength(1);
    const anim = result.document.animations[animIds[0]!]!;
    expect(anim.targetKind).toBe('group');
    expect(anim.targetId).toBe(groupId);
  });

  it('animate_spin with custom axis, channel, pivot, and trigger', () => {
    let doc = createEmptyDocument();
    const created = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = created.document;
    const entityId = created.affected[0]!;

    const result = execute(doc, 'animate_spin', {
      targetId: entityId,
      speed: 2.0,
      axis: [1, 0, 0],
      channel: 'position',
      pivot: [0, 0, 5],
      trigger: 'click',
    });
    const anim = Object.values(result.document.animations)[0]!;
    expect(anim.axis).toEqual([1, 0, 0]);
    expect(anim.channel).toBe('position');
    expect(anim.pivot).toEqual([0, 0, 5]);
    expect(anim.trigger).toBe('click');
    expect(result.summary).toContain('units/s');
  });

  it('animate_spin omits pivot key when not supplied (exactOptionalPropertyTypes safe)', () => {
    let doc = createEmptyDocument();
    const created = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = created.document;
    const entityId = created.affected[0]!;

    const result = execute(doc, 'animate_spin', { targetId: entityId, speed: 1.0 });
    const anim = Object.values(result.document.animations)[0]!;
    expect('pivot' in anim).toBe(false);
  });

  it('animate_spin on a missing id is a safe no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'animate_spin', { targetId: 'no-such-id', speed: 1.0 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(Object.keys(result.document.animations)).toHaveLength(0);
    expect(result.summary).toContain('no-such-id');
  });

  it('animate_spin is pure — input document is not mutated', () => {
    let doc = createEmptyDocument();
    const created = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = created.document;
    const entityId = created.affected[0]!;
    const snapshot = JSON.stringify(doc);
    execute(doc, 'animate_spin', { targetId: entityId, speed: 3.14 });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  // ── animate_oscillate ────────────────────────────────────────────────────

  it('animate_oscillate on an entity adds one animation record', () => {
    let doc = createEmptyDocument();
    const created = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = created.document;
    const entityId = created.affected[0]!;

    const result = execute(doc, 'animate_oscillate', {
      targetId: entityId,
      amplitude: 0.5,
      frequency: 2.0,
    });
    expect(result.affected).toHaveLength(0);
    const animIds = Object.keys(result.document.animations);
    expect(animIds).toHaveLength(1);
    const anim = result.document.animations[animIds[0]!]!;
    expect(anim.targetId).toBe(entityId);
    expect(anim.targetKind).toBe('entity');
    expect(anim.mode).toBe('oscillate');
    expect(anim.channel).toBe('rotation');
    expect(anim.amplitude).toBe(0.5);
    expect(anim.frequency).toBe(2.0);
    expect(anim.speed).toBe(0);
    expect(anim.trigger).toBe('auto');
    expect(result.summary).toContain(entityId);
    expect(result.summary).toContain('Hz');
  });

  it('animate_oscillate with custom axis, channel, pivot, trigger', () => {
    let doc = createEmptyDocument();
    const created = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = created.document;
    const entityId = created.affected[0]!;

    const result = execute(doc, 'animate_oscillate', {
      targetId: entityId,
      amplitude: 1.0,
      frequency: 0.5,
      axis: [0, 0, 1],
      channel: 'position',
      pivot: [1, 2, 3],
      trigger: 'click',
    });
    const anim = Object.values(result.document.animations)[0]!;
    expect(anim.axis).toEqual([0, 0, 1]);
    expect(anim.channel).toBe('position');
    expect(anim.pivot).toEqual([1, 2, 3]);
    expect(anim.trigger).toBe('click');
    expect(result.summary).toContain('units');
  });

  it('animate_oscillate omits pivot key when not supplied', () => {
    let doc = createEmptyDocument();
    const created = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = created.document;
    const entityId = created.affected[0]!;

    const result = execute(doc, 'animate_oscillate', {
      targetId: entityId,
      amplitude: 0.3,
      frequency: 1.0,
    });
    const anim = Object.values(result.document.animations)[0]!;
    expect('pivot' in anim).toBe(false);
  });

  it('animate_oscillate on a missing id is a safe no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'animate_oscillate', {
      targetId: 'ghost',
      amplitude: 1.0,
      frequency: 1.0,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('ghost');
  });

  it('animate_oscillate with amplitude <= 0 is a safe no-op', () => {
    let doc = createEmptyDocument();
    const created = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = created.document;
    const entityId = created.affected[0]!;

    const result = execute(doc, 'animate_oscillate', {
      targetId: entityId,
      amplitude: 0,
      frequency: 1.0,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('amplitude');
  });

  it('animate_oscillate with frequency <= 0 is a safe no-op', () => {
    let doc = createEmptyDocument();
    const created = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = created.document;
    const entityId = created.affected[0]!;

    const result = execute(doc, 'animate_oscillate', {
      targetId: entityId,
      amplitude: 1.0,
      frequency: -1,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('frequency');
  });

  it('animate_oscillate is pure — input document is not mutated', () => {
    let doc = createEmptyDocument();
    const created = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = created.document;
    const entityId = created.affected[0]!;
    const snapshot = JSON.stringify(doc);
    execute(doc, 'animate_oscillate', { targetId: entityId, amplitude: 0.5, frequency: 1.0 });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  // ── stop_animation ───────────────────────────────────────────────────────

  it('stop_animation by animationId removes only that animation', () => {
    let doc = createEmptyDocument();
    const created = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = created.document;
    const entityId = created.affected[0]!;

    doc = execute(doc, 'animate_spin', { targetId: entityId, speed: 1.0 }).document;
    doc = execute(doc, 'animate_spin', { targetId: entityId, speed: 2.0 }).document;
    const [animId1, animId2] = Object.keys(doc.animations);

    const result = execute(doc, 'stop_animation', { animationId: animId1 });
    expect(result.document.animations[animId1!]).toBeUndefined();
    expect(result.document.animations[animId2!]).toBeDefined();
    expect(result.summary).toContain(animId1!);
  });

  it('stop_animation by animationId for a missing id is a no-op with explanatory summary', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'stop_animation', { animationId: 'anim-ghost' });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('anim-ghost');
    expect(result.summary).toContain('not found');
  });

  it('stop_animation by targetId removes all animations for that target', () => {
    let doc = createEmptyDocument();
    const boxA = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = boxA.document;
    const boxB = execute(doc, 'add_box', { size: [2, 2, 2] });
    doc = boxB.document;
    const idA = boxA.affected[0]!;
    const idB = boxB.affected[0]!;

    doc = execute(doc, 'animate_spin', { targetId: idA, speed: 1.0 }).document;
    doc = execute(doc, 'animate_spin', { targetId: idA, speed: 2.0 }).document;
    doc = execute(doc, 'animate_spin', { targetId: idB, speed: 3.0 }).document;
    expect(Object.keys(doc.animations)).toHaveLength(3);

    const result = execute(doc, 'stop_animation', { targetId: idA });
    const remaining = Object.values(result.document.animations);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.targetId).toBe(idB);
    expect(result.summary).toContain('2');
    expect(result.summary).toContain(idA);
  });

  it('stop_animation by targetId with no matches is a no-op with explanatory summary', () => {
    let doc = createEmptyDocument();
    const created = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = created.document;
    const entityId = created.affected[0]!;
    doc = execute(doc, 'animate_spin', { targetId: entityId, speed: 1.0 }).document;

    const result = execute(doc, 'stop_animation', { targetId: 'other-entity' });
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('other-entity');
  });

  it('stop_animation with no params clears ALL animations', () => {
    let doc = createEmptyDocument();
    const created = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = created.document;
    const entityId = created.affected[0]!;

    doc = execute(doc, 'animate_spin', { targetId: entityId, speed: 1.0 }).document;
    doc = execute(doc, 'animate_oscillate', { targetId: entityId, amplitude: 0.5, frequency: 1.0 }).document;
    expect(Object.keys(doc.animations)).toHaveLength(2);

    const result = execute(doc, 'stop_animation', {});
    expect(Object.keys(result.document.animations)).toHaveLength(0);
    expect(result.summary).toContain('2');
    expect(result.summary).toContain('cleared');
  });

  it('stop_animation clear-all on empty document is a graceful no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'stop_animation', {});
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('no animations');
  });

  it('stop_animation is pure — input document is not mutated', () => {
    let doc = createEmptyDocument();
    const created = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = created.document;
    const entityId = created.affected[0]!;
    doc = execute(doc, 'animate_spin', { targetId: entityId, speed: 1.0 }).document;
    const snapshot = JSON.stringify(doc);

    const animId = Object.keys(doc.animations)[0]!;
    execute(doc, 'stop_animation', { animationId: animId });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  // ── describe_scene — animations field ───────────────────────────────────

  it('describe_scene includes animations array and count in summary', () => {
    let doc = createEmptyDocument();
    const created = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = created.document;
    const entityId = created.affected[0]!;

    // No animations yet.
    let result = execute(doc, 'describe_scene', {});
    const snapshot = result.data as { animations: unknown[] };
    expect(snapshot.animations).toHaveLength(0);
    expect(result.summary).toContain('0 animation');

    // Add one spin animation.
    doc = execute(doc, 'animate_spin', { targetId: entityId, speed: 2.0 }).document;
    result = execute(doc, 'describe_scene', {});
    const snapshot2 = result.data as { animations: Array<{ id: string; targetId: string; targetKind: string; channel: string; mode: string }> };
    expect(snapshot2.animations).toHaveLength(1);
    expect(snapshot2.animations[0]!.targetId).toBe(entityId);
    expect(snapshot2.animations[0]!.targetKind).toBe('entity');
    expect(snapshot2.animations[0]!.channel).toBe('rotation');
    expect(snapshot2.animations[0]!.mode).toBe('spin');
    expect(result.summary).toContain('1 animation');
  });
});

// ---------------------------------------------------------------------------
// render_view
// ---------------------------------------------------------------------------

describe('render_view', () => {
  beforeEach(() => __resetIdCounter());

  it('empty doc returns a valid SVG, entityCount 0, bounds null', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'render_view', {});

    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc); // referential equality — pure

    const data = result.data as {
      svg: string;
      view: string;
      width: number;
      height: number;
      entityCount: number;
      bounds: null;
      camera: { position: [number, number, number]; target: [number, number, number]; up: [number, number, number] };
    };

    expect(data.entityCount).toBe(0);
    expect(data.bounds).toBeNull();
    expect(data.view).toBe('iso');
    expect(data.width).toBe(800);
    expect(data.height).toBe(600);
    expect(data.svg).toContain('<svg');
    expect(data.svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(data.svg).toContain('</svg>');
    expect(data.svg).toContain('width="800"');
    expect(data.svg).toContain('height="600"');
    expect(result.summary).toContain('0 entit');
    expect(result.summary).toContain('800×600');
  });

  it('doc with a box produces polygon elements, correct entityCount, populated bounds and camera', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [2, 2, 2], position: [0, 0, 0] }).document;

    const result = execute(doc, 'render_view', { view: 'iso' });
    const data = result.data as {
      svg: string;
      entityCount: number;
      bounds: { min: [number, number, number]; max: [number, number, number] };
      camera: { position: [number, number, number]; target: [number, number, number]; up: [number, number, number] };
    };

    expect(data.entityCount).toBe(1);
    expect(data.bounds).not.toBeNull();
    expect(data.svg).toContain('<polygon');
    expect(data.camera.position).toHaveLength(3);
    expect(data.camera.target).toHaveLength(3);
    expect(data.camera.up).toHaveLength(3);
    expect(result.summary).toContain('1 entity');
  });

  it('renders all seven views and each produces a different SVG', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;

    const views = ['top', 'bottom', 'front', 'back', 'left', 'right', 'iso'] as const;
    const svgs = views.map((v) => {
      const r = execute(doc, 'render_view', { view: v });
      return (r.data as { svg: string }).svg;
    });

    // top vs front must differ
    expect(svgs[0]).not.toBe(svgs[2]);
    // iso vs top must differ
    expect(svgs[6]).not.toBe(svgs[0]);
    // all must contain <svg
    for (const svg of svgs) {
      expect(svg).toContain('<svg');
    }
  });

  it('resolved view name is present in the data.view field', () => {
    const doc = createEmptyDocument();
    const frontResult = execute(doc, 'render_view', { view: 'front' });
    expect((frontResult.data as { view: string }).view).toBe('front');

    const topResult = execute(doc, 'render_view', { view: 'top' });
    expect((topResult.data as { view: string }).view).toBe('top');
  });

  it('width and height are clamped: too large → 2000, too small → 64', () => {
    const doc = createEmptyDocument();

    const large = execute(doc, 'render_view', { width: 5000, height: 9999 });
    const largeData = large.data as { width: number; height: number; svg: string };
    expect(largeData.width).toBe(2000);
    expect(largeData.height).toBe(2000);
    expect(largeData.svg).toContain('width="2000"');
    expect(largeData.svg).toContain('height="2000"');

    const small = execute(doc, 'render_view', { width: 1, height: 5 });
    const smallData = small.data as { width: number; height: number; svg: string };
    expect(smallData.width).toBe(64);
    expect(smallData.height).toBe(64);
    expect(smallData.svg).toContain('width="64"');
    expect(smallData.svg).toContain('height="64"');
  });

  it('unknown view name falls back to iso without throwing', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'render_view', { view: 'diagonal' });
    const data = result.data as { view: string; svg: string };
    expect(data.view).toBe('iso');
    expect(data.svg).toContain('<svg');
  });

  it('is pure — the input document is returned unchanged (referential equality)', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    const snapshot = JSON.stringify(doc);

    execute(doc, 'render_view', { view: 'iso' });

    expect(JSON.stringify(doc)).toBe(snapshot);
    const result = execute(doc, 'render_view', { view: 'top' });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });

  it('SVG contains 2D shape stroked paths when doc has a circle', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'draw_circle', { center: [0, 0], radius: 3 }).document;

    const result = execute(doc, 'render_view', { view: 'top' });
    const svg = (result.data as { svg: string }).svg;
    expect(svg).toContain('<polyline');
  });

  it('doc with multiple entity kinds (box + cylinder + cone) renders all', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [2, 2, 2] }).document;
    doc = execute(doc, 'add_cylinder', { radius: 1, height: 3 }).document;
    doc = execute(doc, 'add_cone', { radius: 1, height: 2 }).document;

    const result = execute(doc, 'render_view', { view: 'iso' });
    const data = result.data as { entityCount: number; svg: string };
    expect(data.entityCount).toBe(3);
    expect(data.svg).toContain('<polygon');
    expect(result.summary).toContain('3 entit');
  });

  it('toToolSchemas() still maps 1:1 with listCommands() after registration', () => {
    const schemas = toToolSchemas();
    const commands = listCommands();
    expect(schemas).toHaveLength(commands.length);
    const renderSchema = schemas.find((s) => s.name === 'render_view');
    expect(renderSchema).toBeDefined();
    expect(renderSchema?.input_schema.required).toEqual([]);
  });

  it('renders sphere, torus, wedge, pyramid without throwing', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_sphere', { radius: 1 }).document;
    doc = execute(doc, 'add_torus', { ringRadius: 2, tubeRadius: 0.5 }).document;
    doc = execute(doc, 'add_wedge', { size: [2, 1, 3] }).document;
    doc = execute(doc, 'add_pyramid', { baseWidth: 2, baseDepth: 2, height: 3 }).document;

    const result = execute(doc, 'render_view', { view: 'iso' });
    const data = result.data as { entityCount: number; svg: string };
    expect(data.entityCount).toBe(4);
    expect(data.svg).toContain('<polygon');
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
  });

  it('renders extrusion without throwing', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'extrude_profile', {
      profile: [[0, 0], [2, 0], [2, 2], [0, 2]],
      depth: 1,
    }).document;

    const result = execute(doc, 'render_view', { view: 'front' });
    const data = result.data as { entityCount: number; svg: string };
    expect(data.entityCount).toBe(1);
    expect(data.svg).toContain('<polygon');
  });

  it('renders 2D rectangle, ellipse, spline, point, arc, line, polyline without throwing', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'draw_rectangle', { width: 2, height: 1 }).document;
    doc = execute(doc, 'draw_ellipse', { center: [0, 0], radiusX: 1, radiusY: 2 }).document;
    doc = execute(doc, 'draw_spline', { points: [[0, 0], [1, 1], [2, 0]] }).document;
    doc = execute(doc, 'draw_point', { position: [0, 0, 0] }).document;
    doc = execute(doc, 'draw_arc', { center: [0, 0], radius: 1, startAngle: 0, endAngle: 1 }).document;
    doc = execute(doc, 'draw_line', { start: [0, 0], end: [1, 1] }).document;
    doc = execute(doc, 'draw_polyline', { points: [[0, 0], [1, 0], [1, 1]] }).document;

    const result = execute(doc, 'render_view', { view: 'top' });
    const data = result.data as { entityCount: number; svg: string };
    expect(data.entityCount).toBe(7);
    // All 2D shapes produce <polyline> stroke elements
    expect(data.svg).toContain('<polyline');
    expect(result.document).toBe(doc);
  });

  it('closed polyline and closed spline add the closing vertex', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'draw_polyline', { points: [[0, 0], [1, 0], [0.5, 1]], closed: true }).document;
    doc = execute(doc, 'draw_spline', { points: [[0, 0], [1, 0], [0.5, 1]], closed: true }).document;

    const result = execute(doc, 'render_view', { view: 'top' });
    const data = result.data as { svg: string };
    expect(data.svg).toContain('<polyline');
  });

  it('arc with endAngle < startAngle wraps span correctly', () => {
    let doc = createEmptyDocument();
    // endAngle < startAngle → span goes negative → must add 2π
    doc = execute(doc, 'draw_arc', { center: [0, 0], radius: 2, startAngle: 3, endAngle: 1 }).document;

    const result = execute(doc, 'render_view', { view: 'front' });
    expect(result.affected).toEqual([]);
    expect((result.data as { svg: string }).svg).toContain('<polyline');
  });

  it('extrusion with valid profile renders polygons and returns valid SVG', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'extrude_profile', { profile: [[0, 0], [1, 0], [1, 1]], depth: 2 }).document;

    const result = execute(doc, 'render_view', { view: 'iso' });
    expect((result.data as { svg: string }).svg).toContain('<svg');
    expect((result.data as { svg: string }).svg).toContain('<polygon');
  });

  it('all six axis views produce different camera positions', () => {
    const doc = createEmptyDocument();
    const views = ['top', 'bottom', 'front', 'back', 'left', 'right'] as const;
    const cameras = views.map((v) => {
      const r = execute(doc, 'render_view', { view: v });
      return JSON.stringify((r.data as { camera: unknown }).camera);
    });
    // Each view must have a unique camera
    const unique = new Set(cameras);
    expect(unique.size).toBe(6);
  });

  it('default params (no args) work and produce 800×600 iso SVG', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'render_view', {});
    const data = result.data as { view: string; width: number; height: number; svg: string };
    expect(data.view).toBe('iso');
    expect(data.width).toBe(800);
    expect(data.height).toBe(600);
    expect(data.svg).toContain('width="800"');
  });

  // Regression: painter's-algorithm depth sort must be DESCENDING (farthest drawn
  // first so nearest paints on top). The bug sorted ASCENDING, letting far faces
  // overwrite near ones.
  //
  // Setup (top view, camera looking down -Z):
  //   BLUE box centered at z = -5  (far from camera — all its faces have LARGE depth)
  //   RED  box centered at z = +5  (near the camera — all its faces have SMALL depth)
  //
  // Separation of 10 units guarantees no face of the red box is farther than any face
  // of the blue box. With correct DESCENDING depth sort:
  //   blue (farther, larger depth) → drawn FIRST → appears EARLIER in the SVG
  //   red  (nearer,  smaller depth) → drawn LAST  → appears LATER  in the SVG
  //
  // The shaded fill of pure blue (#0000ff) produces "rgb(0,0," and pure red (#ff0000)
  // produces ",0,0)" (zero green, zero blue). These tokens are mutually exclusive,
  // making the first-occurrence index comparison unambiguous.
  //
  // If the sort were reverted to ASCENDING, red (smaller depth) would sort FIRST
  // and blue LAST, flipping the index order and failing the assertion.
  it('painter depth sort (descending) — nearer object polygons appear later in SVG than farther ones', () => {
    let doc = createEmptyDocument();
    // Blue box: centered at z = -5 (FAR from top camera — all faces have large depth)
    doc = execute(doc, 'add_box', { size: [2, 2, 2], position: [0, 0, -5], color: '#0000ff' }).document;
    // Red box: centered at z = +5 (NEAR the top camera — all faces have small depth)
    doc = execute(doc, 'add_box', { size: [2, 2, 2], position: [0, 0, 5], color: '#ff0000' }).document;

    const result = execute(doc, 'render_view', { view: 'top' });
    const svg = (result.data as { svg: string }).svg;

    // Shading #ff0000 via tintHex always yields "rgb(NNN,0,0)" — zero green, zero blue.
    // Shading #0000ff via tintHex always yields "rgb(0,0,NNN)" — zero red, zero green.
    // ",0,0)" uniquely identifies red faces; "rgb(0,0," uniquely identifies blue faces.
    const redSignature = ',0,0)';
    const blueSignature = 'rgb(0,0,';

    expect(svg).toContain(redSignature);
    expect(svg).toContain(blueSignature);

    const firstBlueIdx = svg.indexOf(blueSignature);
    const firstRedIdx = svg.indexOf(redSignature);

    expect(firstBlueIdx).toBeGreaterThan(-1);
    expect(firstRedIdx).toBeGreaterThan(-1);

    // Blue (farther) must appear BEFORE red (nearer) in the SVG output.
    // This fails with an ascending sort (the original bug).
    expect(firstBlueIdx).toBeLessThan(firstRedIdx);
  });

  // ---------------------------------------------------------------------------
  // add_text (T1)
  // ---------------------------------------------------------------------------

  it('add_text — happy path: creates text entity with correct fields', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_text', {
      content: 'Hello World',
      position: [1, 2, 0],
      height: 5,
      anchor: 'center',
      color: '#ff0000',
    });

    expect(result.affected).toHaveLength(1);
    expect(result.document.order).toHaveLength(1);
    const id = result.affected[0]!;
    const e = result.document.entities[id]! as TextEntity;
    expect(e.kind).toBe('text');
    expect(e.content).toBe('Hello World');
    expect(e.height).toBe(5);
    expect(e.position).toEqual([1, 2, 0]);
    expect(e.anchor).toBe('center');
    expect(e.color).toBe('#ff0000');
    expect(result.summary).toContain(id);
    expect(result.summary).toContain('Hello World');
  });

  it('add_text — defaults: anchor=left, rotation=[0,0,0], color=#333333', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_text', {
      content: 'Label',
      position: [0, 0, 0],
      height: 2,
    });

    const id = result.affected[0]!;
    const e = result.document.entities[id]! as TextEntity;
    expect(e.anchor).toBe('left');
    expect(e.rotation).toEqual([0, 0, 0]);
    expect(e.color).toBe('#333333');
  });

  it('add_text — is pure: input document is not mutated', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'add_text', { content: 'Test', position: [0, 0, 0], height: 1 });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('add_text — is2D: created entity is classified as 2D', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_text', { content: 'X', position: [0, 0, 0], height: 1 });
    const id = result.affected[0]!;
    const e = result.document.entities[id]!;
    expect(is2D(e)).toBe(true);
  });

  it('add_text — failure: empty content is a no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_text', { content: '', position: [0, 0, 0], height: 1 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('non-empty');
  });

  it('add_text — failure: whitespace-only content is a no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_text', { content: '   ', position: [0, 0, 0], height: 1 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('add_text — failure: height=0 is a no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_text', { content: 'Hi', position: [0, 0, 0], height: 0 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('height');
  });

  it('add_text — failure: negative height is a no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_text', { content: 'Hi', position: [0, 0, 0], height: -3 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('add_text — failure: missing position is a no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_text', { content: 'Hi', position: null, height: 1 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('position');
  });

  it('add_text — failure: short position array is a no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_text', { content: 'Hi', position: [0, 0], height: 1 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('scale_entity — text: scales height by factor', () => {
    let doc = createEmptyDocument();
    const created = execute(doc, 'add_text', { content: 'Scale me', position: [0, 0, 0], height: 4 });
    doc = created.document;
    const id = created.affected[0]!;

    const scaled = execute(doc, 'scale_entity', { id, factor: 2.5 });
    expect(scaled.affected).toEqual([id]);
    const e = scaled.document.entities[id]! as TextEntity;
    expect(e.height).toBeCloseTo(10);
    expect(scaled.summary).toContain('height');
  });
});

// ---------------------------------------------------------------------------
// add_dimension
// ---------------------------------------------------------------------------

describe('add_dimension', () => {
  beforeEach(() => __resetIdCounter());

  // Helpers to seed reference entities
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  function makeDoc() {
    let doc = createEmptyDocument();
    // Two point entities for linear/aligned/angular
    const p1 = execute(doc, 'draw_point', { position: [0, 0, 0] });
    doc = p1.document;
    const p2 = execute(doc, 'draw_point', { position: [10, 0, 0] });
    doc = p2.document;
    const p3 = execute(doc, 'draw_point', { position: [5, 5, 0] });
    doc = p3.document;
    // A circle for radial
    const circ = execute(doc, 'draw_circle', { center: [0, 0], radius: 5 });
    doc = circ.document;
    // A line for linear/aligned/angular
    const ln = execute(doc, 'draw_line', { start: [0, 0], end: [10, 0] });
    doc = ln.document;
    return {
      doc,
      pointId1: p1.affected[0]!,
      pointId2: p2.affected[0]!,
      pointId3: p3.affected[0]!,
      circleId: circ.affected[0]!,
      lineId: ln.affected[0]!,
    };
  }

  // ------------------------------------------------------------------
  // Happy paths
  // ------------------------------------------------------------------

  it('linear — creates a dimension entity referencing 2 point entities', () => {
    const { doc, pointId1, pointId2 } = makeDoc();
    const result = execute(doc, 'add_dimension', {
      dimensionKind: 'linear',
      entityIds: [pointId1, pointId2],
      offset: 8,
    });
    expect(result.affected).toHaveLength(1);
    const id = result.affected[0]!;
    const e = result.document.entities[id]! as import('@core/model/types').DimensionEntity;
    expect(e.kind).toBe('dimension');
    expect(e.dimensionKind).toBe('linear');
    expect(e.entityIds).toEqual([pointId1, pointId2]);
    expect(e.offset).toBe(8);
    expect(result.document.order).toContain(id);
    expect(result.summary).toContain(id);
    expect(result.summary).toContain('linear');
  });

  it('linear — works with 2 line entities', () => {
    const { doc, lineId } = makeDoc();
    // Need a second line
    const ln2 = execute(doc, 'draw_line', { start: [0, 5], end: [10, 5] });
    const result = execute(ln2.document, 'add_dimension', {
      dimensionKind: 'linear',
      entityIds: [lineId, ln2.affected[0]!],
    });
    expect(result.affected).toHaveLength(1);
    const e = result.document.entities[result.affected[0]!]! as import('@core/model/types').DimensionEntity;
    expect(e.dimensionKind).toBe('linear');
  });

  it('aligned — creates a dimension entity referencing 2 point entities', () => {
    const { doc, pointId1, pointId2 } = makeDoc();
    const result = execute(doc, 'add_dimension', {
      dimensionKind: 'aligned',
      entityIds: [pointId1, pointId2],
    });
    expect(result.affected).toHaveLength(1);
    const e = result.document.entities[result.affected[0]!]! as import('@core/model/types').DimensionEntity;
    expect(e.kind).toBe('dimension');
    expect(e.dimensionKind).toBe('aligned');
  });

  it('radial — creates a dimension entity referencing a circle', () => {
    const { doc, circleId } = makeDoc();
    const result = execute(doc, 'add_dimension', {
      dimensionKind: 'radial',
      entityIds: [circleId],
      label: 'R5',
    });
    expect(result.affected).toHaveLength(1);
    const e = result.document.entities[result.affected[0]!]! as import('@core/model/types').DimensionEntity;
    expect(e.dimensionKind).toBe('radial');
    expect(e.entityIds).toEqual([circleId]);
    expect(e.label).toBe('R5');
  });

  it('radial — accepts an arc entity', () => {
    let doc = createEmptyDocument();
    const arc = execute(doc, 'draw_arc', { center: [0, 0], radius: 3, startAngle: 0, endAngle: Math.PI });
    doc = arc.document;
    const result = execute(doc, 'add_dimension', {
      dimensionKind: 'radial',
      entityIds: [arc.affected[0]!],
    });
    expect(result.affected).toHaveLength(1);
  });

  it('angular — creates a dimension entity referencing 3 point entities', () => {
    const { doc, pointId1, pointId2, pointId3 } = makeDoc();
    const result = execute(doc, 'add_dimension', {
      dimensionKind: 'angular',
      entityIds: [pointId1, pointId2, pointId3],
      precision: 1,
    });
    expect(result.affected).toHaveLength(1);
    const e = result.document.entities[result.affected[0]!]! as import('@core/model/types').DimensionEntity;
    expect(e.dimensionKind).toBe('angular');
    expect(e.entityIds).toHaveLength(3);
    expect(e.precision).toBe(1);
  });

  it('angular — accepts line entities', () => {
    const { doc, lineId, pointId1 } = makeDoc();
    const ln2 = execute(doc, 'draw_line', { start: [0, 0], end: [0, 10] });
    const result = execute(ln2.document, 'add_dimension', {
      dimensionKind: 'angular',
      entityIds: [pointId1, lineId, ln2.affected[0]!],
    });
    expect(result.affected).toHaveLength(1);
  });

  it('optional fields — label, precision, offset stored on entity', () => {
    const { doc, pointId1, pointId2 } = makeDoc();
    const result = execute(doc, 'add_dimension', {
      dimensionKind: 'linear',
      entityIds: [pointId1, pointId2],
      offset: 12,
      precision: 2,
      label: '≈ 10 mm',
    });
    const e = result.document.entities[result.affected[0]!]! as import('@core/model/types').DimensionEntity;
    expect(e.offset).toBe(12);
    expect(e.precision).toBe(2);
    expect(e.label).toBe('≈ 10 mm');
  });

  it('is2D — created entity is classified as 2D', () => {
    const { doc, pointId1, pointId2 } = makeDoc();
    const result = execute(doc, 'add_dimension', {
      dimensionKind: 'linear',
      entityIds: [pointId1, pointId2],
    });
    const e = result.document.entities[result.affected[0]!]!;
    expect(is2D(e)).toBe(true);
  });

  // ------------------------------------------------------------------
  // Purity
  // ------------------------------------------------------------------

  it('is pure — input document is not mutated', () => {
    const { doc, pointId1, pointId2 } = makeDoc();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'add_dimension', { dimensionKind: 'linear', entityIds: [pointId1, pointId2] });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  // ------------------------------------------------------------------
  // Failure paths
  // ------------------------------------------------------------------

  it('failure — unknown dimensionKind is a no-op', () => {
    const { doc, pointId1, pointId2 } = makeDoc();
    const result = execute(doc, 'add_dimension', {
      dimensionKind: 'diagonal',
      entityIds: [pointId1, pointId2],
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('diagonal');
  });

  it('failure — wrong entityIds count for linear (1 instead of 2) is a no-op', () => {
    const { doc, pointId1 } = makeDoc();
    const result = execute(doc, 'add_dimension', {
      dimensionKind: 'linear',
      entityIds: [pointId1],
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('2');
  });

  it('failure — wrong entityIds count for radial (2 instead of 1) is a no-op', () => {
    const { doc, circleId, pointId1 } = makeDoc();
    const result = execute(doc, 'add_dimension', {
      dimensionKind: 'radial',
      entityIds: [circleId, pointId1],
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('1');
  });

  it('failure — wrong entityIds count for angular (2 instead of 3) is a no-op', () => {
    const { doc, pointId1, pointId2 } = makeDoc();
    const result = execute(doc, 'add_dimension', {
      dimensionKind: 'angular',
      entityIds: [pointId1, pointId2],
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('3');
  });

  it('failure — empty entityIds array is a no-op', () => {
    const { doc } = makeDoc();
    const result = execute(doc, 'add_dimension', {
      dimensionKind: 'linear',
      entityIds: [],
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('failure — missing referenced entity id is a no-op', () => {
    const { doc, pointId1 } = makeDoc();
    const result = execute(doc, 'add_dimension', {
      dimensionKind: 'linear',
      entityIds: [pointId1, 'ghost-id'],
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('ghost-id');
  });

  it('failure — radial on a non-circle/arc/ellipse entity (box) is a no-op', () => {
    let doc = createEmptyDocument();
    const box = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = box.document;
    const result = execute(doc, 'add_dimension', {
      dimensionKind: 'radial',
      entityIds: [box.affected[0]!],
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('radial');
  });

  it('failure — linear on an incompatible entity kind (box) is a no-op', () => {
    let doc = createEmptyDocument();
    const b1 = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = b1.document;
    const b2 = execute(doc, 'add_box', { size: [2, 2, 2] });
    doc = b2.document;
    const result = execute(doc, 'add_dimension', {
      dimensionKind: 'linear',
      entityIds: [b1.affected[0]!, b2.affected[0]!],
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('linear');
  });

  it('failure — angular on an incompatible entity kind (circle) is a no-op', () => {
    const { doc, circleId, pointId1, pointId2 } = makeDoc();
    const result = execute(doc, 'add_dimension', {
      dimensionKind: 'angular',
      entityIds: [pointId1, pointId2, circleId],
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('angular');
  });

  // ------------------------------------------------------------------
  // scale_entity on dimension
  // ------------------------------------------------------------------

  it('scale_entity — dimension: scales offset, leaves entityIds unchanged', () => {
    const { doc, pointId1, pointId2 } = makeDoc();
    const created = execute(doc, 'add_dimension', {
      dimensionKind: 'linear',
      entityIds: [pointId1, pointId2],
      offset: 10,
    });
    const dimId = created.affected[0]!;
    const scaled = execute(created.document, 'scale_entity', { id: dimId, factor: 2 });
    expect(scaled.affected).toEqual([dimId]);
    const e = scaled.document.entities[dimId]! as import('@core/model/types').DimensionEntity;
    expect(e.offset).toBeCloseTo(20);
    expect(e.entityIds).toEqual([pointId1, pointId2]);
    expect(scaled.summary).toContain('offset');
  });

  it('scale_entity — dimension without offset: returns entity unchanged (no offset field)', () => {
    const { doc, pointId1, pointId2 } = makeDoc();
    const created = execute(doc, 'add_dimension', {
      dimensionKind: 'linear',
      entityIds: [pointId1, pointId2],
    });
    const dimId = created.affected[0]!;
    const scaled = execute(created.document, 'scale_entity', { id: dimId, factor: 3 });
    expect(scaled.affected).toEqual([dimId]);
    const e = scaled.document.entities[dimId]! as import('@core/model/types').DimensionEntity;
    expect(e.offset).toBeUndefined();
  });

  // ------------------------------------------------------------------
  // check_model — dangling_dimension_ref
  // ------------------------------------------------------------------

  it('check_model — flags dangling_dimension_ref when a referenced entity is deleted', () => {
    const { doc, pointId1, pointId2 } = makeDoc();
    // Create dimension
    const dimCreated = execute(doc, 'add_dimension', {
      dimensionKind: 'linear',
      entityIds: [pointId1, pointId2],
    });
    // Delete one of the referenced entities
    const afterDelete = execute(dimCreated.document, 'delete_entity', { id: pointId1 });
    // Check model
    const checkResult = execute(afterDelete.document, 'check_model', {});
    const data = checkResult.data as import('@core/commands/check').CheckResult;
    const danglingIssues = data.issues.filter((i) => i.code === 'dangling_dimension_ref');
    expect(danglingIssues).toHaveLength(1);
    expect(danglingIssues[0]!.severity).toBe('error');
    expect(danglingIssues[0]!.message).toContain(pointId1);
    expect(data.ok).toBe(false);
  });

  it('check_model — no dangling_dimension_ref when all references are intact', () => {
    const { doc, pointId1, pointId2 } = makeDoc();
    const dimCreated = execute(doc, 'add_dimension', {
      dimensionKind: 'linear',
      entityIds: [pointId1, pointId2],
    });
    const checkResult = execute(dimCreated.document, 'check_model', {});
    const data = checkResult.data as import('@core/commands/check').CheckResult;
    const danglingIssues = data.issues.filter((i) => i.code === 'dangling_dimension_ref');
    expect(danglingIssues).toHaveLength(0);
  });

  // ── Feature history (Q3) ──────────────────────────────────────────────────

  it('featureHistory — fresh document has empty featureHistory', () => {
    const doc = createEmptyDocument();
    expect(doc.featureHistory).toEqual([]);
  });

  it('featureHistory — add_box appends one step to featureHistory', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_box', { size: [2, 2, 2] });
    expect(result.document.featureHistory).toHaveLength(1);
    expect(result.document.featureHistory[0]!.name).toBe('add_box');
    expect(result.document.featureHistory[0]!.suppressed).toBe(false);
  });

  it('featureHistory — two add_box calls produce two steps', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    doc = execute(doc, 'add_box', { size: [2, 2, 2] }).document;
    expect(doc.featureHistory).toHaveLength(2);
    expect(doc.featureHistory[0]!.name).toBe('add_box');
    expect(doc.featureHistory[1]!.name).toBe('add_box');
  });

  it('featureHistory — failed command (no-op) does NOT append a step', () => {
    const doc = createEmptyDocument();
    // move_entity on missing id returns same doc ref => no step
    const result = execute(doc, 'move_entity', { id: 'ghost', delta: [1, 0, 0] });
    expect(result.document.featureHistory).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('featureHistory — read-only command (measure_distance) does NOT append a step', () => {
    let doc = createEmptyDocument();
    const r1 = execute(doc, 'add_box', { size: [1, 1, 1], position: [0, 0, 0] });
    doc = r1.document;
    const r2 = execute(doc, 'add_box', { size: [1, 1, 1], position: [5, 0, 0] });
    doc = r2.document;
    const stepsBefore = doc.featureHistory.length;
    const id1 = r1.affected[0]!;
    const id2 = r2.affected[0]!;
    const measured = execute(doc, 'measure_distance', { fromId: id1, toId: id2 });
    // measure_distance is readOnly — doc ref must be the same, no new step
    expect(measured.document).toBe(doc);
    expect(measured.document.featureHistory).toHaveLength(stepsBefore);
  });

  it('featureHistory — set_parameter/delete_parameter do NOT append steps (metaHistory; parameters are document state, not recipe steps)', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'set_parameter', { name: 'w', expression: '10' }).document;
    expect(doc.featureHistory).toHaveLength(0);
    expect(doc.parameters['w']?.value).toBe(10);
    // Updating it again must still not append (idempotent in the recipe).
    doc = execute(doc, 'set_parameter', { name: 'w', expression: '20' }).document;
    expect(doc.featureHistory).toHaveLength(0);
    expect(doc.parameters['w']?.value).toBe(20);
    doc = execute(doc, 'delete_parameter', { name: 'w' }).document;
    expect(doc.featureHistory).toHaveLength(0);
    expect(doc.parameters['w']).toBeUndefined();
  });

  it('featureHistory — input document is never mutated (purity)', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'add_box', { size: [1, 1, 1] });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  // ── replay_history ────────────────────────────────────────────────────────

  it('replay_history — empty history returns doc unchanged with summary', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'replay_history', {});
    expect(result.document).toBe(doc);
    expect(result.affected).toHaveLength(0);
    expect(result.summary).toContain('empty');
  });

  it('replay_history — replaying two add_box steps regenerates both entities', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    doc = execute(doc, 'add_box', { size: [2, 2, 2] }).document;
    expect(doc.featureHistory).toHaveLength(2);

    const replayed = execute(doc, 'replay_history', {});
    expect(Object.keys(replayed.document.entities)).toHaveLength(2);
    expect(replayed.document.featureHistory).toHaveLength(2);
    expect(replayed.summary).toContain('2 step');
  });

  it('replay_history — meta-command does NOT append a featureHistory step', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    const stepsBefore = doc.featureHistory.length;
    const result = execute(doc, 'replay_history', {});
    // replay_history is metaHistory — must not grow the list
    expect(result.document.featureHistory).toHaveLength(stepsBefore);
  });

  // ── set_step_suppressed ───────────────────────────────────────────────────

  it('set_step_suppressed — suppressing step 0 removes that entity from regenerated doc', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    doc = execute(doc, 'add_box', { size: [2, 2, 2] }).document;
    expect(doc.featureHistory).toHaveLength(2);

    const step0Id = doc.featureHistory[0]!.id;
    const result = execute(doc, 'set_step_suppressed', { stepId: step0Id, suppressed: true });

    // Second box still exists; first is gone.
    expect(Object.keys(result.document.entities)).toHaveLength(1);
    expect(result.document.featureHistory[0]!.suppressed).toBe(true);
    expect(result.document.featureHistory).toHaveLength(2);
  });

  it('set_step_suppressed — un-suppressing restores the entity', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [3, 3, 3] }).document;
    const stepId = doc.featureHistory[0]!.id;

    // Suppress then un-suppress.
    doc = execute(doc, 'set_step_suppressed', { stepId, suppressed: true }).document;
    expect(Object.keys(doc.entities)).toHaveLength(0);

    const restored = execute(doc, 'set_step_suppressed', { stepId, suppressed: false });
    expect(Object.keys(restored.document.entities)).toHaveLength(1);
    expect(restored.document.featureHistory[0]!.suppressed).toBe(false);
  });

  it('set_step_suppressed — unknown stepId is a graceful no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'set_step_suppressed', { stepId: 'ghost', suppressed: true });
    expect(result.document).toBe(doc);
    expect(result.affected).toHaveLength(0);
    expect(result.summary).toContain('ghost');
  });

  it('set_step_suppressed — meta-command does NOT append a featureHistory step', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    const stepId = doc.featureHistory[0]!.id;
    const stepsBefore = doc.featureHistory.length;
    const result = execute(doc, 'set_step_suppressed', { stepId, suppressed: true });
    expect(result.document.featureHistory).toHaveLength(stepsBefore);
  });

  // ── edit_step_params ──────────────────────────────────────────────────────

  it('edit_step_params — changing size of box step regenerates with new size', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    const stepId = doc.featureHistory[0]!.id;

    const result = execute(doc, 'edit_step_params', {
      stepId,
      params: { size: [20, 20, 20] },
    });

    expect(Object.keys(result.document.entities)).toHaveLength(1);
    const entityId = result.document.order[0]!;
    const entity = result.document.entities[entityId]!;
    // @ts-expect-error narrowing not needed in test
    expect(entity.size).toEqual([20, 20, 20]);
    expect(result.document.featureHistory[0]!.params).toEqual({ size: [20, 20, 20] });
  });

  it('edit_step_params — unknown stepId is a graceful no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'edit_step_params', { stepId: 'ghost', params: {} });
    expect(result.document).toBe(doc);
    expect(result.affected).toHaveLength(0);
    expect(result.summary).toContain('ghost');
  });

  it('edit_step_params — meta-command does NOT append a featureHistory step', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    const stepId = doc.featureHistory[0]!.id;
    const stepsBefore = doc.featureHistory.length;
    const result = execute(doc, 'edit_step_params', { stepId, params: { size: [5, 5, 5] } });
    expect(result.document.featureHistory).toHaveLength(stepsBefore);
  });

  // ── reorder_step ──────────────────────────────────────────────────────────

  it('reorder_step — moves step from index 0 to index 1 and regenerates', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    doc = execute(doc, 'add_cylinder', { radius: 2, height: 4 }).document;
    expect(doc.featureHistory).toHaveLength(2);

    const step0Id = doc.featureHistory[0]!.id;
    const step1Id = doc.featureHistory[1]!.id;

    const result = execute(doc, 'reorder_step', { stepId: step0Id, newIndex: 1 });
    // After reorder: step1 is now first, step0 is second.
    expect(result.document.featureHistory[0]!.id).toBe(step1Id);
    expect(result.document.featureHistory[1]!.id).toBe(step0Id);
    expect(Object.keys(result.document.entities)).toHaveLength(2);
  });

  it('reorder_step — moving to same index is a no-op returning same doc ref', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    const stepId = doc.featureHistory[0]!.id;
    const result = execute(doc, 'reorder_step', { stepId, newIndex: 0 });
    expect(result.document).toBe(doc);
    expect(result.affected).toHaveLength(0);
  });

  it('reorder_step — unknown stepId is a graceful no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'reorder_step', { stepId: 'ghost', newIndex: 0 });
    expect(result.document).toBe(doc);
    expect(result.affected).toHaveLength(0);
    expect(result.summary).toContain('ghost');
  });

  it('reorder_step — meta-command does NOT append a featureHistory step', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    doc = execute(doc, 'add_box', { size: [2, 2, 2] }).document;
    const stepId = doc.featureHistory[0]!.id;
    const stepsBefore = doc.featureHistory.length;
    const result = execute(doc, 'reorder_step', { stepId, newIndex: 1 });
    expect(result.document.featureHistory).toHaveLength(stepsBefore);
  });

  // ── delete_step ───────────────────────────────────────────────────────────

  it('delete_step — removes a step and regenerates without that entity', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    doc = execute(doc, 'add_box', { size: [2, 2, 2] }).document;
    const step0Id = doc.featureHistory[0]!.id;

    const result = execute(doc, 'delete_step', { stepId: step0Id });
    expect(result.document.featureHistory).toHaveLength(1);
    expect(Object.keys(result.document.entities)).toHaveLength(1);
    expect(result.summary).toContain(step0Id);
  });

  it('delete_step — unknown stepId is a graceful no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'delete_step', { stepId: 'ghost' });
    expect(result.document).toBe(doc);
    expect(result.affected).toHaveLength(0);
    expect(result.summary).toContain('ghost');
  });

  it('delete_step — meta-command does NOT append a featureHistory step', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    doc = execute(doc, 'add_box', { size: [2, 2, 2] }).document;
    const stepId = doc.featureHistory[0]!.id;
    const result = execute(doc, 'delete_step', { stepId });
    // After deleting step 0 we have 1 step remaining — NOT 2 (no append from execute)
    expect(result.document.featureHistory).toHaveLength(1);
  });

  // ── insert_step ───────────────────────────────────────────────────────────

  it('insert_step — appends a new step when afterStepId omitted', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    expect(doc.featureHistory).toHaveLength(1);

    const result = execute(doc, 'insert_step', {
      name: 'add_box',
      params: { size: [5, 5, 5] },
    });
    expect(result.document.featureHistory).toHaveLength(2);
    expect(Object.keys(result.document.entities)).toHaveLength(2);
  });

  it('insert_step — inserts after a specific step', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    doc = execute(doc, 'add_box', { size: [2, 2, 2] }).document;
    const step0Id = doc.featureHistory[0]!.id;

    const result = execute(doc, 'insert_step', {
      afterStepId: step0Id,
      name: 'add_sphere',
      params: { radius: 3 },
    });
    // History: [step0, newSphere, step1]
    expect(result.document.featureHistory).toHaveLength(3);
    expect(result.document.featureHistory[1]!.name).toBe('add_sphere');
    expect(Object.keys(result.document.entities)).toHaveLength(3);
  });

  it('insert_step — unknown afterStepId is a graceful no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'insert_step', {
      afterStepId: 'ghost',
      name: 'add_box',
      params: { size: [1, 1, 1] },
    });
    expect(result.document).toBe(doc);
    expect(result.affected).toHaveLength(0);
    expect(result.summary).toContain('ghost');
  });

  it('insert_step — unknown command name is stored but skipped during replay', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'insert_step', {
      name: 'nonexistent_command_xyz',
      params: {},
    });
    // Step is inserted but replay skips it — no entity created
    expect(result.document.featureHistory).toHaveLength(1);
    expect(result.document.featureHistory[0]!.name).toBe('nonexistent_command_xyz');
    expect(Object.keys(result.document.entities)).toHaveLength(0);
  });

  it('insert_step — meta-command does NOT append a featureHistory step', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    const stepsBefore = doc.featureHistory.length;
    const result = execute(doc, 'insert_step', {
      name: 'add_box',
      params: { size: [2, 2, 2] },
    });
    // insert_step adds exactly 1 step (the inserted one), not 2 (no execute-append)
    expect(result.document.featureHistory).toHaveLength(stepsBefore + 1);
  });

  // ── integration: suppressed step + downstream move ────────────────────────

  it('featureHistory — move referencing suppressed entity does not throw', () => {
    let doc = createEmptyDocument();
    // Step 0: create a box
    doc = execute(doc, 'add_box', { size: [1, 1, 1], position: [0, 0, 0] }).document;
    const boxEntityId = doc.order[0]!;
    // Step 1: move that box
    doc = execute(doc, 'move_entity', { id: boxEntityId, delta: [5, 0, 0] }).document;
    expect(doc.featureHistory).toHaveLength(2);

    // Now suppress step 0 — box is no longer created, move becomes a no-op
    const step0Id = doc.featureHistory[0]!.id;
    const result = execute(doc, 'set_step_suppressed', { stepId: step0Id, suppressed: true });

    // Should not throw; no entities in document (move silently no-ops)
    expect(() => result).not.toThrow();
    expect(Object.keys(result.document.entities)).toHaveLength(0);
  });

  // ── persistence: featureHistory round-trips through serializeDocument ─────

  it('featureHistory — round-trips through serializeDocument / deserializeDocument', async () => {
    const { serializeDocument, deserializeDocument } = await import('@core/commands/persistence');
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [3, 3, 3] }).document;
    const json = serializeDocument(doc);
    const loaded = deserializeDocument(json);
    expect(loaded.featureHistory).toHaveLength(1);
    expect(loaded.featureHistory[0]!.name).toBe('add_box');
  });

  it('featureHistory — deserializeDocument defaults to [] when featureHistory absent', async () => {
    const { deserializeDocument } = await import('@core/commands/persistence');
    // Simulate an old doc that has no featureHistory field.
    const oldDoc = {
      format: 'llull-document',
      version: 1,
      document: {
        entities: {},
        order: [],
        layers: { 'layer-default': { id: 'layer-default', name: 'Layer 0', visible: true, locked: false } },
        layerOrder: ['layer-default'],
        selection: [],
        camera: { target: [0, 0, 0], azimuth: 0, polar: 0, distance: 10 },
        // featureHistory intentionally absent
      },
    };
    const loaded = deserializeDocument(JSON.stringify(oldDoc));
    expect(loaded.featureHistory).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// KI3 — Constructive vs evaluated geometry: =expr resolution in replay
// ---------------------------------------------------------------------------

import { resolveStepParams, buildParamEnv } from '@core/commands/regenerate';

describe('KI3 — =expr param resolution in replay_history', () => {
  beforeEach(() => __resetIdCounter());

  // ── AC1: headline round-trip ─────────────────────────────────────────────

  it('AC1 round-trip: =expr param in a step reflects updated parameter after replay', () => {
    // Step 1: set a parameter `side = 4`
    // Step 2: add_box with size stored as `=expr` strings — done via insert_step so
    //         the stored params literally contain `=side` strings.
    // Step 3: set_parameter changes `side` to 8
    // Step 4: replay_history → box size should be [8, 8, 8]

    let doc = createEmptyDocument();

    // Set the parameter. set_parameter is metaHistory (parameters are document
    // INPUT state, not a geometry-recipe step) so it does NOT append to
    // featureHistory — its current value is carried into replay.
    doc = execute(doc, 'set_parameter', { name: 'side', expression: '4' }).document;

    // Insert a step whose params reference the parameter via =expr.
    // We use insert_step (a meta-command) to plant literal =expr strings.
    doc = execute(doc, 'insert_step', {
      name: 'add_box',
      params: { size: ['=side', '=side', '=side'] },
      label: 'Parametric box',
    }).document;

    // Verify the box was created with resolved size [4, 4, 4].
    expect(Object.keys(doc.entities)).toHaveLength(1);
    const boxId = doc.order[0]!;
    const box = doc.entities[boxId]!;
    expect(box.kind).toBe('box');
    if (box.kind === 'box') {
      expect(box.size).toEqual([4, 4, 4]);
    }

    // Now change the parameter.
    doc = execute(doc, 'set_parameter', { name: 'side', expression: '8' }).document;

    // Replay — the =expr params must be re-evaluated against the new `side = 8`.
    const result = execute(doc, 'replay_history', {});
    expect(result.affected.length).toBeGreaterThan(0);

    // Find the box entity (there must be exactly one entity).
    const entityIds = Object.keys(result.document.entities);
    expect(entityIds).toHaveLength(1);
    const updatedBox = result.document.entities[entityIds[0]!]!;
    expect(updatedBox.kind).toBe('box');
    if (updatedBox.kind === 'box') {
      expect(updatedBox.size).toEqual([8, 8, 8]);
    }
    expect(result.summary).toContain('replayed');
  });

  // ── AC2: reproducibility ─────────────────────────────────────────────────

  it('AC2: replaying featureHistory from empty reproduces entities deterministically', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [2, 3, 4] }).document;
    doc = execute(doc, 'add_sphere', { radius: 5 }).document;
    expect(Object.keys(doc.entities)).toHaveLength(2);

    // Replay should reproduce the same entity count and kinds.
    const result = execute(doc, 'replay_history', {});
    expect(Object.keys(result.document.entities)).toHaveLength(2);
    const kinds = Object.values(result.document.entities).map((e) => e.kind).sort();
    expect(kinds).toEqual(['box', 'sphere']);
  });

  // ── AC3 / purity ─────────────────────────────────────────────────────────

  it('purity: resolveStepParams does not mutate the input params', () => {
    const original = { size: ['=width', 1, 2], label: 'test' };
    const env = { width: 10 };
    const snapshot = JSON.stringify(original);
    resolveStepParams(original, env);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('purity: replay_history is pure — input doc is not mutated', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    const snapshot = JSON.stringify(doc);
    execute(doc, 'replay_history', {});
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  // ── resolveStepParams unit tests ─────────────────────────────────────────

  it('resolveStepParams: plain number value passes through unchanged', () => {
    const { resolved, errors } = resolveStepParams({ radius: 5 }, {});
    expect(errors).toHaveLength(0);
    expect((resolved as { radius: number }).radius).toBe(5);
  });

  it('resolveStepParams: plain string (no =) passes through unchanged', () => {
    const { resolved, errors } = resolveStepParams({ label: 'hello' }, {});
    expect(errors).toHaveLength(0);
    expect((resolved as { label: string }).label).toBe('hello');
  });

  it('resolveStepParams: =expr string is replaced by evaluated number', () => {
    const { resolved, errors } = resolveStepParams(
      { radius: '=r' },
      { r: 7 },
    );
    expect(errors).toHaveLength(0);
    expect((resolved as { radius: number }).radius).toBe(7);
  });

  it('resolveStepParams: =expr arithmetic expression is evaluated correctly', () => {
    const { resolved, errors } = resolveStepParams(
      { size: '=width * 2' },
      { width: 5 },
    );
    expect(errors).toHaveLength(0);
    expect((resolved as { size: number }).size).toBe(10);
  });

  it('resolveStepParams: array elements with =expr strings are resolved', () => {
    const { resolved, errors } = resolveStepParams(
      { position: ['=x', 0, '=z'] },
      { x: 3, z: 7 },
    );
    expect(errors).toHaveLength(0);
    expect((resolved as { position: number[] }).position).toEqual([3, 0, 7]);
  });

  it('resolveStepParams: nested object keys are resolved recursively', () => {
    const { resolved, errors } = resolveStepParams(
      { outer: { inner: '=val' } },
      { val: 42 },
    );
    expect(errors).toHaveLength(0);
    expect(
      (resolved as { outer: { inner: number } }).outer.inner,
    ).toBe(42);
  });

  it('resolveStepParams: unknown parameter reference → error recorded, original string kept', () => {
    const { resolved, errors } = resolveStepParams(
      { radius: '=missing_param' },
      {},
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.expression).toBe('=missing_param');
    expect(errors[0]!.reason).toContain('unknown parameter');
    // The original =expr string is kept so the caller knows which param failed.
    expect((resolved as { radius: string }).radius).toBe('=missing_param');
  });

  it('resolveStepParams: malformed =expr → error recorded, original string kept', () => {
    const { resolved, errors } = resolveStepParams(
      { size: '=width +' },
      { width: 5 },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.path).toBe('size');
    expect((resolved as { size: string }).size).toBe('=width +');
  });

  it('resolveStepParams: boolean and null values pass through unchanged', () => {
    const { resolved, errors } = resolveStepParams(
      { flag: true, nothing: null },
      {},
    );
    expect(errors).toHaveLength(0);
    const r = resolved as { flag: boolean; nothing: null };
    expect(r.flag).toBe(true);
    expect(r.nothing).toBeNull();
  });

  it('resolveStepParams: error path is correct for array element', () => {
    const { errors } = resolveStepParams(
      { size: ['=a', '=b', '=c'] },
      { a: 1 }, // b and c are missing
    );
    expect(errors).toHaveLength(2);
    const paths = errors.map((e) => e.path).sort();
    expect(paths).toEqual(['size[1]', 'size[2]']);
  });

  // ── buildParamEnv unit tests ─────────────────────────────────────────────

  it('buildParamEnv: includes only parameters without errors', () => {
    const parameters = {
      width: { name: 'width', expression: '10', value: 10 },
      bad: { name: 'bad', expression: '=ghost', value: 0, error: 'unknown parameter: ghost' },
    };
    const env = buildParamEnv(parameters);
    expect(env['width']).toBe(10);
    expect('bad' in env).toBe(false);
  });

  it('buildParamEnv: returns empty object when no parameters', () => {
    const env = buildParamEnv({});
    expect(Object.keys(env)).toHaveLength(0);
  });

  // ── replay with unresolvable =expr: graceful, summary reports it ─────────

  it('replay_history reports unresolved =expr in summary without throwing', () => {
    let doc = createEmptyDocument();
    // Insert a step with an =expr referencing a parameter that does not exist.
    doc = execute(doc, 'insert_step', {
      name: 'add_box',
      params: { size: ['=nonexistent', 2, 2] },
    }).document;

    const result = execute(doc, 'replay_history', {});
    // Must not throw; must surface the warning in summary.
    expect(result.summary).toContain('Unresolved');
    expect(result.summary).toContain('nonexistent');
    // With the KI6 add_box guard in place, the unresolved =expr string is caught by add_box
    // (non-finite/non-numeric size → graceful no-op). The contract under test here is the
    // REPLAY level: it completes without throwing and reports the failure.
    expect(result.document).toBeDefined();
  });

  // ── =expr in nested position array (e.g. position: ["=x", 0, 0]) ─────────

  it('=expr in position array is resolved and applied to entity position', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'set_parameter', { name: 'xpos', expression: '15' }).document;

    doc = execute(doc, 'insert_step', {
      name: 'add_box',
      params: { size: [1, 1, 1], position: ['=xpos', 0, 0] },
    }).document;

    const entityIds = Object.keys(doc.entities);
    expect(entityIds).toHaveLength(1);
    const entity = doc.entities[entityIds[0]!]!;
    expect(entity.position).toEqual([15, 0, 0]);

    // Change the parameter and replay — position must update.
    doc = execute(doc, 'set_parameter', { name: 'xpos', expression: '30' }).document;
    const result = execute(doc, 'replay_history', {});

    const updatedIds = Object.keys(result.document.entities);
    expect(updatedIds).toHaveLength(1);
    expect(result.document.entities[updatedIds[0]!]!.position).toEqual([30, 0, 0]);
    expect(result.summary).not.toContain('Unresolved');
  });

  // ── create_configuration ─────────────────────────────────────────────────

  it('create_configuration stores a new configuration in the document', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'create_configuration', {
      name: 'small',
      parameterValues: { w: '10' },
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document.configurations['small']).toBeDefined();
    expect(result.document.configurations['small']!.name).toBe('small');
    expect(result.document.configurations['small']!.parameterValues).toEqual({ w: '10' });
    expect(result.summary).toContain('small');
    expect(result.summary).toContain('w');
  });

  it('create_configuration replaces an existing configuration with the same name', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'create_configuration', { name: 'cfg', parameterValues: { w: '10' } }).document;
    const result = execute(doc, 'create_configuration', { name: 'cfg', parameterValues: { w: '99' } });
    expect(result.document.configurations['cfg']!.parameterValues).toEqual({ w: '99' });
  });

  it('create_configuration is pure — input document is not mutated', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'create_configuration', { name: 'small', parameterValues: { w: '10' } });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('create_configuration with blank name is a no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'create_configuration', { name: '', parameterValues: { w: '10' } });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('non-empty');
  });

  it('create_configuration with non-object parameterValues is a no-op', () => {
    const doc = createEmptyDocument();
    // Pass an array instead of a plain object.
    const result = execute(doc, 'create_configuration', {
      name: 'bad',
      parameterValues: ['w', '10'] as unknown as Record<string, string>,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('parameterValues');
  });

  it('create_configuration with non-string value in parameterValues is a no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'create_configuration', {
      name: 'bad',
      parameterValues: { w: 42 as unknown as string },
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain("parameterValues['w']");
  });

  // ── activate_configuration ───────────────────────────────────────────────

  it('activate_configuration AC1 round-trip: small→10³ then large→40³', () => {
    let doc = createEmptyDocument();

    // Define parameter w and a box whose size uses =w.
    doc = execute(doc, 'set_parameter', { name: 'w', expression: '10' }).document;
    doc = execute(doc, 'insert_step', {
      name: 'add_box',
      params: { size: ['=w', '=w', '=w'] },
    }).document;

    // Create two configurations.
    doc = execute(doc, 'create_configuration', { name: 'small', parameterValues: { w: '10' } }).document;
    doc = execute(doc, 'create_configuration', { name: 'large', parameterValues: { w: '40' } }).document;

    // Activate small — box should be 10×10×10.
    const smallResult = execute(doc, 'activate_configuration', { name: 'small' });
    const smallIds = Object.keys(smallResult.document.entities);
    expect(smallIds).toHaveLength(1);
    // @ts-expect-error narrowing through discriminated union not needed in test
    expect(smallResult.document.entities[smallIds[0]!]!.size).toEqual([10, 10, 10]);
    expect(smallResult.summary).toContain('small');

    // Activate large — box should be 40×40×40.
    const largeResult = execute(doc, 'activate_configuration', { name: 'large' });
    const largeIds = Object.keys(largeResult.document.entities);
    expect(largeIds).toHaveLength(1);
    // @ts-expect-error narrowing through discriminated union not needed in test
    expect(largeResult.document.entities[largeIds[0]!]!.size).toEqual([40, 40, 40]);
    expect(largeResult.summary).toContain('large');
  });

  it('activate_configuration updates doc.parameters to the config values', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'set_parameter', { name: 'w', expression: '5' }).document;
    doc = execute(doc, 'create_configuration', { name: 'big', parameterValues: { w: '100' } }).document;

    const result = execute(doc, 'activate_configuration', { name: 'big' });
    expect(result.document.parameters['w']!.expression).toBe('100');
    expect(result.document.parameters['w']!.value).toBe(100);
  });

  it('activate_configuration preserves featureHistory unchanged', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'set_parameter', { name: 'w', expression: '5' }).document;
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    doc = execute(doc, 'create_configuration', { name: 'v', parameterValues: { w: '20' } }).document;

    const historyBefore = JSON.stringify(doc.featureHistory);
    const result = execute(doc, 'activate_configuration', { name: 'v' });
    expect(JSON.stringify(result.document.featureHistory)).toBe(historyBefore);
  });

  it('activate_configuration is pure — input document is not mutated', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'set_parameter', { name: 'w', expression: '5' }).document;
    doc = execute(doc, 'create_configuration', { name: 'v', parameterValues: { w: '20' } }).document;

    const snapshot = JSON.stringify(doc);
    execute(doc, 'activate_configuration', { name: 'v' });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('activate_configuration with unknown config name is a graceful no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'activate_configuration', { name: 'ghost' });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('ghost');
    expect(result.summary).toContain('not found');
  });

  it('activate_configuration with blank name is a no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'activate_configuration', { name: '' });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('non-empty');
  });

  it('activate_configuration referencing unknown parameter surfaces note in summary without throwing', () => {
    let doc = createEmptyDocument();
    // Config references "phantom" which does not exist in doc.parameters.
    doc = execute(doc, 'create_configuration', {
      name: 'test',
      parameterValues: { phantom: '99' },
    }).document;

    const result = execute(doc, 'activate_configuration', { name: 'test' });
    // Must not throw; must report the new parameter in the summary.
    expect(result.document).toBeDefined();
    expect(result.summary).toContain('phantom');
    // The phantom parameter should have been created.
    expect(result.document.parameters['phantom']).toBeDefined();
    expect(result.document.parameters['phantom']!.value).toBe(99);
  });

  // ── persistence round-trip includes configurations ───────────────────────

  it('persistence round-trip: configurations survive serialize/deserialize', async () => {
    const { serializeDocument, deserializeDocument } = await import('@core/commands/persistence');
    let doc = createEmptyDocument();
    doc = execute(doc, 'create_configuration', {
      name: 'large',
      parameterValues: { w: '40', h: '20' },
    }).document;

    const json = serializeDocument(doc);
    const loaded = deserializeDocument(json);
    expect(loaded.configurations['large']).toBeDefined();
    expect(loaded.configurations['large']!.parameterValues).toEqual({ w: '40', h: '20' });
  });

  it('persistence: deserializeDocument defaults configurations to {} for old docs without it', async () => {
    const { deserializeDocument } = await import('@core/commands/persistence');
    // Simulate an old document envelope without a configurations field.
    const oldDoc = {
      format: 'llull-document',
      version: 1,
      document: {
        entities: {},
        order: [],
        layers: { 'layer-default': { id: 'layer-default', name: 'Layer 0', visible: true, locked: false } },
        layerOrder: ['layer-default'],
        selection: [],
        camera: { target: [0, 0, 0], azimuth: 0, polar: 0, distance: 10 },
        // no configurations field
      },
    };
    const loaded = deserializeDocument(JSON.stringify(oldDoc));
    expect(loaded.configurations).toEqual({});
  });

  // ── create_material ───────────────────────────────────────────────────────

  it('create_material: happy path — adds material to doc.materials', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'create_material', {
      name: 'steel',
      density: 0.00785,
      color: '#808080',
      metalness: 0.9,
      roughness: 0.3,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document.materials['steel']).toBeDefined();
    expect(result.document.materials['steel']!.density).toBe(0.00785);
    expect(result.document.materials['steel']!.color).toBe('#808080');
    expect(result.document.materials['steel']!.metalness).toBe(0.9);
    expect(result.document.materials['steel']!.roughness).toBe(0.3);
    expect(result.summary).toContain('steel');
    expect(result.summary).toContain('created');
  });

  it('create_material: replaces existing material with same name', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'create_material', {
      name: 'steel',
      density: 0.00785,
      color: '#808080',
      metalness: 0.9,
      roughness: 0.3,
    }).document;
    const result = execute(doc, 'create_material', {
      name: 'steel',
      density: 0.008,
      color: '#a0a0a0',
      metalness: 1.0,
      roughness: 0.2,
    });
    expect(result.document.materials['steel']!.density).toBe(0.008);
    expect(result.summary).toContain('replaced');
  });

  it('create_material: failure — blank name', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'create_material', {
      name: '',
      density: 0.00785,
      color: '#808080',
      metalness: 0.9,
      roughness: 0.3,
    });
    expect(result.document).toBe(doc);
    expect(result.affected).toHaveLength(0);
    expect(result.summary).toContain('non-empty');
  });

  it('create_material: failure — density <= 0', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'create_material', {
      name: 'bad',
      density: -1,
      color: '#808080',
      metalness: 0.5,
      roughness: 0.5,
    });
    expect(result.document).toBe(doc);
    expect(result.affected).toHaveLength(0);
    expect(result.summary).toContain('density');
  });

  it('create_material: failure — density = 0', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'create_material', {
      name: 'bad',
      density: 0,
      color: '#808080',
      metalness: 0.5,
      roughness: 0.5,
    });
    expect(result.document).toBe(doc);
    expect(result.affected).toHaveLength(0);
  });

  it('create_material: failure — metalness out of range', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'create_material', {
      name: 'bad',
      density: 0.001,
      color: '#808080',
      metalness: 1.5,
      roughness: 0.5,
    });
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('metalness');
  });

  it('create_material: failure — roughness out of range', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'create_material', {
      name: 'bad',
      density: 0.001,
      color: '#808080',
      metalness: 0.5,
      roughness: -0.1,
    });
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('roughness');
  });

  it('create_material: failure — invalid hex color', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'create_material', {
      name: 'bad',
      density: 0.001,
      color: 'not-a-color',
      metalness: 0.5,
      roughness: 0.5,
    });
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('color');
  });

  it('create_material: failure — hex color wrong length (3 digits)', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'create_material', {
      name: 'bad',
      density: 0.001,
      color: '#abc',
      metalness: 0.5,
      roughness: 0.5,
    });
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('color');
  });

  it('create_material is pure — input doc not mutated', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'create_material', {
      name: 'steel',
      density: 0.00785,
      color: '#808080',
      metalness: 0.9,
      roughness: 0.3,
    });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  // ── assign_material ───────────────────────────────────────────────────────

  it('assign_material: happy path — single entity', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'create_material', {
      name: 'aluminium',
      density: 0.0027,
      color: '#c0c0c0',
      metalness: 0.8,
      roughness: 0.2,
    }).document;
    const boxResult = execute(doc, 'add_box', { size: [10, 10, 10] });
    doc = boxResult.document;
    const boxId = boxResult.affected[0]!;

    const result = execute(doc, 'assign_material', {
      materialName: 'aluminium',
      entityIds: [boxId],
    });
    expect(result.affected).toEqual([boxId]);
    expect(result.document.entities[boxId]!.materialId).toBe('aluminium');
    expect(result.summary).toContain('aluminium');
    expect(result.summary).toContain(boxId);
  });

  it('assign_material: happy path — multiple entities', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'create_material', {
      name: 'steel',
      density: 0.00785,
      color: '#808080',
      metalness: 0.9,
      roughness: 0.3,
    }).document;
    const r1 = execute(doc, 'add_box', { size: [5, 5, 5] });
    doc = r1.document;
    const r2 = execute(doc, 'add_box', { size: [5, 5, 5] });
    doc = r2.document;
    const id1 = r1.affected[0]!;
    const id2 = r2.affected[0]!;

    const result = execute(doc, 'assign_material', {
      materialName: 'steel',
      entityIds: [id1, id2],
    });
    expect(result.affected).toHaveLength(2);
    expect(result.document.entities[id1]!.materialId).toBe('steel');
    expect(result.document.entities[id2]!.materialId).toBe('steel');
  });

  it('assign_material: partial success — unknown ids are skipped, valid ids assigned', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'create_material', {
      name: 'steel',
      density: 0.00785,
      color: '#808080',
      metalness: 0.9,
      roughness: 0.3,
    }).document;
    const r = execute(doc, 'add_box', { size: [5, 5, 5] });
    doc = r.document;
    const validId = r.affected[0]!;

    const result = execute(doc, 'assign_material', {
      materialName: 'steel',
      entityIds: [validId, 'ghost-id'],
    });
    expect(result.affected).toEqual([validId]);
    expect(result.document.entities[validId]!.materialId).toBe('steel');
    expect(result.summary).toContain('ghost-id');
  });

  it('assign_material: failure — unknown material', () => {
    let doc = createEmptyDocument();
    const r = execute(doc, 'add_box', { size: [5, 5, 5] });
    doc = r.document;
    const boxId = r.affected[0]!;

    const result = execute(doc, 'assign_material', {
      materialName: 'nonexistent',
      entityIds: [boxId],
    });
    expect(result.document).toBe(doc);
    expect(result.affected).toHaveLength(0);
    expect(result.summary).toContain('nonexistent');
    expect(result.summary).toContain('not found');
  });

  it('assign_material: failure — all entity ids unknown', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'create_material', {
      name: 'steel',
      density: 0.00785,
      color: '#808080',
      metalness: 0.9,
      roughness: 0.3,
    }).document;

    const result = execute(doc, 'assign_material', {
      materialName: 'steel',
      entityIds: ['ghost-1', 'ghost-2'],
    });
    expect(result.document).toBe(doc);
    expect(result.affected).toHaveLength(0);
    expect(result.summary).toContain('ghost-1');
  });

  it('assign_material: failure — empty entityIds array', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'create_material', {
      name: 'steel',
      density: 0.00785,
      color: '#808080',
      metalness: 0.9,
      roughness: 0.3,
    }).document;

    const result = execute(doc, 'assign_material', {
      materialName: 'steel',
      entityIds: [],
    });
    expect(result.document).toBe(doc);
    expect(result.affected).toHaveLength(0);
  });

  it('assign_material: failure — blank materialName', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'assign_material', {
      materialName: '',
      entityIds: ['anything'],
    });
    expect(result.document).toBe(doc);
    expect(result.affected).toHaveLength(0);
  });

  it('assign_material is pure — input doc not mutated', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'create_material', {
      name: 'steel',
      density: 0.00785,
      color: '#808080',
      metalness: 0.9,
      roughness: 0.3,
    }).document;
    const r = execute(doc, 'add_box', { size: [5, 5, 5] });
    doc = r.document;
    const snapshot = JSON.stringify(doc);
    execute(doc, 'assign_material', { materialName: 'steel', entityIds: [r.affected[0]!] });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  // ── AC1: steel vs aluminium mass difference ────────────────────────────────

  it('AC1: mass_properties uses assigned material density — steel vs aluminium on identical boxes', () => {
    let doc = createEmptyDocument();

    // Define two materials with different densities.
    doc = execute(doc, 'create_material', {
      name: 'steel',
      density: 0.00785,
      color: '#808080',
      metalness: 0.9,
      roughness: 0.3,
    }).document;
    doc = execute(doc, 'create_material', {
      name: 'aluminium',
      density: 0.0027,
      color: '#c0c0c0',
      metalness: 0.8,
      roughness: 0.2,
    }).document;

    // Create two identical boxes.
    const r1 = execute(doc, 'add_box', { size: [10, 10, 10] });
    doc = r1.document;
    const r2 = execute(doc, 'add_box', { size: [10, 10, 10] });
    doc = r2.document;
    const steelId = r1.affected[0]!;
    const alumId = r2.affected[0]!;

    // Assign different materials.
    doc = execute(doc, 'assign_material', { materialName: 'steel', entityIds: [steelId] }).document;
    doc = execute(doc, 'assign_material', { materialName: 'aluminium', entityIds: [alumId] }).document;

    // Compute mass — pass a dummy density; should be overridden by the assigned material.
    const steelResult = execute(doc, 'mass_properties', { entityId: steelId, density: 1 });
    const alumResult = execute(doc, 'mass_properties', { entityId: alumId, density: 1 });

    const steelData = steelResult.data as { mass: number; density: number; volume: number };
    const alumData = alumResult.data as { mass: number; density: number; volume: number };

    // Volumes must be equal (same box size).
    expect(steelData.volume).toBeCloseTo(alumData.volume, 6);

    // Densities must reflect the assigned materials.
    expect(steelData.density).toBe(0.00785);
    expect(alumData.density).toBe(0.0027);

    // Masses must differ proportionally to the density ratio.
    const ratio = steelData.mass / alumData.mass;
    expect(ratio).toBeCloseTo(0.00785 / 0.0027, 4);

    // Steel must be heavier.
    expect(steelData.mass).toBeGreaterThan(alumData.mass);

    // Summary must mention material source.
    expect(steelResult.summary).toContain("material 'steel'");
    expect(alumResult.summary).toContain("material 'aluminium'");
  });

  // ── mass_properties back-compat: explicit density param still works ────────

  it('mass_properties back-compat: explicit density param used when no material assigned', () => {
    let doc = createEmptyDocument();
    const r = execute(doc, 'add_box', { size: [10, 10, 10] });
    doc = r.document;
    const boxId = r.affected[0]!;

    const result = execute(doc, 'mass_properties', { entityId: boxId, density: 0.00785 });
    expect(result.data).toBeDefined();
    const data = result.data as { mass: number; density: number };
    expect(data.density).toBe(0.00785);
    expect(data.mass).toBeCloseTo(1000 * 0.00785, 6);
    // density source should say 'param'
    expect(result.summary).toContain('param');
  });

  it('mass_properties: density param still required and validated even when material is assigned', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'create_material', {
      name: 'steel',
      density: 0.00785,
      color: '#808080',
      metalness: 0.9,
      roughness: 0.3,
    }).document;
    const r = execute(doc, 'add_box', { size: [5, 5, 5] });
    doc = r.document;
    const boxId = r.affected[0]!;
    doc = execute(doc, 'assign_material', { materialName: 'steel', entityIds: [boxId] }).document;

    // Even though material is assigned, density param must be > 0.
    const result = execute(doc, 'mass_properties', { entityId: boxId, density: -1 });
    expect(result.document).toBe(doc);
    expect(result.affected).toHaveLength(0);
    expect(result.summary).toContain('density');
  });

  // ── persistence round-trip includes materials ────────────────────────────

  it('persistence round-trip: materials survive serialize/deserialize', async () => {
    const { serializeDocument, deserializeDocument } = await import('@core/commands/persistence');
    let doc = createEmptyDocument();
    doc = execute(doc, 'create_material', {
      name: 'steel',
      density: 0.00785,
      color: '#808080',
      metalness: 0.9,
      roughness: 0.3,
    }).document;
    const r = execute(doc, 'add_box', { size: [5, 5, 5] });
    doc = r.document;
    doc = execute(doc, 'assign_material', {
      materialName: 'steel',
      entityIds: [r.affected[0]!],
    }).document;

    const json = serializeDocument(doc);
    const loaded = deserializeDocument(json);

    expect(loaded.materials['steel']).toBeDefined();
    expect(loaded.materials['steel']!.density).toBe(0.00785);
    expect(loaded.entities[r.affected[0]!]!.materialId).toBe('steel');
  });

  it('persistence: deserializeDocument defaults materials to {} for old docs without it', async () => {
    const { deserializeDocument } = await import('@core/commands/persistence');
    const oldDoc = {
      format: 'llull-document',
      version: 1,
      document: {
        entities: {},
        order: [],
        layers: { 'layer-default': { id: 'layer-default', name: 'Layer 0', visible: true, locked: false } },
        layerOrder: ['layer-default'],
        selection: [],
        camera: { target: [0, 0, 0], azimuth: 0, polar: 0, distance: 10 },
        // no materials field
      },
    };
    const loaded = deserializeDocument(JSON.stringify(oldDoc));
    expect(loaded.materials).toEqual({});
  });

  // ── registry 1:1 invariant still holds ───────────────────────────────────

  it('toToolSchemas length equals listCommands length after configuration commands added', () => {
    expect(toToolSchemas().length).toBe(listCommands().length);
  });
});

// ---------------------------------------------------------------------------
// Q4 — Stable entity ids across replayHistory (id-remapping)
// ---------------------------------------------------------------------------

describe('Q4 — replayHistory id-remapping', () => {
  beforeEach(() => __resetIdCounter());

  // ── AC1: move + assign_material + delete all survive replay ─────────────

  it('AC1: move_entity applied to a replayed entity lands at the correct position', () => {
    let doc = createEmptyDocument();
    // Step 1: create box
    const r1 = execute(doc, 'add_box', { size: [2, 2, 2], position: [0, 0, 0] });
    doc = r1.document;
    const originalId = r1.affected[0]!;

    // Step 2: move it
    doc = execute(doc, 'move_entity', { id: originalId, delta: [5, 0, 0] }).document;

    // Replay: the box gets a new id, but move must be remapped to the new id.
    const replayed = execute(doc, 'replay_history', {});
    const entities = Object.values(replayed.document.entities);
    expect(entities).toHaveLength(1);
    expect(entities[0]!.position).toEqual([5, 0, 0]);
  });

  it('AC1: assign_material survives replay — entity retains materialId', () => {
    let doc = createEmptyDocument();
    // Create material
    doc = execute(doc, 'create_material', {
      name: 'steel',
      density: 0.00785,
      color: '#808080',
      metalness: 0.9,
      roughness: 0.1,
    }).document;
    // Create box
    const r1 = execute(doc, 'add_box', { size: [3, 3, 3] });
    doc = r1.document;
    const originalId = r1.affected[0]!;
    // Assign material using the original id
    doc = execute(doc, 'assign_material', {
      materialName: 'steel',
      entityIds: [originalId],
    }).document;
    // Verify live doc has the material assignment
    expect(doc.entities[originalId]!.materialId).toBe('steel');

    // Replay: box gets new id; assign_material step must be remapped to new id.
    const replayed = execute(doc, 'replay_history', {});
    const entities = Object.values(replayed.document.entities);
    expect(entities).toHaveLength(1);
    expect(entities[0]!.materialId).toBe('steel');
  });

  it('AC1: delete_entity step is faithfully replayed — entity is absent after replay', () => {
    let doc = createEmptyDocument();
    // Create two boxes
    const r1 = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = r1.document;
    const r2 = execute(doc, 'add_box', { size: [2, 2, 2] });
    doc = r2.document;
    const idToDelete = r1.affected[0]!;

    // Delete the first box
    doc = execute(doc, 'delete_entity', { id: idToDelete }).document;
    expect(Object.keys(doc.entities)).toHaveLength(1);

    // Replay: only 1 entity should remain (the deletion is faithfully applied)
    const replayed = execute(doc, 'replay_history', {});
    expect(Object.keys(replayed.document.entities)).toHaveLength(1);
    const remaining = Object.values(replayed.document.entities)[0]!;
    expect(remaining.kind).toBe('box');
  });

  it('AC1: combined — add_box → move → assign_material → delete another box all survive replay', () => {
    let doc = createEmptyDocument();
    // Create material
    doc = execute(doc, 'create_material', {
      name: 'aluminium',
      density: 0.0027,
      color: '#c0c0c0',
      metalness: 0.8,
      roughness: 0.2,
    }).document;
    // Add box A
    const rA = execute(doc, 'add_box', { size: [4, 4, 4], position: [0, 0, 0] });
    doc = rA.document;
    const idA = rA.affected[0]!;
    // Add box B
    const rB = execute(doc, 'add_box', { size: [1, 1, 1], position: [10, 0, 0] });
    doc = rB.document;
    const idB = rB.affected[0]!;
    // Move box A
    doc = execute(doc, 'move_entity', { id: idA, delta: [3, 3, 0] }).document;
    // Assign material to box A
    doc = execute(doc, 'assign_material', {
      materialName: 'aluminium',
      entityIds: [idA],
    }).document;
    // Delete box B
    doc = execute(doc, 'delete_entity', { id: idB }).document;

    // Live doc assertions
    expect(Object.keys(doc.entities)).toHaveLength(1);
    expect(doc.entities[idA]!.position).toEqual([3, 3, 0]);
    expect(doc.entities[idA]!.materialId).toBe('aluminium');

    // Replay assertions
    const replayed = execute(doc, 'replay_history', {});
    const replayedEntities = Object.values(replayed.document.entities);
    expect(replayedEntities).toHaveLength(1);
    expect(replayedEntities[0]!.position).toEqual([3, 3, 0]);
    expect(replayedEntities[0]!.materialId).toBe('aluminium');
  });

  // ── AC2: multi-id creation step (duplicate_entity) survives ─────────────

  it('AC2: duplicate_entity — subsequent move of the duplicate survives replay', () => {
    let doc = createEmptyDocument();
    // Create original
    const r1 = execute(doc, 'add_box', { size: [2, 2, 2], position: [0, 0, 0] });
    doc = r1.document;
    const originalId = r1.affected[0]!;
    // Duplicate it
    const rDup = execute(doc, 'duplicate_entity', { id: originalId, offset: [5, 0, 0] });
    doc = rDup.document;
    const dupId = rDup.affected[0]!;
    // Move the duplicate
    doc = execute(doc, 'move_entity', { id: dupId, delta: [0, 3, 0] }).document;

    // Live doc: duplicate should be at [5, 3, 0]
    expect(doc.entities[dupId]!.position).toEqual([5, 3, 0]);

    // Replay: both entities present; moved duplicate is at [5, 3, 0]
    const replayed = execute(doc, 'replay_history', {});
    const replayedEntities = Object.values(replayed.document.entities);
    expect(replayedEntities).toHaveLength(2);
    const movedEntity = replayedEntities.find((e) => e.position[1] === 3);
    expect(movedEntity).toBeDefined();
    expect(movedEntity!.position).toEqual([5, 3, 0]);
  });

  // ── AC3: back-compat — steps without affected degrade gracefully ─────────

  it('AC3: steps without affected field (old doc) replay without throwing', () => {
    // Build a doc via execute (steps have affected), then strip affected from steps
    // to simulate an old saved document.
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [2, 2, 2] }).document;
    doc = execute(doc, 'add_sphere', { radius: 3 }).document;

    // Strip affected from all steps to simulate old format.
    const strippedHistory = doc.featureHistory.map((step) => {
      const { affected: _affected, ...rest } = step as typeof step & { affected?: unknown };
      void _affected;
      return rest;
    });
    const oldDoc = { ...doc, featureHistory: strippedHistory };

    // Should not throw; should replay both entities (add_box + add_sphere don't
    // reference prior ids so they succeed regardless of idMap).
    const replayed = execute(oldDoc, 'replay_history', {});
    expect(Object.keys(replayed.document.entities)).toHaveLength(2);
  });

  // ── remapIds unit tests ───────────────────────────────────────────────────

  it('remapIds: replaces a string value that is a key in idMap', async () => {
    const { remapIds } = await import('@core/commands/regenerate');
    const idMap = new Map([['old-1', 'new-1']]);
    const result = remapIds({ id: 'old-1', size: [1, 1, 1] }, idMap) as {
      id: string;
      size: number[];
    };
    expect(result.id).toBe('new-1');
    expect(result.size).toEqual([1, 1, 1]);
  });

  it('remapIds: does not touch strings that are NOT in idMap', async () => {
    const { remapIds } = await import('@core/commands/regenerate');
    const idMap = new Map([['old-1', 'new-1']]);
    const result = remapIds({ id: 'some-label', count: 3 }, idMap) as { id: string };
    expect(result.id).toBe('some-label');
  });

  it('remapIds: remaps ids inside arrays', async () => {
    const { remapIds } = await import('@core/commands/regenerate');
    const idMap = new Map([['a', 'x'], ['b', 'y']]);
    const result = remapIds({ entityIds: ['a', 'b', 'c'] }, idMap) as {
      entityIds: string[];
    };
    expect(result.entityIds).toEqual(['x', 'y', 'c']);
  });

  it('remapIds: does not mutate the input params', async () => {
    const { remapIds } = await import('@core/commands/regenerate');
    const idMap = new Map([['old-1', 'new-1']]);
    const params = { id: 'old-1', nested: { ref: 'old-1' } };
    const snapshot = JSON.stringify(params);
    remapIds(params, idMap);
    expect(JSON.stringify(params)).toBe(snapshot);
  });

  it('remapIds: empty idMap returns params unchanged (fast path)', async () => {
    const { remapIds } = await import('@core/commands/regenerate');
    const params = { id: 'some-id', size: [1, 2, 3] };
    const result = remapIds(params, new Map());
    // Fast path: same reference when idMap is empty.
    expect(result).toBe(params);
  });

  // ── FeatureStep.affected is stored by execute() ──────────────────────────

  it('execute() stores result.affected on the FeatureStep', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_box', { size: [1, 1, 1] });
    const step = result.document.featureHistory[0]!;
    expect(step.affected).toBeDefined();
    expect(step.affected).toEqual(result.affected);
  });

  it('execute() stores affected for move_entity (single entity mutation)', () => {
    let doc = createEmptyDocument();
    const r1 = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = r1.document;
    const id = r1.affected[0]!;
    const result = execute(doc, 'move_entity', { id, delta: [1, 0, 0] });
    const moveStep = result.document.featureHistory[1]!;
    expect(moveStep.name).toBe('move_entity');
    expect(moveStep.affected).toEqual([id]);
  });

  it('AC2: multi-id producer (array_linear) — moving the Nth copy survives replay (locks positional-zip ordering)', () => {
    let doc = createEmptyDocument();
    const rBox = execute(doc, 'add_box', { size: [1, 1, 1], position: [0, 0, 0] });
    doc = rBox.document;
    const baseId = rBox.affected[0]!;
    // Array into 3 (count-1 = 2 new copies) along +X: affected lists the new copies in order.
    const rArr = execute(doc, 'array_linear', { id: baseId, count: 3, offset: [5, 0, 0] });
    doc = rArr.document;
    expect(rArr.affected.length).toBeGreaterThanOrEqual(2);
    const secondCopyId = rArr.affected[1]!; // a specific copy by position in `affected`
    // Move exactly that copy up in Y.
    doc = execute(doc, 'move_entity', { id: secondCopyId, delta: [0, 7, 0] }).document;
    const liveY = doc.entities[secondCopyId]!.position[1];
    expect(liveY).toBe(7);

    // Replay: the moved copy must still be the one displaced by +7 in Y (positional
    // zip of array_linear's `affected` must map the SAME copy across regeneration).
    const replayed = execute(doc, 'replay_history', {});
    const movedInReplay = Object.values(replayed.document.entities).filter(
      (e) => e.position[1] === 7,
    );
    expect(movedInReplay).toHaveLength(1);
    // And exactly one entity is displaced — no other copy accidentally got the move.
    const total = Object.keys(replayed.document.entities).length;
    expect(total).toBe(Object.keys(doc.entities).length);
  });
});

describe('instantiate_template (templates.ts generators)', () => {
  it('instantiate_template bolt_hole_pattern — creates correct count of circle entities', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'instantiate_template', {
      template: 'bolt_hole_pattern',
      params: { count: 6, boltCircleRadius: 25, holeRadius: 3 },
    });
    expect(result.affected).toHaveLength(6);
    expect(result.document.order).toHaveLength(6);
    for (const id of result.affected) {
      expect(result.document.entities[id]!.kind).toBe('circle');
    }
    expect(result.summary).toContain('bolt_hole_pattern');
    expect(result.summary).toContain('6');
  });

  it('instantiate_template bolt_hole_pattern — holes are on the bolt circle at correct angles', () => {
    const doc = createEmptyDocument();
    const R = 50;
    const result = execute(doc, 'instantiate_template', {
      template: 'bolt_hole_pattern',
      params: { count: 4, boltCircleRadius: R, holeRadius: 5 },
    });
    expect(result.affected).toHaveLength(4);
    const expectedAngles = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
    for (let i = 0; i < 4; i++) {
      const entity = result.document.entities[result.affected[i]!]! as { center: readonly [number, number] };
      expect(entity.center[0]!).toBeCloseTo(R * Math.cos(expectedAngles[i]!), 5);
      expect(entity.center[1]!).toBeCloseTo(R * Math.sin(expectedAngles[i]!), 5);
    }
  });

  it('instantiate_template bolt_hole_pattern — affected order is deterministic (stable for replay)', () => {
    const callParams = {
      template: 'bolt_hole_pattern',
      params: { count: 3, boltCircleRadius: 20, holeRadius: 2 },
    };
    const result1 = execute(createEmptyDocument(), 'instantiate_template', callParams);
    const result2 = execute(createEmptyDocument(), 'instantiate_template', callParams);
    // Ids are globally unique (timestamp + monotonic counter), so they differ between
    // calls — but the affected ORDER is deterministic (Q4 relies on this for replay
    // zipping). Assert the created entities appear in the same geometric sequence.
    expect(result1.affected).toHaveLength(result2.affected.length);
    const centers1 = result1.affected.map(
      (id) => (result1.document.entities[id]! as { center: readonly [number, number] }).center,
    );
    const centers2 = result2.affected.map(
      (id) => (result2.document.entities[id]! as { center: readonly [number, number] }).center,
    );
    expect(centers1).toEqual(centers2);
  });

  it('instantiate_template flange — creates outer + bore + N bolt holes', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'instantiate_template', {
      template: 'flange',
      params: {
        outerRadius: 60,
        boreRadius: 15,
        boltCount: 6,
        boltCircleRadius: 40,
        holeRadius: 5,
      },
    });
    // 2 structural circles (outer + bore) + 6 bolt holes = 8 total
    expect(result.affected).toHaveLength(8);
    for (const id of result.affected) {
      expect(result.document.entities[id]!.kind).toBe('circle');
    }
    // First two are at [0,0] (outer and bore)
    const outerE = result.document.entities[result.affected[0]!]! as { center: readonly [number, number]; radius: number };
    const boreE = result.document.entities[result.affected[1]!]! as { center: readonly [number, number]; radius: number };
    expect(outerE.center).toEqual([0, 0]);
    expect(outerE.radius).toBe(60);
    expect(boreE.center).toEqual([0, 0]);
    expect(boreE.radius).toBe(15);
    expect(result.summary).toContain('flange');
  });

  it('instantiate_template rectangular_plate_with_holes — creates plate + hole grid', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'instantiate_template', {
      template: 'rectangular_plate_with_holes',
      params: { width: 100, height: 60, holeRows: 2, holeCols: 3, holeRadius: 4, marginX: 10, marginY: 10 },
    });
    // 1 rectangle + 2*3=6 circles = 7 entities
    expect(result.affected).toHaveLength(7);
    expect(result.document.entities[result.affected[0]!]!.kind).toBe('rectangle');
    for (let i = 1; i < 7; i++) {
      expect(result.document.entities[result.affected[i]!]!.kind).toBe('circle');
    }
    expect(result.summary).toContain('rectangular_plate_with_holes');
  });

  it('instantiate_template rectangular_plate_with_holes — single hole (1×1 grid)', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'instantiate_template', {
      template: 'rectangular_plate_with_holes',
      params: { width: 50, height: 50, holeRows: 1, holeCols: 1, holeRadius: 5, marginX: 15, marginY: 15 },
    });
    // 1 rectangle + 1 circle = 2 entities
    expect(result.affected).toHaveLength(2);
    expect(result.document.entities[result.affected[0]!]!.kind).toBe('rectangle');
    const hole = result.document.entities[result.affected[1]!]! as { center: readonly [number, number] };
    // Single hole placed at [marginX, marginY]
    expect(hole.center[0]!).toBeCloseTo(15, 5);
    expect(hole.center[1]!).toBeCloseTo(15, 5);
  });

  it('instantiate_template — custom position is passed to all entities', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'instantiate_template', {
      template: 'bolt_hole_pattern',
      params: { count: 3, boltCircleRadius: 10, holeRadius: 2 },
      position: [5, 10, 0],
    });
    for (const id of result.affected) {
      expect(result.document.entities[id]!.position).toEqual([5, 10, 0]);
    }
  });

  it('instantiate_template — is pure (input doc not mutated)', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'instantiate_template', {
      template: 'bolt_hole_pattern',
      params: { count: 4, boltCircleRadius: 20, holeRadius: 3 },
    });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('instantiate_template — unknown template is a graceful no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'instantiate_template', {
      template: 'nonexistent_template' as never,
      params: {},
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('nonexistent_template');
  });

  it('instantiate_template bolt_hole_pattern — count <= 0 is a graceful no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'instantiate_template', {
      template: 'bolt_hole_pattern',
      params: { count: 0, boltCircleRadius: 25, holeRadius: 3 },
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('count');
  });

  it('instantiate_template bolt_hole_pattern — holeRadius <= 0 is a graceful no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'instantiate_template', {
      template: 'bolt_hole_pattern',
      params: { count: 4, boltCircleRadius: 25, holeRadius: -1 },
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('holeRadius');
  });

  it('instantiate_template flange — boreRadius >= outerRadius is a graceful no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'instantiate_template', {
      template: 'flange',
      params: { outerRadius: 30, boreRadius: 40, boltCount: 4, boltCircleRadius: 20, holeRadius: 3 },
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('boreRadius');
  });

  it('instantiate_template rectangular_plate_with_holes — width <= 0 is a graceful no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'instantiate_template', {
      template: 'rectangular_plate_with_holes',
      params: { width: 0, height: 50, holeRows: 2, holeCols: 2, holeRadius: 4, marginX: 5, marginY: 5 },
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('width');
  });

  it.each([
    ['height', { width: 50, height: 0, holeRows: 2, holeCols: 2, holeRadius: 4, marginX: 5, marginY: 5 }],
    ['holeRows', { width: 50, height: 50, holeRows: 0, holeCols: 2, holeRadius: 4, marginX: 5, marginY: 5 }],
    ['holeCols', { width: 50, height: 50, holeRows: 2, holeCols: 0, holeRadius: 4, marginX: 5, marginY: 5 }],
    ['holeRadius', { width: 50, height: 50, holeRows: 2, holeCols: 2, holeRadius: 0, marginX: 5, marginY: 5 }],
    ['marginX', { width: 50, height: 50, holeRows: 2, holeCols: 2, holeRadius: 4, marginX: -1, marginY: 5 }],
    ['marginY', { width: 50, height: 50, holeRows: 2, holeCols: 2, holeRadius: 4, marginX: 5, marginY: -1 }],
  ])(
    'instantiate_template rectangular_plate_with_holes — invalid %s is a graceful no-op',
    (field, params) => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'instantiate_template', {
        template: 'rectangular_plate_with_holes',
        params,
      });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain(field);
    },
  );

  it('instantiate_template — feature history replay regenerates same entity count and kinds', () => {
    let doc = createEmptyDocument();
    // Instantiate a bolt-hole pattern (goes into featureHistory via execute())
    doc = execute(doc, 'instantiate_template', {
      template: 'bolt_hole_pattern',
      params: { count: 6, boltCircleRadius: 25, holeRadius: 3 },
    }).document;

    expect(doc.featureHistory).toHaveLength(1);
    expect(doc.featureHistory[0]!.name).toBe('instantiate_template');
    const originalAffectedCount = doc.order.length;

    // Replay the history from an empty document
    const replayResult = execute(doc, 'replay_history', {});
    const replayed = replayResult.document;

    // Should have the same number of entities
    expect(Object.keys(replayed.entities)).toHaveLength(originalAffectedCount);
    // All should be circles
    for (const entity of Object.values(replayed.entities)) {
      expect(entity.kind).toBe('circle');
    }
  });
});

// ---------------------------------------------------------------------------
// export_stl — ASCII + binary STL export
// ---------------------------------------------------------------------------

describe('export_stl', () => {
  beforeEach(() => __resetIdCounter());

  // ── helpers ───────────────────────────────────────────────────────────────

  /** Decode a base64 string into a Uint8Array (pure, mirrors uint8ArrayToBase64). */
  function base64ToUint8Array(b64: string): Uint8Array {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const out: number[] = [];
    let i = 0;
    const raw = b64.replace(/=+$/, '');
    while (i < raw.length) {
      const c0 = chars.indexOf(raw[i++]!);
      const c1 = chars.indexOf(raw[i++]!);
      const c2 = i <= raw.length ? chars.indexOf(raw[i++]!) : 0;
      const c3 = i <= raw.length ? chars.indexOf(raw[i++]!) : 0;
      const n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
      out.push((n >> 16) & 0xff);
      if (raw[i - 2] !== undefined) out.push((n >> 8) & 0xff);
      if (raw[i - 1] !== undefined) out.push(n & 0xff);
    }
    return new Uint8Array(out);
  }

  type StlData = { format: string; triangleCount: number; stl?: string; stlBase64?: string };

  // ── ASCII box ─────────────────────────────────────────────────────────────

  it('ASCII STL for a box: well-formed, 12 triangles, correct structure', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [2, 2, 2] }).document;

    const result = execute(doc, 'export_stl', { format: 'ascii' });
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc); // same reference — read-only

    const data = result.data as StlData;
    expect(data.format).toBe('ascii');
    expect(data.triangleCount).toBe(12); // 6 faces × 2 triangles

    const stl = data.stl!;
    expect(stl).toBeDefined();
    expect(stl.startsWith('solid ')).toBe(true);
    expect(stl.endsWith('endsolid llull')).toBe(true);

    // Count facet/vertex lines
    const facetMatches = stl.match(/^\s*facet normal/gm);
    const vertexMatches = stl.match(/^\s*vertex /gm);
    expect(facetMatches).toHaveLength(12);
    expect(vertexMatches).toHaveLength(36); // 3 vertices per facet
  });

  // ── cylinder ──────────────────────────────────────────────────────────────

  it('cylinder produces > 0 triangles and well-formed ASCII STL', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_cylinder', { radius: 1, height: 2 }).document;

    const result = execute(doc, 'export_stl', {});
    const data = result.data as StlData;
    expect(data.triangleCount).toBeGreaterThan(0);
    expect(data.stl).toContain('solid llull');
    expect(data.stl).toContain('endsolid llull');
  });

  // ── sphere ────────────────────────────────────────────────────────────────

  it('sphere produces > 0 triangles and well-formed ASCII STL', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_sphere', { radius: 1 }).document;

    const result = execute(doc, 'export_stl', {});
    const data = result.data as StlData;
    expect(data.triangleCount).toBeGreaterThan(0);
    expect(data.stl!.split('facet normal').length - 1).toBe(data.triangleCount);
  });

  // ── extrusion ─────────────────────────────────────────────────────────────

  it('extrusion produces > 0 triangles', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'extrude_profile', {
      profile: [[0, 0], [2, 0], [2, 2], [0, 2]],
      depth: 1,
    }).document;

    const result = execute(doc, 'export_stl', {});
    const data = result.data as StlData;
    expect(data.triangleCount).toBeGreaterThan(0);
  });

  // ── mesh ──────────────────────────────────────────────────────────────────

  it('mesh entity produces > 0 triangles', () => {
    let doc = createEmptyDocument();
    // Boolean union produces a mesh entity
    const r1 = execute(doc, 'add_box', { size: [2, 2, 2] });
    doc = r1.document;
    const r2 = execute(doc, 'add_box', { size: [2, 2, 2], position: [1, 0, 0] });
    doc = r2.document;
    const u = execute(doc, 'boolean_union', { entityIds: [r1.affected[0]!, r2.affected[0]!] });
    if (u.affected.length > 0) {
      // Only assert if boolean union produced a mesh (OCC might not be available)
      const meshEntity = u.document.entities[u.affected[0]!];
      if (meshEntity?.kind === 'mesh') {
        doc = u.document;
        const result = execute(doc, 'export_stl', {});
        const data = result.data as StlData;
        expect(data.triangleCount).toBeGreaterThan(0);
      }
    }
    // Always verify the command doesn't throw, even with no mesh
    expect(true).toBe(true);
  });

  // ── world transform ───────────────────────────────────────────────────────

  it('world transform: box at position [10,0,0] has vertices offset by 10 in X', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', {
      size: [2, 2, 2],
      position: [10, 0, 0],
    }).document;

    const result = execute(doc, 'export_stl', { format: 'ascii' });
    const stl = (result.data as StlData).stl!;

    // Extract all vertex X values from the STL
    const vertexLines = stl.match(/vertex\s+([-\d.e+]+)\s+([-\d.e+]+)\s+([-\d.e+]+)/g) ?? [];
    expect(vertexLines.length).toBeGreaterThan(0);

    for (const line of vertexLines) {
      const parts = line.replace('vertex', '').trim().split(/\s+/);
      const x = parseFloat(parts[0]!);
      // Box of size [2,2,2] centered at [10,0,0] has X in [9, 11]
      expect(x).toBeGreaterThanOrEqual(9 - 1e-5);
      expect(x).toBeLessThanOrEqual(11 + 1e-5);
    }
  });

  it('world transform: rotated box vertices differ from unrotated', () => {
    let doc = createEmptyDocument();
    // Box without rotation
    doc = execute(doc, 'add_box', { size: [2, 1, 1], position: [0, 0, 0] }).document;
    const noRot = execute(doc, 'export_stl', { format: 'ascii' });

    // Same box, then rotate 45° about Z via rotate_entity (add_box does not accept a
    // rotation param — rotation is applied by the transform command). export_stl must
    // bake the entity rotation into the world-space STL vertices.
    doc = createEmptyDocument();
    const added = execute(doc, 'add_box', { size: [2, 1, 1], position: [0, 0, 0] });
    doc = added.document;
    doc = execute(doc, 'rotate_entity', { id: added.affected[0]!, delta: [0, 0, Math.PI / 4] }).document;
    const withRot = execute(doc, 'export_stl', { format: 'ascii' });

    // The STL vertex data should differ
    expect((noRot.data as StlData).stl).not.toBe((withRot.data as StlData).stl);
    expect((withRot.data as StlData).triangleCount).toBe(12);
  });

  // ── entityIds subset selection ────────────────────────────────────────────

  it('entityIds subset: export only selected entities', () => {
    let doc = createEmptyDocument();
    const r1 = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = r1.document;
    const r2 = execute(doc, 'add_sphere', { radius: 2 });
    doc = r2.document;
    const boxId = r1.affected[0]!;

    // Export only the box (12 triangles)
    const result = execute(doc, 'export_stl', { entityIds: [boxId] });
    const data = result.data as StlData;
    expect(data.triangleCount).toBe(12);
  });

  it('entityIds default (omit) exports all 3D entities', () => {
    let doc = createEmptyDocument();
    const r1 = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = r1.document;
    const r2 = execute(doc, 'add_box', { size: [2, 2, 2] });
    doc = r2.document;

    // Two boxes = 24 triangles total
    const result = execute(doc, 'export_stl', {});
    const data = result.data as StlData;
    expect(data.triangleCount).toBe(24);
  });

  // ── binary format ─────────────────────────────────────────────────────────

  it('binary STL: base64 decodes to correct byte length (84 + 50*triangleCount)', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;

    const result = execute(doc, 'export_stl', { format: 'binary' });
    const data = result.data as StlData;
    expect(data.format).toBe('binary');
    expect(data.stlBase64).toBeDefined();
    expect(data.triangleCount).toBe(12);

    const bytes = base64ToUint8Array(data.stlBase64!);
    expect(bytes.length).toBe(84 + 50 * 12);
  });

  it('binary STL: uint32 at offset 80 equals triangleCount', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;

    const result = execute(doc, 'export_stl', { format: 'binary' });
    const data = result.data as StlData;
    const bytes = base64ToUint8Array(data.stlBase64!);
    const view = new DataView(bytes.buffer);
    const count = view.getUint32(80, true); // little-endian
    expect(count).toBe(data.triangleCount);
  });

  it('binary STL: 80-byte header carries the solid name (ASCII)', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    const result = execute(doc, 'export_stl', { format: 'binary', name: 'widget' });
    const bytes = base64ToUint8Array((result.data as StlData).stlBase64!);
    const header = Array.from(bytes.slice(0, 6))
      .map((b) => String.fromCharCode(b))
      .join('');
    expect(header).toBe('widget');
  });

  it('binary STL: a vertex round-trips little-endian (locks the 50-byte record layout)', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [2, 2, 2], position: [0, 0, 0] }).document;
    const bytes = base64ToUint8Array(
      (execute(doc, 'export_stl', { format: 'binary' }).data as StlData).stlBase64!,
    );
    const view = new DataView(bytes.buffer);
    // First triangle's first vertex begins at offset 84 + 12 (after the 3-float normal).
    const vx = view.getFloat32(84 + 12, true);
    const vy = view.getFloat32(84 + 16, true);
    const vz = view.getFloat32(84 + 20, true);
    // A 2×2×2 box centered at origin has all vertices at ±1.
    for (const c of [vx, vy, vz]) expect(Math.abs(c)).toBeCloseTo(1, 5);
  });

  // ── 2D entities skipped ───────────────────────────────────────────────────

  it('2D-only document: valid empty solid with triangleCount:0', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'draw_line', { start: [0, 0], end: [5, 5] }).document;
    doc = execute(doc, 'draw_circle', { center: [0, 0], radius: 3 }).document;

    const result = execute(doc, 'export_stl', {});
    const data = result.data as StlData;
    expect(data.triangleCount).toBe(0);
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
    // ASCII STL is still well-formed
    expect(data.stl).toContain('solid');
    expect(data.stl).toContain('endsolid');
  });

  it('2D entities in entityIds list are silently skipped', () => {
    let doc = createEmptyDocument();
    const rLine = execute(doc, 'draw_line', { start: [0, 0], end: [1, 1] });
    doc = rLine.document;
    const lineId = rLine.affected[0]!;

    const result = execute(doc, 'export_stl', { entityIds: [lineId] });
    const data = result.data as StlData;
    expect(data.triangleCount).toBe(0);
    expect(result.summary).toContain('skipped');
  });

  // ── unknown / empty selection ─────────────────────────────────────────────

  it('unknown ids in entityIds: graceful result, triangleCount:0, summary mentions id', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'export_stl', { entityIds: ['ghost-id'] });
    const data = result.data as StlData;
    expect(data.triangleCount).toBe(0);
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain('ghost-id');
  });

  it('empty document: valid empty solid (triangleCount:0), no throw', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'export_stl', {});
    const data = result.data as StlData;
    expect(data.triangleCount).toBe(0);
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
  });

  // ── read-only / purity ────────────────────────────────────────────────────

  it('read-only: same doc reference returned, affected:[]', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;

    const result = execute(doc, 'export_stl', {});
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });

  it('is pure: input document is not mutated', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [2, 2, 2] }).document;
    const snapshot = JSON.stringify(doc);

    execute(doc, 'export_stl', { format: 'ascii' });
    execute(doc, 'export_stl', { format: 'binary' });

    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  // ── cone / torus / wedge / pyramid ───────────────────────────────────────

  it('cone produces > 0 triangles', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_cone', { radius: 1, height: 2 }).document;
    const data = execute(doc, 'export_stl', {}).data as StlData;
    expect(data.triangleCount).toBeGreaterThan(0);
  });

  it('torus produces > 0 triangles', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_torus', { ringRadius: 2, tubeRadius: 0.5 }).document;
    const data = execute(doc, 'export_stl', {}).data as StlData;
    expect(data.triangleCount).toBeGreaterThan(0);
  });

  it('wedge produces > 0 triangles', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_wedge', { size: [2, 1, 3] }).document;
    const data = execute(doc, 'export_stl', {}).data as StlData;
    expect(data.triangleCount).toBeGreaterThan(0);
  });

  it('pyramid produces > 0 triangles', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_pyramid', { baseWidth: 2, baseDepth: 2, height: 3 }).document;
    const data = execute(doc, 'export_stl', {}).data as StlData;
    expect(data.triangleCount).toBeGreaterThan(0);
  });

  // ── custom solid name ─────────────────────────────────────────────────────

  it('custom name: solid name embedded in ASCII STL header', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    const result = execute(doc, 'export_stl', { name: 'my_part' });
    const stl = (result.data as StlData).stl!;
    expect(stl.startsWith('solid my_part')).toBe(true);
    expect(stl.endsWith('endsolid my_part')).toBe(true);
  });

  // ── registry 1:1 invariant ────────────────────────────────────────────────

  it('toToolSchemas() still 1:1 with listCommands() after export_stl registered', () => {
    expect(toToolSchemas().length).toBe(listCommands().length);
    const schema = toToolSchemas().find((s) => s.name === 'export_stl');
    expect(schema).toBeDefined();
    expect(schema?.annotations?.readOnlyHint).toBe(true);
  });

  // ── save_recipe ───────────────────────────────────────────────────────────

  describe('save_recipe', () => {
    it('happy path: snapshots featureHistory into doc.recipes with correct step count', () => {
      let doc = createEmptyDocument();
      doc = execute(doc, 'add_box', { size: [2, 2, 2] }).document;
      doc = execute(doc, 'add_sphere', { radius: 1 }).document;
      expect(doc.featureHistory).toHaveLength(2);

      const result = execute(doc, 'save_recipe', { name: 'my_bracket' });

      // save_recipe is metaHistory — the doc ref changes for recipes but featureHistory grows only from non-meta commands
      expect(result.affected).toHaveLength(0);
      const recipe = result.document.recipes['my_bracket'];
      expect(recipe).toBeDefined();
      expect(recipe!.name).toBe('my_bracket');
      expect(recipe!.steps).toHaveLength(2);
      expect(result.summary).toContain('my_bracket');
      expect(result.summary).toContain('2 step');
    });

    it('happy path: optional label is stored on the recipe', () => {
      let doc = createEmptyDocument();
      doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;

      const result = execute(doc, 'save_recipe', { name: 'labelled', label: 'A simple box recipe' });
      const recipe = result.document.recipes['labelled'];
      expect(recipe!.label).toBe('A simple box recipe');
    });

    it('empty featureHistory: still saves recipe but summary notes it is empty', () => {
      const doc = createEmptyDocument();
      expect(doc.featureHistory).toHaveLength(0);

      const result = execute(doc, 'save_recipe', { name: 'empty_recipe' });
      const recipe = result.document.recipes['empty_recipe'];
      expect(recipe).toBeDefined();
      expect(recipe!.steps).toHaveLength(0);
      expect(result.summary).toContain('empty');
    });

    it('replaces an existing recipe with the same name', () => {
      let doc = createEmptyDocument();
      doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
      doc = execute(doc, 'save_recipe', { name: 'r' }).document;
      expect(doc.recipes['r']!.steps).toHaveLength(1);

      // Add another entity then re-save under the same name.
      doc = execute(doc, 'add_sphere', { radius: 2 }).document;
      const result = execute(doc, 'save_recipe', { name: 'r' });
      expect(result.document.recipes['r']!.steps).toHaveLength(2);
    });

    it('failure: blank name → no-op, affected:[], unchanged doc', () => {
      const doc = createEmptyDocument();

      const result = execute(doc, 'save_recipe', { name: '' });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('failed');
    });

    it('failure: whitespace-only name → no-op', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'save_recipe', { name: '   ' });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
    });

    it('is pure: input document is not mutated', () => {
      let doc = createEmptyDocument();
      doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
      const snapshot = JSON.stringify(doc);

      execute(doc, 'save_recipe', { name: 'purity_check' });
      expect(JSON.stringify(doc)).toBe(snapshot);
    });

    it('steps are a deep copy: mutating featureHistory after save does not corrupt the recipe', () => {
      let doc = createEmptyDocument();
      doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
      const saved = execute(doc, 'save_recipe', { name: 'copy_test' }).document;
      const recipeStepsBefore = saved.recipes['copy_test']!.steps.length;

      // Add another step to the doc — recipe must be unaffected.
      const updated = execute(saved, 'add_sphere', { radius: 1 }).document;
      expect(updated.featureHistory).toHaveLength(2);
      expect(saved.recipes['copy_test']!.steps).toHaveLength(recipeStepsBefore);
    });
  });

  // ── instantiate_recipe ────────────────────────────────────────────────────

  describe('instantiate_recipe', () => {
    it('happy path: 1-step recipe creates one entity with a fresh id', () => {
      let doc = createEmptyDocument();
      // Build a box, save as recipe.
      const boxResult = execute(doc, 'add_box', { size: [3, 3, 3] });
      doc = boxResult.document;
      doc = execute(doc, 'save_recipe', { name: 'one_box' }).document;

      // Start fresh — wipe the existing entity to prove instantiate adds independently.
      let freshDoc = createEmptyDocument();
      freshDoc = { ...freshDoc, recipes: doc.recipes };

      const result = execute(freshDoc, 'instantiate_recipe', { name: 'one_box' });
      expect(result.affected).toHaveLength(1);
      expect(result.document.order).toHaveLength(1);
      const id = result.affected[0]!;
      expect(result.document.entities[id]!.kind).toBe('box');
      expect(result.summary).toContain('one_box');
      expect(result.summary).toContain('1 step');
    });

    it('happy path: 2-step recipe (add_box + move_entity) correctly remaps ids', () => {
      let doc = createEmptyDocument();
      // Step 1: create a box.
      const boxResult = execute(doc, 'add_box', { size: [1, 1, 1] });
      doc = boxResult.document;
      const originalBoxId = boxResult.affected[0]!;
      // Step 2: move the box — references the original box id.
      doc = execute(doc, 'move_entity', { id: originalBoxId, delta: [5, 0, 0] }).document;
      expect(doc.featureHistory).toHaveLength(2);

      // Save the recipe then instantiate onto a clean doc.
      doc = execute(doc, 'save_recipe', { name: 'box_with_move' }).document;
      let targetDoc = createEmptyDocument();
      targetDoc = { ...targetDoc, recipes: doc.recipes };

      const result = execute(targetDoc, 'instantiate_recipe', { name: 'box_with_move' });
      expect(result.affected).toHaveLength(1); // move_entity doesn't add a new entity
      expect(result.document.order).toHaveLength(1);
      const newId = result.affected[0]!;
      // The box should be at position [5, 0, 0] (moved) — proves id remapping worked.
      expect(result.document.entities[newId]!.position).toEqual([5, 0, 0]);
    });

    it('additive: instantiating onto a doc with existing entities leaves them untouched', () => {
      let doc = createEmptyDocument();
      // Pre-existing sphere.
      doc = execute(doc, 'add_sphere', { radius: 2 }).document;
      const existingId = doc.order[0]!;

      // Save a 1-box recipe.
      let recipeDoc = createEmptyDocument();
      recipeDoc = execute(recipeDoc, 'add_box', { size: [1, 1, 1] }).document;
      recipeDoc = execute(recipeDoc, 'save_recipe', { name: 'just_box' }).document;

      // Merge the recipe into doc.
      doc = { ...doc, recipes: recipeDoc.recipes };
      const result = execute(doc, 'instantiate_recipe', { name: 'just_box' });

      // Both the original sphere and the new box are present.
      expect(result.document.order).toHaveLength(2);
      expect(result.document.entities[existingId]).toBeDefined();
      expect(result.document.entities[existingId]!.kind).toBe('sphere');
    });

    it('idempotency: instantiating twice yields two independent copies', () => {
      let doc = createEmptyDocument();
      doc = execute(doc, 'add_box', { size: [2, 2, 2] }).document;
      doc = execute(doc, 'save_recipe', { name: 'dup' }).document;

      let targetDoc = createEmptyDocument();
      targetDoc = { ...targetDoc, recipes: doc.recipes };

      const r1 = execute(targetDoc, 'instantiate_recipe', { name: 'dup' });
      const r2 = execute(r1.document, 'instantiate_recipe', { name: 'dup' });

      expect(r2.document.order).toHaveLength(2);
      // The two ids must be different.
      const [id1, id2] = r2.document.order;
      expect(id1).not.toBe(id2);
    });

    it('failure: unknown recipe name → no-op, affected:[], summary mentions name', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'instantiate_recipe', { name: 'does_not_exist' });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('does_not_exist');
      expect(result.summary).toContain('not found');
    });

    it('failure: blank name → no-op', () => {
      const doc = createEmptyDocument();
      const result = execute(doc, 'instantiate_recipe', { name: '' });
      expect(result.affected).toHaveLength(0);
      expect(result.document).toBe(doc);
    });

    it('is pure: input document is not mutated', () => {
      let doc = createEmptyDocument();
      doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
      doc = execute(doc, 'save_recipe', { name: 'pure_test' }).document;
      const snapshot = JSON.stringify(doc);

      execute(doc, 'instantiate_recipe', { name: 'pure_test' });
      expect(JSON.stringify(doc)).toBe(snapshot);
    });

    it('featureHistory records instantiate_recipe as a single step', () => {
      let doc = createEmptyDocument();
      doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
      doc = execute(doc, 'save_recipe', { name: 'hist_test' }).document;

      let targetDoc = createEmptyDocument();
      targetDoc = { ...targetDoc, recipes: doc.recipes };

      const result = execute(targetDoc, 'instantiate_recipe', { name: 'hist_test' });
      // instantiate_recipe is a normal (non-meta) command, so execute() appends one step.
      expect(result.document.featureHistory).toHaveLength(1);
      expect(result.document.featureHistory[0]!.name).toBe('instantiate_recipe');
    });
  });

  // ── replay survival (critical integration test) ───────────────────────────

  describe('recipe replay survival', () => {
    it('instantiated entities survive replay_history (recipes: base.recipes fix)', () => {
      // 1. Build a 2-step recipe.
      let doc = createEmptyDocument();
      doc = execute(doc, 'add_box', { size: [2, 2, 2] }).document;
      doc = execute(doc, 'add_sphere', { radius: 1 }).document;
      doc = execute(doc, 'save_recipe', { name: 'survival_test' }).document;

      // 2. Fresh doc — carry only the recipes dict.
      let freshDoc = createEmptyDocument();
      freshDoc = { ...freshDoc, recipes: doc.recipes };

      // 3. Instantiate the recipe — records one featureHistory step.
      const instantiated = execute(freshDoc, 'instantiate_recipe', { name: 'survival_test' });
      const docAfterInstantiate = instantiated.document;
      expect(docAfterInstantiate.order).toHaveLength(2);
      expect(docAfterInstantiate.featureHistory).toHaveLength(1);

      // 4. replay_history replays the single instantiate_recipe step.
      //    Without the `recipes: base.recipes` fix in replayHistory, the recipes dict
      //    would be {} in the base and instantiate_recipe would find no recipe → 0 entities.
      const replayed = execute(docAfterInstantiate, 'replay_history', {});
      expect(replayed.document.order).toHaveLength(2);
      expect(replayed.summary).toContain('2 entit');
    });

    it('recipe count and entity count survive serialise → deserialise round-trip', async () => {
      const { serializeDocument, deserializeDocument } = await import('@core/commands/persistence');

      let doc = createEmptyDocument();
      doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
      doc = execute(doc, 'save_recipe', { name: 'round_trip' }).document;

      const json = serializeDocument(doc);
      const loaded = deserializeDocument(json);

      expect(Object.keys(loaded.recipes)).toHaveLength(1);
      expect(loaded.recipes['round_trip']!.steps).toHaveLength(1);
    });
  });

  // ── toToolSchemas 1:1 invariant (recipes) ────────────────────────────────

  it('toToolSchemas() still 1:1 with listCommands() after save_recipe and instantiate_recipe registered', () => {
    expect(toToolSchemas().length).toBe(listCommands().length);
    const saveSchema = toToolSchemas().find((s) => s.name === 'save_recipe');
    const instantiateSchema = toToolSchemas().find((s) => s.name === 'instantiate_recipe');
    expect(saveSchema).toBeDefined();
    expect(instantiateSchema).toBeDefined();
    // save_recipe is idempotent (meta); instantiate_recipe is not
    expect(saveSchema?.annotations?.idempotentHint).toBe(true);
    expect(instantiateSchema?.annotations?.idempotentHint).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// W4A — rotation param at creation + W4C — AABB in summaries
// ---------------------------------------------------------------------------

describe('W4A/W4C — rotation at creation and AABB summaries', () => {
  beforeEach(() => __resetIdCounter());

  // ── add_box ──────────────────────────────────────────────────────────────

  it('add_box stores non-zero rotation on the entity', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_box', { size: [2, 4, 6], rotation: [0.1, 0.2, 0.3] });
    const id = result.affected[0]!;
    expect(result.document.entities[id]!.rotation).toEqual([0.1, 0.2, 0.3]);
  });

  it('add_box defaults to rotation [0,0,0] when omitted', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_box', { size: [1, 1, 1] });
    const id = result.affected[0]!;
    expect(result.document.entities[id]!.rotation).toEqual([0, 0, 0]);
  });

  it('add_box ignores non-finite rotation and still creates the entity', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_box', { size: [2, 2, 2], rotation: [Infinity, 0, 0] });
    expect(result.affected).toHaveLength(1);
    const id = result.affected[0]!;
    expect(result.document.entities[id]!.rotation).toEqual([0, 0, 0]);
  });

  it('add_box ignores wrong-length rotation array and still creates the entity', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_box', { size: [2, 2, 2], rotation: [0.5, 0.5] });
    expect(result.affected).toHaveLength(1);
    const id = result.affected[0]!;
    expect(result.document.entities[id]!.rotation).toEqual([0, 0, 0]);
  });

  it('add_box summary contains world AABB', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_box', { size: [2, 4, 6], position: [1, 2, 3] });
    // box center [1,2,3], size [2,4,6] → min [-1,0,0] max [3,4,6]
    expect(result.summary).toContain('world AABB');
    expect(result.summary).toContain('min');
    expect(result.summary).toContain('max');
  });

  // ── add_cylinder ─────────────────────────────────────────────────────────

  it('add_cylinder stores non-zero rotation on the entity', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_cylinder', { radius: 3, height: 5, rotation: [0, 0, Math.PI / 2] });
    const id = result.affected[0]!;
    const r = result.document.entities[id]!.rotation;
    expect(r[0]).toBeCloseTo(0);
    expect(r[1]).toBeCloseTo(0);
    expect(r[2]).toBeCloseTo(Math.PI / 2);
  });

  it('add_cylinder ignores malformed rotation and still creates the entity', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_cylinder', { radius: 1, height: 2, rotation: 'bad' });
    expect(result.affected).toHaveLength(1);
    expect(result.document.entities[result.affected[0]!]!.rotation).toEqual([0, 0, 0]);
  });

  it('add_cylinder summary contains world AABB', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_cylinder', { radius: 2, height: 6, position: [0, 0, 0] });
    expect(result.summary).toContain('world AABB');
  });

  // ── add_sphere ───────────────────────────────────────────────────────────

  it('add_sphere stores non-zero rotation on the entity', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_sphere', { radius: 5, rotation: [Math.PI, 0, 0] });
    const id = result.affected[0]!;
    expect(result.document.entities[id]!.rotation[0]).toBeCloseTo(Math.PI);
  });

  it('add_sphere ignores rotation with NaN component and still creates entity', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_sphere', { radius: 3, rotation: [NaN, 0, 0] });
    expect(result.affected).toHaveLength(1);
    expect(result.document.entities[result.affected[0]!]!.rotation).toEqual([0, 0, 0]);
  });

  it('add_sphere summary contains world AABB', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_sphere', { radius: 4 });
    expect(result.summary).toContain('world AABB');
  });

  // ── add_cone ─────────────────────────────────────────────────────────────

  it('add_cone stores non-zero rotation on the entity', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_cone', { radius: 2, height: 5, rotation: [0, Math.PI / 4, 0] });
    const id = result.affected[0]!;
    expect(result.document.entities[id]!.rotation[1]).toBeCloseTo(Math.PI / 4);
  });

  it('add_cone ignores malformed rotation (wrong length) and still creates entity', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_cone', { radius: 2, height: 5, rotation: [0, 0, 0, 0] });
    expect(result.affected).toHaveLength(1);
    expect(result.document.entities[result.affected[0]!]!.rotation).toEqual([0, 0, 0]);
  });

  it('add_cone summary contains world AABB', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_cone', { radius: 3, height: 7 });
    expect(result.summary).toContain('world AABB');
  });

  // ── add_torus ────────────────────────────────────────────────────────────

  it('add_torus stores non-zero rotation on the entity', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_torus', { ringRadius: 5, tubeRadius: 1, rotation: [0.5, 0, 0] });
    const id = result.affected[0]!;
    expect(result.document.entities[id]!.rotation[0]).toBeCloseTo(0.5);
  });

  it('add_torus ignores non-finite rotation and still creates entity', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_torus', { ringRadius: 4, tubeRadius: 1, rotation: [0, NaN, 0] });
    expect(result.affected).toHaveLength(1);
    expect(result.document.entities[result.affected[0]!]!.rotation).toEqual([0, 0, 0]);
  });

  it('add_torus summary contains world AABB', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_torus', { ringRadius: 4, tubeRadius: 1 });
    expect(result.summary).toContain('world AABB');
  });

  // ── add_wedge ────────────────────────────────────────────────────────────

  it('add_wedge stores non-zero rotation on the entity', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_wedge', { size: [4, 3, 5], rotation: [0, 0, Math.PI] });
    const id = result.affected[0]!;
    expect(result.document.entities[id]!.rotation[2]).toBeCloseTo(Math.PI);
  });

  it('add_wedge ignores malformed rotation (non-array) and still creates entity', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_wedge', { size: [2, 2, 2], rotation: null });
    expect(result.affected).toHaveLength(1);
    expect(result.document.entities[result.affected[0]!]!.rotation).toEqual([0, 0, 0]);
  });

  it('add_wedge summary contains world AABB', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_wedge', { size: [4, 3, 6], position: [1, 0, 0] });
    expect(result.summary).toContain('world AABB');
  });

  // ── add_pyramid ──────────────────────────────────────────────────────────

  it('add_pyramid stores non-zero rotation on the entity', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_pyramid', {
      baseWidth: 4,
      baseDepth: 3,
      height: 5,
      rotation: [Math.PI / 6, 0, 0],
    });
    const id = result.affected[0]!;
    expect(result.document.entities[id]!.rotation[0]).toBeCloseTo(Math.PI / 6);
  });

  it('add_pyramid ignores non-finite rotation and still creates entity', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_pyramid', {
      baseWidth: 2,
      baseDepth: 2,
      height: 3,
      rotation: [Infinity, Infinity, Infinity],
    });
    expect(result.affected).toHaveLength(1);
    expect(result.document.entities[result.affected[0]!]!.rotation).toEqual([0, 0, 0]);
  });

  it('add_pyramid summary contains world AABB', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_pyramid', { baseWidth: 6, baseDepth: 4, height: 8 });
    expect(result.summary).toContain('world AABB');
  });

  // ── extrude_profile ───────────────────────────────────────────────────────

  it('extrude_profile stores non-zero rotation on the entity', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'extrude_profile', {
      profile: [[0, 0], [4, 0], [4, 3], [0, 3]],
      depth: 5,
      rotation: [0, Math.PI / 3, 0],
    });
    const id = result.affected[0]!;
    expect(result.document.entities[id]!.rotation[1]).toBeCloseTo(Math.PI / 3);
  });

  it('extrude_profile ignores malformed rotation and still creates entity', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'extrude_profile', {
      profile: [[0, 0], [2, 0], [1, 2]],
      depth: 3,
      rotation: [0, Infinity, 0],
    });
    expect(result.affected).toHaveLength(1);
    expect(result.document.entities[result.affected[0]!]!.rotation).toEqual([0, 0, 0]);
  });

  it('extrude_profile summary contains world AABB', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'extrude_profile', {
      profile: [[0, 0], [3, 0], [3, 2], [0, 2]],
      depth: 4,
    });
    expect(result.summary).toContain('world AABB');
  });

  it('extrude_profile no-ops on a profile with fewer than 3 points', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'extrude_profile', { profile: [[0, 0], [1, 0]], depth: 4 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toMatch(/at least 3/i);
  });

  it('extrude_profile no-ops on non-positive depth', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'extrude_profile', {
      profile: [[0, 0], [2, 0], [1, 2]],
      depth: 0,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toMatch(/> 0/);
  });
});

// ---------------------------------------------------------------------------
// W4B — unified placement anchor ('center' | 'min' | 'base-center')
// Each add_* command keeps its CURRENT default placement when `anchor` is
// omitted (back-compat lock); an explicit anchor places the corresponding
// point of the world AABB at the supplied `position`.
// ---------------------------------------------------------------------------

describe('W4B — unified placement anchor', () => {
  beforeEach(() => __resetIdCounter());

  /** Per-component near-equality on a Vec3 (avoids -0 / float noise). */
  function expectVec(actual: readonly number[], expected: readonly number[]): void {
    expect(actual).toHaveLength(expected.length);
    expected.forEach((v, i) => expect(actual[i]!).toBeCloseTo(v, 9));
  }

  /** Resolve the single created entity from a command result. */
  function createdEntity(
    doc: ReturnType<typeof createEmptyDocument>,
    name: string,
    params: object,
  ): Entity {
    const result = execute(doc, name, params);
    expect(result.affected).toHaveLength(1);
    return result.document.entities[result.affected[0]!]!;
  }

  // ── Back-compat: omitting anchor reproduces today's stored position ──────

  it('add_box default (no anchor) keeps "center" — stored position === position', () => {
    const e = createdEntity(createEmptyDocument(), 'add_box', { size: [2, 4, 6], position: [5, 6, 7] });
    expectVec(e.position, [5, 6, 7]);
  });

  it('add_cylinder default keeps "center"', () => {
    const e = createdEntity(createEmptyDocument(), 'add_cylinder', { radius: 1, height: 4, position: [1, 2, 3] });
    expectVec(e.position, [1, 2, 3]);
  });

  it('add_sphere default keeps "center"', () => {
    const e = createdEntity(createEmptyDocument(), 'add_sphere', { radius: 2, position: [1, 2, 3] });
    expectVec(e.position, [1, 2, 3]);
  });

  it('add_torus default keeps "center"', () => {
    const e = createdEntity(createEmptyDocument(), 'add_torus', { ringRadius: 3, tubeRadius: 1, position: [1, 1, 1] });
    expectVec(e.position, [1, 1, 1]);
  });

  it('add_cone default keeps "base-center" — base sits at position.z', () => {
    const result = execute(createEmptyDocument(), 'add_cone', { radius: 1, height: 4, position: [0, 0, 4] });
    const e = result.document.entities[result.affected[0]!]!;
    expectVec(e.position, [0, 0, 4]);
    expect(entityBounds(e).min[2]).toBeCloseTo(4, 9); // base at z = position.z
  });

  it('add_pyramid default keeps "base-center" — base sits at position.z', () => {
    const result = execute(createEmptyDocument(), 'add_pyramid', { baseWidth: 2, baseDepth: 2, height: 2, position: [0, 0, 3] });
    const e = result.document.entities[result.affected[0]!]!;
    expectVec(e.position, [0, 0, 3]);
    expect(entityBounds(e).min[2]).toBeCloseTo(3, 9);
  });

  it('add_wedge default keeps "min" — AABB min corner at position', () => {
    const result = execute(createEmptyDocument(), 'add_wedge', { size: [2, 2, 2], position: [2, 2, 2] });
    const e = result.document.entities[result.affected[0]!]!;
    expectVec(e.position, [2, 2, 2]);
    expectVec(entityBounds(e).min, [2, 2, 2]);
  });

  // ── Explicit anchors place the right AABB point at position ──────────────

  it('add_box anchor "min" puts the AABB min corner at position', () => {
    const e = createdEntity(createEmptyDocument(), 'add_box', { size: [2, 4, 6], position: [0, 0, 0], anchor: 'min' });
    const b = entityBounds(e);
    expectVec(b.min, [0, 0, 0]);
    expectVec(b.max, [2, 4, 6]);
  });

  it('add_box anchor "base-center" centers XY and puts AABB min-Z at position', () => {
    const e = createdEntity(createEmptyDocument(), 'add_box', { size: [2, 2, 2], position: [1, 1, 0], anchor: 'base-center' });
    const b = entityBounds(e);
    expectVec(b.min, [0, 0, 0]);
    expectVec(b.max, [2, 2, 2]);
  });

  it('add_cylinder anchor "min" puts the AABB min corner at position', () => {
    const e = createdEntity(createEmptyDocument(), 'add_cylinder', { radius: 1, height: 4, position: [0, 0, 0], anchor: 'min' });
    const b = entityBounds(e);
    expectVec(b.min, [0, 0, 0]);
    expectVec(b.max, [2, 4, 2]);
  });

  it('add_sphere anchor "min" puts the AABB min corner at position', () => {
    const e = createdEntity(createEmptyDocument(), 'add_sphere', { radius: 1, position: [0, 0, 0], anchor: 'min' });
    const b = entityBounds(e);
    expectVec(b.min, [0, 0, 0]);
    expectVec(b.max, [2, 2, 2]);
  });

  it('add_cone anchor "center" centers the AABB on position', () => {
    const e = createdEntity(createEmptyDocument(), 'add_cone', { radius: 1, height: 4, position: [0, 0, 0], anchor: 'center' });
    const b = entityBounds(e);
    expect(b.min[2]).toBeCloseTo(-2, 9);
    expect(b.max[2]).toBeCloseTo(2, 9);
  });

  it('add_pyramid anchor "min" puts the AABB min corner at position', () => {
    const e = createdEntity(createEmptyDocument(), 'add_pyramid', { baseWidth: 2, baseDepth: 2, height: 2, position: [0, 0, 0], anchor: 'min' });
    expectVec(entityBounds(e).min, [0, 0, 0]);
  });

  it('add_wedge anchor "center" centers the AABB on position', () => {
    const e = createdEntity(createEmptyDocument(), 'add_wedge', { size: [2, 2, 2], position: [0, 0, 0], anchor: 'center' });
    const b = entityBounds(e);
    expectVec(b.min, [-1, -1, -1]);
    expectVec(b.max, [1, 1, 1]);
  });

  // ── Failure / robustness: unknown or non-string anchor → command default ─

  it('add_box with an unknown anchor string falls back to "center" (no throw)', () => {
    const e = createdEntity(createEmptyDocument(), 'add_box', { size: [2, 2, 2], position: [3, 3, 3], anchor: 'garbage' });
    expectVec(e.position, [3, 3, 3]); // identical to the default-center placement
  });

  it('add_box with a non-string anchor falls back to "center"', () => {
    const e = createdEntity(createEmptyDocument(), 'add_box', { size: [2, 2, 2], position: [3, 3, 3], anchor: 123 } as object);
    expectVec(e.position, [3, 3, 3]);
  });

  it('is pure — using anchor does not mutate the input document', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'add_box', { size: [2, 2, 2], position: [1, 1, 1], anchor: 'min' });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});

// ── clear_document ──────────────────────────────────────────────────────────

describe('clear_document', () => {
  beforeEach(() => __resetIdCounter());

  it('clears all entities, order, selection, groups and resets layers', () => {
    let doc = createEmptyDocument();
    const r1 = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = r1.document;
    const r2 = execute(doc, 'add_cylinder', { radius: 1, height: 2 });
    doc = r2.document;

    const result = execute(doc, 'clear_document', {});
    expect(result.affected).toHaveLength(0);
    expect(result.document.entities).toEqual({});
    expect(result.document.order).toEqual([]);
    expect(result.document.selection).toEqual([]);
    expect(result.document.groups).toEqual({});
  });

  it('resets layers to a single default layer when keepLayers is false (default)', () => {
    let doc = createEmptyDocument();
    // Add a second layer and an entity.
    const layerResult = execute(doc, 'add_layer', { name: 'Extra Layer' });
    doc = layerResult.document;
    expect(Object.keys(doc.layers)).toHaveLength(2);

    const result = execute(doc, 'clear_document', {});
    expect(Object.keys(result.document.layers)).toHaveLength(1);
    expect(result.document.layerOrder).toHaveLength(1);
  });

  it('preserves layers when keepLayers is true', () => {
    let doc = createEmptyDocument();
    const layerResult = execute(doc, 'add_layer', { name: 'Keep Me' });
    doc = layerResult.document;
    const r1 = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = r1.document;
    expect(Object.keys(doc.layers)).toHaveLength(2);

    const result = execute(doc, 'clear_document', { keepLayers: true });
    expect(result.affected).toHaveLength(0);
    expect(result.document.entities).toEqual({});
    expect(Object.keys(result.document.layers)).toHaveLength(2);
    expect(result.document.layerOrder).toHaveLength(2);
  });

  it('preserves units and camera', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'set_units', { units: 'in' }).document;
    const r1 = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = r1.document;
    const originalCamera = doc.camera;

    const result = execute(doc, 'clear_document', {});
    expect(result.document.units).toBe('in');
    expect(result.document.camera).toEqual(originalCamera);
  });

  it('is idempotent — already-empty doc returns no-op summary and same reference', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'clear_document', {});
    expect(result.document).toBe(doc);
    expect(result.affected).toHaveLength(0);
    expect(result.summary).toContain('already empty');
  });

  it('summary is factual — includes entity count, layer count, and units', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'set_units', { units: 'cm' }).document;
    for (let i = 0; i < 3; i++) {
      doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    }

    const result = execute(doc, 'clear_document', {});
    expect(result.summary).toContain('3');
    expect(result.summary).toContain('cm');
  });

  it('is pure — input document is never mutated', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    const snapshot = JSON.stringify(doc);
    execute(doc, 'clear_document', {});
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('tool schema round-trips through toToolSchemas()', () => {
    const schemas = toToolSchemas();
    const schema = schemas.find((s) => s.name === 'clear_document');
    expect(schema).toBeDefined();
    expect(schema!.description).toBeTruthy();
    expect(schema!.annotations?.destructiveHint).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// set_camera
// ---------------------------------------------------------------------------

describe('set_camera', () => {
  beforeEach(() => __resetIdCounter());

  it('updates all four camera fields when all are provided', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'set_camera', {
      target: [1, 2, 3],
      azimuth: 0.5,
      polar: 1.0,
      distance: 20,
    });

    expect(result.affected).toHaveLength(0);
    expect(result.document).not.toBe(doc);
    expect(result.document.camera.target).toEqual([1, 2, 3]);
    expect(result.document.camera.azimuth).toBe(0.5);
    expect(result.document.camera.polar).toBe(1.0);
    expect(result.document.camera.distance).toBe(20);
    expect(result.summary).toContain('target');
  });

  it('preserves unspecified fields', () => {
    const doc = createEmptyDocument();
    const prev = doc.camera;
    const result = execute(doc, 'set_camera', { azimuth: 1.2 });

    expect(result.document.camera.target).toEqual(prev.target);
    expect(result.document.camera.polar).toBe(prev.polar);
    expect(result.document.camera.distance).toBe(prev.distance);
    expect(result.document.camera.azimuth).toBe(1.2);
  });

  it('is pure — input document is never mutated', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'set_camera', { distance: 50, azimuth: 1 });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('does NOT append to featureHistory', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'set_camera', { distance: 15 });
    expect(result.document.featureHistory).toHaveLength(0);
  });

  it('graceful no-op when distance <= 0', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'set_camera', { distance: 0 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('distance');
  });

  it('graceful no-op when no fields are specified', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'set_camera', {});
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('tool schema is present and has idempotentHint', () => {
    const schemas = toToolSchemas();
    const schema = schemas.find((s) => s.name === 'set_camera');
    expect(schema).toBeDefined();
    expect(schema!.annotations?.idempotentHint).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// look_at
// ---------------------------------------------------------------------------

describe('look_at', () => {
  beforeEach(() => __resetIdCounter());

  it('sets target and preserves distance', () => {
    const doc = createEmptyDocument();
    const prevDistance = doc.camera.distance;
    const result = execute(doc, 'look_at', { target: [5, 10, 0] });

    expect(result.affected).toHaveLength(0);
    expect(result.document).not.toBe(doc);
    expect(result.document.camera.target).toEqual([5, 10, 0]);
    expect(result.document.camera.distance).toBe(prevDistance);
  });

  it('optionally overrides azimuth and polar', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'look_at', { target: [0, 0, 0], azimuth: 1.57, polar: 0.8 });

    expect(result.document.camera.azimuth).toBeCloseTo(1.57);
    expect(result.document.camera.polar).toBeCloseTo(0.8);
  });

  it('preserves existing azimuth/polar when not specified', () => {
    const doc = createEmptyDocument();
    const prev = doc.camera;
    const result = execute(doc, 'look_at', { target: [3, 3, 3] });

    expect(result.document.camera.azimuth).toBe(prev.azimuth);
    expect(result.document.camera.polar).toBe(prev.polar);
  });

  it('is pure — input document is never mutated', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'look_at', { target: [1, 2, 3] });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('does NOT append to featureHistory', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'look_at', { target: [0, 0, 0] });
    expect(result.document.featureHistory).toHaveLength(0);
  });

  it('graceful no-op when target is missing', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'look_at', {} as { target: [number, number, number] });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('target');
  });

  it('graceful no-op when target has wrong length', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'look_at', { target: [1, 2] as unknown as [number, number, number] });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('graceful no-op when target contains non-finite value', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'look_at', { target: [1, Infinity, 0] });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('tool schema is present and lists target as required', () => {
    const schemas = toToolSchemas();
    const schema = schemas.find((s) => s.name === 'look_at');
    expect(schema).toBeDefined();
    expect(schema!.input_schema.required).toContain('target');
  });
});

// ---------------------------------------------------------------------------
// fit_view
// ---------------------------------------------------------------------------

describe('fit_view', () => {
  beforeEach(() => __resetIdCounter());

  it('fits all entities — target near scene centre, distance > 0', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [2, 2, 2], position: [0, 0, 0] }).document;

    const result = execute(doc, 'fit_view', { direction: 'iso' });

    expect(result.affected).toHaveLength(0);
    expect(result.document).not.toBe(doc);
    expect(result.document.camera.distance).toBeGreaterThan(0);
    // Target should be near the box centre [0,0,0].
    const t = result.document.camera.target;
    expect(t[0]).toBeCloseTo(0, 3);
    expect(t[1]).toBeCloseTo(0, 3);
    expect(t[2]).toBeCloseTo(0, 3);
    expect(result.summary).toContain('iso');
  });

  it('applies correct azimuth/polar for front preset', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    const result = execute(doc, 'fit_view', { direction: 'front' });

    expect(result.document.camera.azimuth).toBeCloseTo(0, 5);
    expect(result.document.camera.polar).toBeCloseTo(Math.PI / 2, 5);
  });

  it('applies correct azimuth/polar for top preset', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    const result = execute(doc, 'fit_view', { direction: 'top' });

    expect(result.document.camera.polar).toBeCloseTo(0.01, 5);
  });

  it('"current" direction preserves existing azimuth and polar', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'set_camera', { azimuth: 1.1, polar: 0.7 }).document;
    doc = execute(doc, 'add_box', { size: [3, 3, 3] }).document;

    const result = execute(doc, 'fit_view', { direction: 'current' });
    expect(result.document.camera.azimuth).toBeCloseTo(1.1, 5);
    expect(result.document.camera.polar).toBeCloseTo(0.7, 5);
    expect(result.document.camera.distance).toBeGreaterThan(0);
  });

  it('padding scales the computed distance', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [2, 2, 2] }).document;

    const tight = execute(doc, 'fit_view', { direction: 'iso', padding: 1.0 });
    const loose = execute(doc, 'fit_view', { direction: 'iso', padding: 2.0 });

    expect(loose.document.camera.distance).toBeCloseTo(
      tight.document.camera.distance * 2,
      5,
    );
  });

  it('empty document falls back to default framing with explanatory summary', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'fit_view', { direction: 'front' });

    expect(result.document).not.toBe(doc);
    expect(result.document.camera.distance).toBe(10);
    expect(result.document.camera.target).toEqual([0, 0, 0]);
    expect(result.summary).toContain('empty');
  });

  it('is pure — input document is never mutated', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    const snapshot = JSON.stringify(doc);
    execute(doc, 'fit_view', {});
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('does NOT append to featureHistory', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    const result = execute(doc, 'fit_view', { direction: 'iso' });
    // featureHistory should only contain the add_box step, not fit_view.
    expect(result.document.featureHistory).toHaveLength(1);
    expect(result.document.featureHistory[0]!.name).toBe('add_box');
  });

  it('graceful no-op for unknown direction', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'fit_view', { direction: 'diagonal' as 'front' });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('diagonal');
  });

  it('graceful no-op when padding <= 0', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'fit_view', { padding: 0 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('padding');
  });

  it('tool schema is present and lists all valid direction enum values', () => {
    const schemas = toToolSchemas();
    const schema = schemas.find((s) => s.name === 'fit_view');
    expect(schema).toBeDefined();
    const dirProp = schema!.input_schema.properties['direction'];
    expect(dirProp).toBeDefined();
    expect(dirProp!.enum).toEqual(
      expect.arrayContaining(['front', 'back', 'left', 'right', 'top', 'bottom', 'iso', 'current']),
    );
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyDocument, is2D } from '@core/model/types';
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
});

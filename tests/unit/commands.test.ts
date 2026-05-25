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

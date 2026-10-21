/** PHY-21 slice A: allow_interference, delete_interference_intent, set_part_grounded, doc.prototype persistence and the pure helpers. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { prototypeProblems } from '@core/commands/persistence/prototypeValidation';
import { connectivityItems } from '@core/geometry/assemblyCheck/connectivity';
import { halton, measureThickness } from '@core/geometry/assemblyCheck/thickness';
import { roundDeep, roundSignificant } from '@lib/significant';
import { worstStatus } from '@core/model/checkResult';
import { PROCESS_IDS, PROCESS_RULES } from '@core/model/processRules';

function twoBoxes(): { doc: CadDocument; a: string; b: string } {
  let doc = createEmptyDocument();
  const add = (x: number): string => {
    const result = execute(doc, 'add_box', { size: [10, 10, 10], position: [x, 0, 0] });
    doc = result.document;
    return result.affected[0] ?? '';
  };
  return { a: add(0), b: add(5), doc };
}

describe('allow_interference', () => {
  it('declares a sorted, step-scoped intent by the agent and survives save / reload', () => {
    const { doc, a, b } = twoBoxes();
    const result = execute(doc, 'allow_interference', { a: b, b: a, kind: 'press_fit', reason: '  pin pressed in  ' });
    const id = result.affected[0] ?? '';
    expect(id).toMatch(/^fit-\d+\.\d+$/);
    expect(result.document.prototype?.intents[id]).toEqual({
      id,
      a: [a, b].sort()[0],
      b: [a, b].sort()[1],
      kind: 'press_fit',
      reason: 'pin pressed in',
      declaredBy: 'agent',
    });
    expect(result.summary).toContain('by agent');
    const loaded = deserializeDocument(serializeDocument(result.document));
    expect(loaded.prototype).toEqual(result.document.prototype);
    const replayed = execute(result.document, 'replay_history', {}).document;
    expect(replayed.prototype).toEqual(result.document.prototype);
  });

  it('is pure: the input document is untouched', () => {
    const { doc, a, b } = twoBoxes();
    const before = JSON.stringify(doc);
    const result = execute(doc, 'allow_interference', { a, b, kind: 'weld', reason: 'seam' });
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.document).not.toBe(doc);
    expect(doc.prototype).toBeUndefined();
  });

  it('refuses a = b, unknown or 2D ids, an empty reason and a duplicate pair', () => {
    const { doc, a, b } = twoBoxes();
    const rect = execute(doc, 'draw_rectangle', { width: 4, height: 4 });
    const flat = rect.affected[0] ?? '';
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ a, b: a, kind: 'weld', reason: 'x' }, /two different parts/],
      [{ a, b: 'nope', kind: 'weld', reason: 'x' }, /not found/],
      [{ a, b: flat, kind: 'weld', reason: 'x' }, /2D/],
      [{ a, b, kind: 'weld', reason: '   ' }, /reason/],
    ];
    for (const [params, message] of cases) {
      const refused = execute(rect.document, 'allow_interference', params);
      expect(refused.affected).toEqual([]);
      expect(refused.document).toBe(rect.document);
      expect(refused.summary).toMatch(message);
    }
    const first = execute(doc, 'allow_interference', { a, b, kind: 'weld', reason: 'x' });
    const again = execute(first.document, 'allow_interference', { a: b, b: a, kind: 'thread', reason: 'y' });
    expect(again.affected).toEqual([]);
    expect(again.summary).toContain('already has intent');
    const bad = execute(doc, 'allow_interference', { a, b, kind: 'glue', reason: 'x' });
    expect(bad.rejected).toBe(true);
  });
});

describe('delete_interference_intent', () => {
  it('removes a declared intent and no-ops on an unknown id', () => {
    const { doc, a, b } = twoBoxes();
    const declared = execute(doc, 'allow_interference', { a, b, kind: 'thread', reason: 'bolt' });
    const id = declared.affected[0] ?? '';
    const removed = execute(declared.document, 'delete_interference_intent', { id });
    expect(removed.affected).toEqual([id]);
    expect(removed.document.prototype?.intents).toEqual({});
    expect(declared.document.prototype?.intents[id]).toBeDefined();
    const missing = execute(removed.document, 'delete_interference_intent', { id });
    expect(missing.affected).toEqual([]);
    expect(missing.document).toBe(removed.document);
    expect(execute(doc, 'delete_interference_intent', { id: 'fit-1.1' }).affected).toEqual([]);
  });
});

describe('set_part_grounded', () => {
  it('grounds and releases parts idempotently, in marking order', () => {
    const { doc, a, b } = twoBoxes();
    const first = execute(doc, 'set_part_grounded', { ids: [b, a], grounded: true });
    expect(first.affected).toEqual([b, a]);
    expect(first.document.prototype?.grounded).toEqual([b, a]);
    const repeat = execute(first.document, 'set_part_grounded', { ids: [a], grounded: true });
    expect(repeat.affected).toEqual([]);
    expect(repeat.document).toBe(first.document);
    const released = execute(first.document, 'set_part_grounded', { ids: [b], grounded: false });
    expect(released.document.prototype?.grounded).toEqual([a]);
    expect(first.document.prototype?.grounded).toEqual([b, a]);
    expect(deserializeDocument(serializeDocument(released.document)).prototype?.grounded).toEqual([a]);
  });

  it('refuses unknown and 2D ids', () => {
    const { doc } = twoBoxes();
    const rect = execute(doc, 'draw_rectangle', { width: 4, height: 4 });
    expect(execute(doc, 'set_part_grounded', { ids: ['nope'], grounded: true }).affected).toEqual([]);
    const flat = execute(rect.document, 'set_part_grounded', { ids: [rect.affected[0] ?? ''], grounded: true });
    expect(flat.affected).toEqual([]);
    expect(flat.summary).toContain('2D');
  });

  it('clear_document drops the prototype slice', () => {
    const { doc, a } = twoBoxes();
    const grounded = execute(doc, 'set_part_grounded', { ids: [a], grounded: true }).document;
    expect(execute(grounded, 'clear_document', {}).document.prototype).toBeUndefined();
  });
});

describe('prototype load validation', () => {
  const intent = { id: 'fit-1.1', a: 'x', b: 'y', kind: 'weld', reason: 'seam', declaredBy: 'agent' };
  it('accepts absence and a well-formed slice', () => {
    expect(prototypeProblems(undefined)).toEqual([]);
    expect(prototypeProblems({ intents: { 'fit-1.1': intent }, grounded: ['x'] })).toEqual([]);
  });
  it('reports each malformed field', () => {
    expect(prototypeProblems({ grounded: [] })[0]).toMatch(/prototype must be/);
    const broken = (patch: Record<string, unknown>): string[] =>
      prototypeProblems({ intents: { 'fit-1.1': { ...intent, ...patch } }, grounded: [] });
    expect(broken({ id: 'other' })[0]).toMatch(/whose id is/);
    expect(broken({ a: '' })[0]).toMatch(/non-empty/);
    expect(broken({ b: 'x' })[0]).toMatch(/must differ/);
    expect(broken({ kind: 'glue' })[0]).toMatch(/kind/);
    expect(broken({ reason: ' ' })[0]).toMatch(/reason/);
    expect(broken({ declaredBy: 'robot' })[0]).toMatch(/declaredBy/);
    expect(prototypeProblems({ intents: {}, grounded: ['x', 'x'] })[0]).toMatch(/duplicate/);
    expect(
      prototypeProblems({ intents: { constructor: intent }, grounded: [] }).length +
        prototypeProblems({ intents: { __proto__x: 1 }, grounded: [] }).length,
    ).toBeGreaterThan(0);
  });
  it('a document with a malformed prototype is rejected on load', () => {
    const { doc } = twoBoxes();
    const saved = JSON.parse(serializeDocument(doc)) as { document: Record<string, unknown> };
    saved.document['prototype'] = { intents: 'no', grounded: [] };
    expect(() => deserializeDocument(JSON.stringify(saved))).toThrow(/prototype/);
  });
});

describe('connectivity graph', () => {
  const parts = ['a', 'b', 'c', 'd'];
  it('lists floating groups, resting-only groups and ignores grounded ones', () => {
    const items = connectivityItems({ parts, strongLinks: [['a', 'b']], touchLinks: [['b', 'c']], grounded: new Set(['c']) });
    expect(items.map((item) => [item.code, item.ids])).toEqual([
      ['FPR_PART_FLOATING', ['d']],
      ['FPR_PART_RESTING_ONLY', ['a', 'b']],
    ]);
    expect(
      connectivityItems({
        parts,
        strongLinks: [
          ['a', 'b'],
          ['b', 'c'],
          ['c', 'd'],
        ],
        touchLinks: [],
        grounded: new Set(['d']),
      }),
    ).toEqual([]);
  });
  it('ignores links to unknown parts', () => {
    expect(connectivityItems({ parts: ['a'], strongLinks: [['a', 'zz']], touchLinks: [], grounded: new Set(['a']) })).toEqual([]);
  });
});

describe('helpers', () => {
  it('halton is the radical inverse', () => {
    expect([1, 2, 3, 4].map((i) => halton(i, 2))).toEqual([0.5, 0.25, 0.75, 0.125]);
    expect(halton(1, 3)).toBeCloseTo(1 / 3, 12);
  });
  it('thickness of a closed plate mesh is its thinnest side; degenerate meshes give null', () => {
    const [x, y, z] = [10, 10, 1];
    const positions = [0, 0, 0, x, 0, 0, x, y, 0, 0, y, 0, 0, 0, z, x, 0, z, x, y, z, 0, y, z];
    const indices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7];
    const report = measureThickness({ positions, indices }, 200, 0.2, 0.5);
    expect(report?.min).toBeCloseTo(1, 9);
    expect(report?.clusters.length).toBeGreaterThan(0);
    expect(measureThickness({ positions: [], indices: [] }, 10, 0, 0)).toBeNull();
    expect(measureThickness({ positions, indices }, 0, 0, 0)).toBeNull();
    expect(measureThickness({ positions: [0, 0, 0, 1, 0, 0, 2, 0, 0], indices: [0, 1, 2] }, 5, 0, 0)).toBeNull();
  });
  it('rounds to 12 significant digits and normalises -0', () => {
    expect(roundSignificant(0.1 + 0.2)).toBe(0.3);
    expect(roundSignificant(0)).toBe(0);
    expect(roundSignificant(Infinity)).toBe(Infinity);
    expect(roundDeep({ a: [1 / 3, -0], b: 'x', c: null })).toEqual({ a: [0.333333333333, 0], b: 'x', c: null });
  });
  it('status ranking and the process table', () => {
    expect(worstStatus([])).toBe('pass');
    expect(worstStatus(['info', 'pass', 'warn'])).toBe('warn');
    expect(worstStatus(['warn', 'not_run', 'pass'])).toBe('not_run');
    expect(worstStatus(['not_run', 'fail'])).toBe('fail');
    expect(PROCESS_IDS.every((id) => PROCESS_RULES[id].grade === 'B' && PROCESS_RULES[id].minWallMm > 0)).toBe(true);
    expect(PROCESS_RULES.cnc_metal.minWallMm).toBe(0.794);
  });
});

import { describe, it, expect } from 'vitest';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute, getCommand } from '@core/commands/registry';

function twoBoxes(): CadDocument {
  let doc = createEmptyDocument();
  doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
  doc = execute(doc, 'add_box', { size: [1, 1, 1], position: [5, 0, 0] }).document;
  return doc;
}

describe('move_entities', () => {
  it('is registered', () => {
    expect(getCommand('move_entities')).toBeDefined();
  });

  it('moves every listed entity by the delta in one step', () => {
    const doc = twoBoxes();
    const [a, b] = doc.order as [string, string];
    const result = execute(doc, 'move_entities', { ids: [a, b, a], delta: [1, 2, 3] });
    expect(result.affected).toEqual([a, b]);
    expect(result.document.entities[a]?.position).toEqual([1, 2, 3]);
    expect(result.document.entities[b]?.position).toEqual([6, 2, 3]);
    expect(result.summary).toMatch(/Moved 2 entities/);
  });

  it('skips missing ids and reports them', () => {
    const doc = twoBoxes();
    const [a] = doc.order as [string];
    const result = execute(doc, 'move_entities', { ids: [a, 'nope'], delta: [1, 0, 0] });
    expect(result.affected).toEqual([a]);
    expect(result.summary).toMatch(/Moved 1 entity .*Skipped missing: \[nope\]/);
  });

  it('is pure', () => {
    const doc = twoBoxes();
    const snapshot = structuredClone(doc);
    execute(doc, 'move_entities', { ids: doc.order, delta: [1, 1, 1] });
    expect(doc).toEqual(snapshot);
  });

  it.each([
    [{ ids: [], delta: [1, 0, 0] }, /non-empty array/],
    [{ ids: [1], delta: [1, 0, 0] }, /rejected: invalid params — ids\.0/],
    [{ ids: 'x', delta: [1, 0, 0] }, /rejected: invalid params — ids/],
    [{ ids: Array.from({ length: 100_000 }, (_, i) => `e${i}`), delta: [1, 0, 0] }, /exceeds/],
    [{ ids: ['a'], delta: [1, 0] }, /rejected: invalid params — delta/],
    [{ ids: ['a'], delta: [1, Number.NaN, 0] }, /rejected: invalid params — delta\.1/],
    [{ ids: ['missing'], delta: [1, 0, 0] }, /no listed entity exists/],
  ])('no-op on bad input %#', (params, message) => {
    const doc = twoBoxes();
    const result = execute(doc, 'move_entities', params);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.summary).toMatch(message);
  });
});

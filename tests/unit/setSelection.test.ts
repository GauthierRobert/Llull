import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

function withBoxes(): CadDocument {
  let doc = createEmptyDocument();
  for (let i = 0; i < 3; i += 1) doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
  return doc;
}

describe('set_selection', () => {
  const doc = withBoxes();
  const [a, b, c] = doc.order as [string, string, string];

  it('replace (default) sets the selection, records no FeatureStep, and is pure', () => {
    const before = JSON.stringify(doc);
    const result = execute(doc, 'set_selection', { ids: [a, b] });
    expect(result.document.selection).toEqual([a, b]);
    expect(result.document.order).toEqual(doc.order);
    expect(result.document.featureHistory).toEqual(doc.featureHistory);
    expect(result.affected).toEqual([]);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('add, remove and toggle', () => {
    const base = execute(doc, 'set_selection', { ids: [a] }).document;
    const added = execute(base, 'set_selection', { ids: [a, b], mode: 'add' }).document;
    expect(added.selection).toEqual([a, b]);
    expect(execute(added, 'set_selection', { ids: [a], mode: 'remove' }).document.selection).toEqual([b]);
    expect(execute(added, 'set_selection', { ids: [a, c], mode: 'toggle' }).document.selection).toEqual([b, c]);
  });

  it('empty replace clears; unknown ids are ignored and named', () => {
    const selected = execute(doc, 'set_selection', { ids: [a] }).document;
    expect(execute(selected, 'set_selection', { ids: [] }).document.selection).toEqual([]);
    const result = execute(selected, 'set_selection', { ids: ['nope', b] });
    expect(result.document.selection).toEqual([b]);
    expect(result.summary).toContain('nope');
  });

  it('unchanged selection returns the same document; invalid params are a no-op', () => {
    const selected = execute(doc, 'set_selection', { ids: [a] }).document;
    expect(execute(selected, 'set_selection', { ids: [a] }).document).toEqual(selected);
    expect(execute(selected, 'set_selection', { ids: ['ghost'], mode: 'add' }).document).toEqual(selected);
    const bad = execute(selected, 'set_selection', { ids: 'x' });
    expect(bad.document).toEqual(selected);
    expect(bad.summary).toContain('rejected');
  });
});

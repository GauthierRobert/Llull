import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { withEntities, withEntity } from '@core/commands/entityOps';

describe('withEntities', () => {
  const base = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
  const source = base.document.entities[base.affected[0]!]!;
  const copies = ['a', 'b', 'c'].map((id) => ({ ...source, id }));

  it('equals folding withEntity, without mutating the input', () => {
    const snapshot = JSON.stringify(base.document);
    const bulk = withEntities(base.document, copies);
    expect(bulk).toEqual(copies.reduce(withEntity, base.document));
    expect(JSON.stringify(base.document)).toBe(snapshot);
    expect(bulk.order.slice(-3)).toEqual(['a', 'b', 'c']);
  });

  it('returns the same document for an empty list', () => {
    expect(withEntities(base.document, [])).toBe(base.document);
  });
});

describe('bulk creators stay linear in the number of copies', () => {
  it('a 10000-copy array_linear finishes quickly', () => {
    const box = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
    const started = performance.now();
    const result = execute(box.document, 'array_linear', {
      id: box.affected[0]!,
      count: 10_000,
      offset: [2, 0, 0],
    });
    expect(result.affected).toHaveLength(9_999);
    // Was ~30 s when each copy re-spread the entity bag; generous bound keeps CI stable.
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});

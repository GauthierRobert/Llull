import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { serializeDocument } from '@core/commands/persistence';

function envelope(mutate: (document: Record<string, unknown>) => void): string {
  const doc = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
  const parsed = JSON.parse(serializeDocument(doc)) as { document: Record<string, unknown> };
  mutate(parsed.document);
  return JSON.stringify({ format: 'llull-document', version: 1, document: parsed.document });
}

describe('load_document rejects malformed documents as a no-op', () => {
  const doc = createEmptyDocument();
  const cases: Array<[string, (d: Record<string, unknown>) => void]> = [
    [
      'null entity',
      (d) => {
        (d['entities'] as Record<string, unknown>)['x'] = null;
      },
    ],
    [
      'entity without position',
      (d) => {
        const e = d['entities'] as Record<string, Record<string, unknown>>;
        delete e[Object.keys(e)[0]!]!['position'];
      },
    ],
    [
      'entity with unknown kind',
      (d) => {
        const e = d['entities'] as Record<string, Record<string, unknown>>;
        e[Object.keys(e)[0]!]!['kind'] = 'warp_drive';
      },
    ],
    [
      'entity with NaN-like string size',
      (d) => {
        const e = d['entities'] as Record<string, Record<string, unknown>>;
        e[Object.keys(e)[0]!]!['size'] = ['a', 'b', 'c'];
      },
    ],
    [
      'order references missing entity',
      (d) => {
        d['order'] = ['ghost'];
      },
    ],
    [
      'featureHistory step malformed',
      (d) => {
        d['featureHistory'] = [null];
      },
    ],
  ];
  for (const [label, mutate] of cases) {
    it(label, () => {
      const result = execute(doc, 'load_document', { json: envelope(mutate) });
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
    });
  }
});

describe('load_document back-compat defaults', () => {
  it('replaces wrong-typed optional fields with empty defaults instead of crashing', () => {
    const json = envelope((d) => {
      d['featureHistory'] = 'nope';
      d['parameters'] = [1, 2];
    });
    const result = execute(createEmptyDocument(), 'load_document', { json });
    expect(result.affected.length).toBeGreaterThan(0);
    expect(result.document.featureHistory).toEqual([]);
    expect(result.document.parameters).toEqual({});
  });
});

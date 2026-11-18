/** The saved text of a document is JSON.stringify of its envelope, byte for byte, built from per-entity / per-step text kept by identity. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execute } from '@core/commands/registry';
import { documentJson } from '@core/commands/persistence/documentJson';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { DEFAULT_LAYER_ID, createEmptyDocument, type CadDocument, type Entity } from '@core/model/types';

afterEach(() => vi.restoreAllMocks());

function sample(): CadDocument {
  let doc = createEmptyDocument();
  for (const [name, params] of [
    ['add_box', { size: [1, 2, 3] }],
    ['add_cylinder', { radius: 2, height: 5, position: [10, 0, 0] }],
    ['draw_line', { start: [0, 0], end: [5, 5] }],
    ['add_sphere', { radius: 1.5 }],
  ] as const)
    doc = execute(doc, name, params).document;
  return doc;
}

function serializedChars(work: () => void): number {
  const real = JSON.stringify;
  let total = 0;
  vi.spyOn(JSON, 'stringify').mockImplementation(((...args: Parameters<typeof JSON.stringify>) => {
    const out = real(...args);
    total += out?.length ?? 0;
    return out;
  }) as typeof JSON.stringify);
  work();
  return total;
}

describe('documentJson', () => {
  it('equals JSON.stringify of the document and of its envelope', () => {
    const doc = sample();
    expect(documentJson(doc)).toBe(JSON.stringify(doc));
    expect(serializeDocument(doc, { includeDerived: true })).toBe(JSON.stringify({ format: 'llull-document', version: 3, document: doc }));
    expect(deserializeDocument(serializeDocument(doc)).entities).toEqual(doc.entities);
  });

  it('equals JSON.stringify on the shapes it treats specially', () => {
    const odd = { toJSON: () => undefined };
    const cases: readonly unknown[] = [
      null,
      'text',
      [1, 2],
      {},
      {
        entities: { 10: { a: 1 }, 9: { b: [undefined, Number.NaN] }, name: undefined, gone: odd, '': null },
        featureHistory: [odd, undefined, { id: 's' }],
      },
      { entities: [1, 2], featureHistory: { not: 'a list' }, units: 'mm', skipped: undefined, fn: () => 1 },
      { entities: { toJSON: () => 'replaced' }, when: new Date(0) },
    ];
    for (const value of cases) expect(documentJson(value)).toBe(JSON.stringify(value));
  });

  it('prints only what a command changed: untouched entities and steps come from the remembered text', () => {
    const big = Array.from({ length: 300_000 }, (_, index) => index * 0.001);
    const base = sample();
    const mesh = {
      id: 'mesh-9.1',
      kind: 'mesh',
      layerId: DEFAULT_LAYER_ID,
      mesh: { positions: big, indices: [0, 1, 2] },
    } as unknown as Entity;
    const doc: CadDocument = { ...base, entities: { ...base.entities, 'mesh-9.1': mesh }, order: [...base.order, 'mesh-9.1'] };
    const first = serializeDocument(doc);
    expect(first.length).toBeGreaterThan(1_000_000);
    const next = execute(doc, 'add_box', { size: [4, 4, 4] }).document;
    expect(next.entities['mesh-9.1']).toBe(mesh);
    let text = '';
    expect(serializedChars(() => (text = serializeDocument(next)))).toBeLessThan(20_000);
    expect(text).toBe(JSON.stringify({ format: 'llull-document', version: 3, document: next }));
  });
});

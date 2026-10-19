/**
 * load_document refuses files nested deeper than any document llull writes: such a file loaded, then crashed every later save
 * (`JSON.stringify` overflows the stack around 10k levels). Found by the damaged-document corpus (SC-D2).
 */
import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { serializeDocument } from '@core/commands/persistence/serialization';

const withNestedField = (depth: number): string =>
  serializeDocument(createEmptyDocument()).replace('"document":{', `"document":{"extra":${'['.repeat(depth)}1${']'.repeat(depth)},`);

describe('load_document nesting depth', () => {
  it('refuses a 10k-level nested value and leaves the document unchanged', () => {
    const before = createEmptyDocument();
    const result = execute(before, 'load_document', { json: withNestedField(10_000) });
    expect(result.document).toBe(before);
    expect(result.affected).toEqual([]);
    expect(result.summary).toMatch(/nested deeper than 1000 levels/);
  });

  it('still loads a moderately nested value, and the result saves again', () => {
    const result = execute(createEmptyDocument(), 'load_document', { json: withNestedField(900) });
    expect(result.summary).toMatch(/^Loaded document/);
    expect(() => serializeDocument(result.document)).not.toThrow();
  });
});

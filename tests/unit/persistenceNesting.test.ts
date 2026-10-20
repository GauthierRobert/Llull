/**
 * load_document refuses files nested deeper than any document llull writes: such a file loaded, then crashed every later save
 * (`JSON.stringify` overflows the stack around 10k levels). Found by the damaged-document corpus (SC-D2).
 */
import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { serializeDocument } from '@core/commands/persistence/serialization';
import { exceedsNestingDepth } from '@core/commands/persistence/nestingDepth';

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

describe('exceedsNestingDepth', () => {
  const nestedObjects = (depth: number): unknown => JSON.parse('{"a":'.repeat(depth) + '1' + '}'.repeat(depth));

  it('counts arrays and objects alike, at and past the limit', () => {
    expect(exceedsNestingDepth(nestedObjects(10), 10)).toBe(false);
    expect(exceedsNestingDepth(nestedObjects(11), 10)).toBe(true);
    expect(exceedsNestingDepth([[[1]], { b: [{ c: [2] }] }], 5)).toBe(false);
    expect(exceedsNestingDepth([[[1]], { b: [{ c: [2] }] }], 4)).toBe(true);
    expect(exceedsNestingDepth(JSON.parse('{"__proto__":[[[[1]]]]}'), 4)).toBe(true);
    expect(exceedsNestingDepth(42, 0)).toBe(false);
  });

  it('a large mesh document costs no more than its JSON.parse (number arrays are never pushed)', () => {
    const vertices = 1_000_000;
    const positions = Array.from({ length: vertices * 3 }, (_, index) => index * 0.001);
    const indices = Array.from({ length: vertices * 3 }, (_, index) => index % vertices);
    const text = JSON.stringify({ document: { entities: { mesh1: { id: 'mesh1', kind: 'mesh', mesh: { positions, indices } } } } });
    let started = performance.now();
    const parsed: unknown = JSON.parse(text);
    const parseMs = performance.now() - started;
    started = performance.now();
    expect(exceedsNestingDepth(parsed, 1000)).toBe(false);
    const scanMs = performance.now() - started;
    // Pushing each of the 6M numbers would cost several times the parse; the bound tolerates coverage instrumentation and load.
    expect(scanMs).toBeLessThan(Math.max(parseMs * 2, 250));
  });
});

import { expect } from 'vitest';

/** Asserts `parsed` is a v3 llull-document envelope carrying a document. */
export function expectDocumentEnvelope(parsed: Record<string, unknown>): void {
  expect(parsed['format']).toBe('llull-document');
  expect(parsed['version']).toBe(3);
  expect(parsed['document']).toBeDefined();
}

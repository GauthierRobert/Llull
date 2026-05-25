import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { serializeDocument, deserializeDocument } from '@core/commands/persistence';
import { __resetIdCounter } from '@lib/id';

describe('serializeDocument / deserializeDocument', () => {
  beforeEach(() => __resetIdCounter());

  it('round-trips an empty document exactly', () => {
    const doc = createEmptyDocument();
    const result = deserializeDocument(serializeDocument(doc));
    expect(result).toEqual(doc);
  });

  it('round-trips a document with a box and a circle entity', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [2, 3, 4], position: [1, 0, 0] }).document;
    doc = execute(doc, 'draw_circle', { center: [0, 0], radius: 5 }).document;

    const serialized = serializeDocument(doc);
    const restored = deserializeDocument(serialized);

    expect(restored).toEqual(doc);
    expect(Object.keys(restored.entities)).toHaveLength(2);
    expect(restored.order).toHaveLength(2);
  });

  it('produces a string that contains the envelope fields', () => {
    const doc = createEmptyDocument();
    const json = serializeDocument(doc);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed['format']).toBe('llull-document');
    expect(parsed['version']).toBe(1);
    expect(parsed['document']).toBeDefined();
  });

  it('throws on invalid JSON', () => {
    expect(() => deserializeDocument('not-json{')).toThrow(/invalid JSON/i);
  });

  it('throws when valid JSON is not an object at the root', () => {
    // These parse successfully but are not records — the root-level guard must reject them.
    expect(() => deserializeDocument('42')).toThrow(/root level/i);
    expect(() => deserializeDocument('"hello"')).toThrow(/root level/i);
    expect(() => deserializeDocument('null')).toThrow(/root level/i);
    expect(() => deserializeDocument('[]')).toThrow(/root level/i);
  });

  it('throws on wrong format field', () => {
    const bad = JSON.stringify({ format: 'other-app', version: 1, document: {} });
    expect(() => deserializeDocument(bad)).toThrow(/format/i);
  });

  it('throws on missing format field', () => {
    const bad = JSON.stringify({ version: 1, document: {} });
    expect(() => deserializeDocument(bad)).toThrow(/format/i);
  });

  it('throws on wrong version', () => {
    const bad = JSON.stringify({ format: 'llull-document', version: 2, document: {} });
    expect(() => deserializeDocument(bad)).toThrow(/version/i);
  });

  it('throws on missing version field', () => {
    const bad = JSON.stringify({ format: 'llull-document', document: {} });
    expect(() => deserializeDocument(bad)).toThrow(/version/i);
  });

  it('throws when document is structurally invalid (missing camera)', () => {
    const env = {
      format: 'llull-document',
      version: 1,
      document: {
        entities: {},
        order: [],
        layers: {},
        layerOrder: [],
        selection: [],
        // camera intentionally omitted
      },
    };
    expect(() => deserializeDocument(JSON.stringify(env))).toThrow(/invalid/i);
  });

  it('throws when entities contain a malformed entry', () => {
    const doc = createEmptyDocument();
    const env = {
      format: 'llull-document',
      version: 1,
      document: {
        ...doc,
        entities: { 'bad-e': { id: 'bad-e' } }, // missing kind, position, etc.
        order: ['bad-e'],
      },
    };
    expect(() => deserializeDocument(JSON.stringify(env))).toThrow(/invalid/i);
  });

  it('throws when layers contain a malformed entry', () => {
    const doc = createEmptyDocument();
    const env = {
      format: 'llull-document',
      version: 1,
      document: {
        ...doc,
        layers: { 'bad-layer': { id: 'bad-layer' } }, // missing name, visible, locked
      },
    };
    expect(() => deserializeDocument(JSON.stringify(env))).toThrow(/invalid/i);
  });
});

describe('load_document command', () => {
  beforeEach(() => __resetIdCounter());

  it('happy path: replaces the document and reports entity/layer counts', () => {
    let sourceDoc = createEmptyDocument();
    sourceDoc = execute(sourceDoc, 'add_box', { size: [1, 1, 1] }).document;
    sourceDoc = execute(sourceDoc, 'draw_circle', { center: [0, 0], radius: 3 }).document;

    const json = serializeDocument(sourceDoc);
    const emptyDoc = createEmptyDocument();
    const result = execute(emptyDoc, 'load_document', { json });

    expect(result.affected).toEqual(sourceDoc.order);
    expect(result.document).toEqual(sourceDoc);
    expect(result.summary).toMatch(/2 entities/);
    expect(result.summary).toMatch(/1 layer/);
  });

  it('affected ids equal the loaded document order', () => {
    let sourceDoc = createEmptyDocument();
    sourceDoc = execute(sourceDoc, 'add_box', { size: [2, 2, 2] }).document;

    const json = serializeDocument(sourceDoc);
    const result = execute(createEmptyDocument(), 'load_document', { json });

    expect(result.affected).toEqual(result.document.order);
  });

  it('failure path: invalid JSON is a graceful no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'load_document', { json: '{{bad' });

    expect(result.document).toBe(doc);
    expect(result.affected).toHaveLength(0);
    expect(result.summary).toMatch(/invalid JSON/i);
  });

  it('failure path: wrong format is a graceful no-op', () => {
    const doc = createEmptyDocument();
    const bad = JSON.stringify({ format: 'unknown', version: 1, document: {} });
    const result = execute(doc, 'load_document', { json: bad });

    expect(result.document).toBe(doc);
    expect(result.affected).toHaveLength(0);
    expect(result.summary).toMatch(/format/i);
  });

  it('failure path: wrong version is a graceful no-op', () => {
    const doc = createEmptyDocument();
    const bad = JSON.stringify({ format: 'llull-document', version: 99, document: {} });
    const result = execute(doc, 'load_document', { json: bad });

    expect(result.document).toBe(doc);
    expect(result.affected).toHaveLength(0);
    expect(result.summary).toMatch(/version/i);
  });

  it('is pure — the input document is never mutated', () => {
    let sourceDoc = createEmptyDocument();
    sourceDoc = execute(sourceDoc, 'add_box', { size: [1, 2, 3] }).document;
    const json = serializeDocument(sourceDoc);

    const targetDoc = createEmptyDocument();
    const snapshot = JSON.stringify(targetDoc);
    execute(targetDoc, 'load_document', { json });
    expect(JSON.stringify(targetDoc)).toBe(snapshot);
  });

  it('summary uses singular "entity" when exactly one entity is loaded', () => {
    let sourceDoc = createEmptyDocument();
    sourceDoc = execute(sourceDoc, 'add_box', { size: [1, 1, 1] }).document;

    const json = serializeDocument(sourceDoc);
    const result = execute(createEmptyDocument(), 'load_document', { json });

    expect(result.summary).toMatch(/1 entity[^i]/);
  });
});

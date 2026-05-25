/**
 * Unit tests for core/mcp — MCP tool definitions + dispatcher + resource builders.
 *
 * All tests are pure: no network, no DOM, no SDK. A fake document is built
 * with `createEmptyDocument()` and ids are reset between tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { listCommands } from '@core/commands/registry';
import { __resetIdCounter } from '@lib/id';
import {
  buildMcpTools,
  applyMcpToolCall,
  listMcpResources,
  readMcpResource,
  CAD_RESOURCE_URIS,
} from '@core/mcp';

// ---------------------------------------------------------------------------
// buildMcpTools
// ---------------------------------------------------------------------------

describe('buildMcpTools()', () => {
  it('returns one tool per registered command', () => {
    const tools = buildMcpTools();
    expect(tools).toHaveLength(listCommands().length);
  });

  it('tool names match listCommands() names in order', () => {
    const tools = buildMcpTools();
    const commandNames = listCommands().map((c) => c.name);
    expect(tools.map((t) => t.name)).toEqual(commandNames);
  });

  it('every tool has a non-empty description', () => {
    for (const tool of buildMcpTools()) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it('every tool has an object inputSchema with type "object"', () => {
    for (const tool of buildMcpTools()) {
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.inputSchema).toBe('object');
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('uses camelCase inputSchema (not snake_case input_schema)', () => {
    for (const tool of buildMcpTools()) {
      // inputSchema must exist
      expect('inputSchema' in tool).toBe(true);
      // The Anthropic key must NOT be present on the MCP shape
      expect('input_schema' in tool).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// applyMcpToolCall — happy path
// ---------------------------------------------------------------------------

describe('applyMcpToolCall() — known command', () => {
  beforeEach(() => __resetIdCounter());

  it('add_box: returns a new document containing the box', () => {
    const doc = createEmptyDocument();
    const result = applyMcpToolCall(doc, 'add_box', { size: [2, 2, 2] });

    expect(result.isError).toBe(false);
    expect(result.document).not.toBe(doc);
    expect(result.document.order).toHaveLength(1);

    const id = result.document.order[0]!;
    expect(result.document.entities[id]!.kind).toBe('box');
  });

  it('add_box: affected contains the new entity id', () => {
    const doc = createEmptyDocument();
    const result = applyMcpToolCall(doc, 'add_box', { size: [2, 2, 2] });

    expect(result.affected).toHaveLength(1);
    expect(result.document.order).toContain(result.affected[0]);
  });

  it('add_box: first content block is summary text mentioning "box"', () => {
    const doc = createEmptyDocument();
    const result = applyMcpToolCall(doc, 'add_box', { size: [1, 1, 1] });

    // add_box produces affected ids → content has 2 blocks: summary + affected
    expect(result.content.length).toBeGreaterThanOrEqual(1);
    expect(result.content[0]!.type).toBe('text');
    expect(result.content[0]!.text.length).toBeGreaterThan(0);
    // The summary from add_box mentions "box"
    expect(result.content[0]!.text).toMatch(/box/i);
  });

  it('add_box: second content block carries the affected entity id', () => {
    const doc = createEmptyDocument();
    const result = applyMcpToolCall(doc, 'add_box', { size: [1, 1, 1] });

    // shapeToolCallContent appends an "Affected entity ids: ..." block when affected is non-empty
    expect(result.content).toHaveLength(2);
    expect(result.content[1]!.text).toMatch(/Affected entity ids:/);
  });
});

// ---------------------------------------------------------------------------
// applyMcpToolCall — unknown tool
// ---------------------------------------------------------------------------

describe('applyMcpToolCall() — unknown tool name', () => {
  beforeEach(() => __resetIdCounter());

  it('returns isError true', () => {
    const doc = createEmptyDocument();
    const result = applyMcpToolCall(doc, 'nonexistent_tool', {});
    expect(result.isError).toBe(true);
  });

  it('document is the same reference as input (unchanged)', () => {
    const doc = createEmptyDocument();
    const result = applyMcpToolCall(doc, 'nonexistent_tool', {});
    expect(result.document).toBe(doc);
  });

  it('affected is empty', () => {
    const doc = createEmptyDocument();
    const result = applyMcpToolCall(doc, 'nonexistent_tool', {});
    expect(result.affected).toHaveLength(0);
  });

  it('content text describes the unknown command', () => {
    const doc = createEmptyDocument();
    const result = applyMcpToolCall(doc, 'nonexistent_tool', {});
    expect(result.content[0]!.text).toMatch(/unknown command/i);
  });
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

describe('applyMcpToolCall() — purity', () => {
  beforeEach(() => __resetIdCounter());

  it('input document is not mutated by a successful command', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    applyMcpToolCall(doc, 'add_box', { size: [3, 3, 3] });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('input document is not mutated by an unknown command', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    applyMcpToolCall(doc, 'unknown_xyz', {});
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// listMcpResources
// ---------------------------------------------------------------------------

describe('listMcpResources()', () => {
  it('returns exactly three resource descriptors', () => {
    expect(listMcpResources()).toHaveLength(3);
  });

  it('includes all three expected URIs', () => {
    const uris = listMcpResources().map((r) => r.uri);
    expect(uris).toContain(CAD_RESOURCE_URIS.document);
    expect(uris).toContain(CAD_RESOURCE_URIS.scene);
    expect(uris).toContain(CAD_RESOURCE_URIS.selection);
  });

  it('every descriptor has a non-empty name, description, and mimeType', () => {
    for (const r of listMcpResources()) {
      expect(r.name.length).toBeGreaterThan(0);
      expect(r.description.length).toBeGreaterThan(0);
      expect(r.mimeType).toBe('application/json');
    }
  });

  it('CAD_RESOURCE_URIS.document is cad://document', () => {
    expect(CAD_RESOURCE_URIS.document).toBe('cad://document');
  });

  it('CAD_RESOURCE_URIS.scene is cad://scene', () => {
    expect(CAD_RESOURCE_URIS.scene).toBe('cad://scene');
  });

  it('CAD_RESOURCE_URIS.selection is cad://selection', () => {
    expect(CAD_RESOURCE_URIS.selection).toBe('cad://selection');
  });
});

// ---------------------------------------------------------------------------
// readMcpResource — cad://document
// ---------------------------------------------------------------------------

describe('readMcpResource() — cad://document', () => {
  it('returns non-null content for an empty document', () => {
    const doc = createEmptyDocument();
    const content = readMcpResource(doc, 'cad://document');
    expect(content).not.toBeNull();
  });

  it('content uri matches the requested URI', () => {
    const doc = createEmptyDocument();
    const content = readMcpResource(doc, 'cad://document');
    expect(content!.uri).toBe('cad://document');
  });

  it('text is valid JSON containing the llull-document envelope', () => {
    const doc = createEmptyDocument();
    const content = readMcpResource(doc, 'cad://document');
    const parsed = JSON.parse(content!.text) as Record<string, unknown>;
    expect(parsed['format']).toBe('llull-document');
    expect(parsed['version']).toBe(1);
    expect(parsed['document']).toBeDefined();
  });

  it('does not mutate the input document', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    readMcpResource(doc, 'cad://document');
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// readMcpResource — cad://scene
// ---------------------------------------------------------------------------

describe('readMcpResource() — cad://scene', () => {
  beforeEach(() => __resetIdCounter());

  it('returns non-null content for an empty document', () => {
    const doc = createEmptyDocument();
    const content = readMcpResource(doc, 'cad://scene');
    expect(content).not.toBeNull();
  });

  it('content uri matches cad://scene', () => {
    const doc = createEmptyDocument();
    const content = readMcpResource(doc, 'cad://scene');
    expect(content!.uri).toBe('cad://scene');
  });

  it('text is valid JSON with entityCount=0 for empty document', () => {
    const doc = createEmptyDocument();
    const content = readMcpResource(doc, 'cad://scene');
    const parsed = JSON.parse(content!.text) as Record<string, unknown>;
    expect(parsed['entityCount']).toBe(0);
    expect(Array.isArray(parsed['entities'])).toBe(true);
    expect(Array.isArray(parsed['layers'])).toBe(true);
  });

  it('reflects the entity count after a box is added', () => {
    const doc = createEmptyDocument();
    const afterAdd = applyMcpToolCall(doc, 'add_box', { size: [1, 1, 1] }).document;
    const content = readMcpResource(afterAdd, 'cad://scene');
    const parsed = JSON.parse(content!.text) as Record<string, unknown>;
    expect(parsed['entityCount']).toBe(1);
  });

  it('does not mutate the input document', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    readMcpResource(doc, 'cad://scene');
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// readMcpResource — cad://selection
// ---------------------------------------------------------------------------

describe('readMcpResource() — cad://selection', () => {
  it('returns non-null content', () => {
    const doc = createEmptyDocument();
    const content = readMcpResource(doc, 'cad://selection');
    expect(content).not.toBeNull();
  });

  it('content uri matches cad://selection', () => {
    const doc = createEmptyDocument();
    const content = readMcpResource(doc, 'cad://selection');
    expect(content!.uri).toBe('cad://selection');
  });

  it('count is 0 and entities is empty array when nothing is selected', () => {
    const doc = createEmptyDocument();
    const content = readMcpResource(doc, 'cad://selection');
    const parsed = JSON.parse(content!.text) as { count: number; entities: unknown[] };
    expect(parsed.count).toBe(0);
    expect(parsed.entities).toHaveLength(0);
  });

  it('does not mutate the input document', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    readMcpResource(doc, 'cad://selection');
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// readMcpResource — unknown URI
// ---------------------------------------------------------------------------

describe('readMcpResource() — unknown URI', () => {
  it('returns null for an unknown URI', () => {
    const doc = createEmptyDocument();
    expect(readMcpResource(doc, 'cad://unknown')).toBeNull();
    expect(readMcpResource(doc, 'http://example.com')).toBeNull();
    expect(readMcpResource(doc, '')).toBeNull();
  });
});

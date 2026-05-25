/**
 * Unit tests for core/mcp — MCP tool definitions + dispatcher.
 *
 * All tests are pure: no network, no DOM, no SDK. A fake document is built
 * with `createEmptyDocument()` and ids are reset between tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { listCommands } from '@core/commands/registry';
import { __resetIdCounter } from '@lib/id';
import { buildMcpTools, applyMcpToolCall } from '@core/mcp';

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

  it('add_box: content is a non-empty text array whose text includes summary', () => {
    const doc = createEmptyDocument();
    const result = applyMcpToolCall(doc, 'add_box', { size: [1, 1, 1] });

    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');
    expect(result.content[0]!.text.length).toBeGreaterThan(0);
    // The summary from add_box mentions "box"
    expect(result.content[0]!.text).toMatch(/box/i);
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

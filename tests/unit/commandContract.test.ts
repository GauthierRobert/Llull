/**
 * Unit tests for the W1 command-contract extension:
 *   - `CommandResult.data` (query channel) round-trips through `shapeToolCallContent`
 *     (the single shaping implementation) and through `applyMcpToolCall` (thin wrapper).
 *   - `ParamSpec` supports `enum`, nested `object` properties, and array-of-objects
 *     `items` — and those shapes are preserved verbatim (the tool-schema generators
 *     map `paramsSchema` through unchanged).
 *
 * The registry is mocked here so we can exercise the `data` passthrough without a
 * real query command (the first one, measure_*, lands with M1).
 *
 * shapeToolCallContent is the authoritative shaping function — applyMcpToolCall
 * delegates to it.  Both are tested here; the shaper tests do NOT touch the
 * registry or a document (pure inputs only).
 */

import { describe, it, expect, vi } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { CommandResult, ParamsSchema } from '@core/commands/types';

vi.mock('@core/commands/registry', () => ({
  getCommand: (name: string) => (name === 'fake_measure' || name === 'fake_noop' ? { name } : undefined),
  execute: (doc: unknown, name: string): CommandResult => {
    const document = doc as ReturnType<typeof createEmptyDocument>;
    if (name === 'fake_measure') {
      return { document, summary: 'distance = 5 mm', affected: [], data: { distance: 5, unit: 'mm' } };
    }
    return { document, summary: 'no-op', affected: [] };
  },
}));

import { shapeToolCallContent } from '@core/mcp/dispatch';
import { applyMcpToolCall } from '@core/mcp/dispatch';

// ---------------------------------------------------------------------------
// shapeToolCallContent — the single shaping implementation
// ---------------------------------------------------------------------------

describe('shapeToolCallContent() — pure shaping', () => {
  it('always produces a summary text block', () => {
    const shaped = shapeToolCallContent({ summary: 'hello', affected: [], isError: false });
    expect(shaped.content).toHaveLength(1);
    expect(shaped.content[0]!.type).toBe('text');
    expect(shaped.content[0]!.text).toBe('hello');
  });

  it('adds affected-ids block when affected is non-empty', () => {
    const shaped = shapeToolCallContent({
      summary: 'created box',
      affected: ['e-001', 'e-002'],
      isError: false,
    });
    expect(shaped.content).toHaveLength(2);
    expect(shaped.content[1]!.text).toBe('Affected entity ids: e-001, e-002');
  });

  it('does NOT add affected block when affected is empty', () => {
    const shaped = shapeToolCallContent({ summary: 'ok', affected: [], isError: false });
    expect(shaped.content).toHaveLength(1);
  });

  it('adds json block when data is defined', () => {
    const shaped = shapeToolCallContent({
      summary: 'measured',
      affected: [],
      isError: false,
      data: { volume: 8, unit: 'mm³' },
    });
    // summary block + json block = 2
    expect(shaped.content).toHaveLength(2);
    expect(shaped.content[1]!.text).toMatch(/^```json\n/);
    expect(shaped.content[1]!.text).toContain('"volume": 8');
  });

  it('sets structuredContent for record-type data', () => {
    const data = { volume: 8, unit: 'mm³' };
    const shaped = shapeToolCallContent({
      summary: 'measured',
      affected: [],
      isError: false,
      data,
    });
    expect(shaped.structuredContent).toEqual(data);
  });

  it('does NOT set structuredContent for array-type data', () => {
    const shaped = shapeToolCallContent({
      summary: 'list result',
      affected: [],
      isError: false,
      data: [1, 2, 3],
    });
    expect(shaped.structuredContent).toBeUndefined();
  });

  it('does NOT set structuredContent when data is null', () => {
    const shaped = shapeToolCallContent({
      summary: 'null data',
      affected: [],
      isError: false,
      data: null,
    });
    // null is not a record → no structuredContent
    expect(shaped.structuredContent).toBeUndefined();
    // but a json block IS added for null
    expect(shaped.content.length).toBeGreaterThanOrEqual(2);
  });

  it('propagates isError: true for unknown commands', () => {
    const shaped = shapeToolCallContent({
      summary: 'Unknown command: ghost',
      affected: [],
      isError: true,
    });
    expect(shaped.isError).toBe(true);
    expect(shaped.content[0]!.text).toMatch(/unknown command/i);
  });

  it('all three blocks appear together (affected + data)', () => {
    const shaped = shapeToolCallContent({
      summary: 'done',
      affected: ['e-abc'],
      isError: false,
      data: { x: 1 },
    });
    // summary + affected + json
    expect(shaped.content).toHaveLength(3);
    expect(shaped.content[1]!.text).toMatch(/Affected entity ids/);
    expect(shaped.content[2]!.text).toMatch(/```json/);
    expect(shaped.structuredContent).toEqual({ x: 1 });
  });
});

// ---------------------------------------------------------------------------
// applyMcpToolCall — delegates to shapeToolCallContent (registry mock active)
// ---------------------------------------------------------------------------

describe('CommandResult.data — MCP passthrough via applyMcpToolCall', () => {
  it('surfaces `data` when the command produced it', () => {
    const result = applyMcpToolCall(createEmptyDocument(), 'fake_measure', {});
    expect(result.isError).toBe(false);
    expect(result.data).toEqual({ distance: 5, unit: 'mm' });
    // the human summary is still carried in content
    expect(result.content[0]!.text).toMatch(/distance/i);
  });

  it('omits the `data` field when the command produced none', () => {
    const result = applyMcpToolCall(createEmptyDocument(), 'fake_noop', {});
    expect(result.isError).toBe(false);
    expect('data' in result).toBe(false);
  });

  it('unknown tool is an error and carries no data', () => {
    const result = applyMcpToolCall(createEmptyDocument(), 'not_a_command', {});
    expect(result.isError).toBe(true);
    expect('data' in result).toBe(false);
  });

  it('fake_measure: structuredContent is set (record-type data)', () => {
    const result = applyMcpToolCall(createEmptyDocument(), 'fake_measure', {});
    expect(result.structuredContent).toEqual({ distance: 5, unit: 'mm' });
  });

  it('fake_noop: no structuredContent (no data)', () => {
    const result = applyMcpToolCall(createEmptyDocument(), 'fake_noop', {});
    expect(result.structuredContent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ParamSpec — richer schemas (unchanged from original)
// ---------------------------------------------------------------------------

describe('ParamSpec — richer schemas', () => {
  it('accepts `enum` and preserves the allowed values', () => {
    const schema: ParamsSchema = {
      type: 'object',
      properties: {
        axis: { type: 'string', description: 'Rotation axis', enum: ['x', 'y', 'z'] },
      },
      required: ['axis'],
    };
    expect(schema.properties.axis!.enum).toEqual(['x', 'y', 'z']);
  });

  it('accepts nested object properties', () => {
    const schema: ParamsSchema = {
      type: 'object',
      properties: {
        origin: {
          type: 'object',
          description: 'Placement origin',
          properties: {
            x: { type: 'number', description: 'X' },
            y: { type: 'number', description: 'Y' },
          },
        },
      },
      required: ['origin'],
    };
    expect(schema.properties.origin!.properties!.x!.type).toBe('number');
  });

  it('accepts array-of-objects items (description optional on primitive items)', () => {
    const schema: ParamsSchema = {
      type: 'object',
      properties: {
        points: {
          type: 'array',
          description: 'Polyline points',
          items: { type: 'object', properties: { x: { type: 'number', description: 'X' } } },
        },
        flat: { type: 'array', description: 'Flat coords', items: { type: 'number' } },
      },
      required: ['points'],
    };
    expect(schema.properties.points!.items!.type).toBe('object');
    expect(schema.properties.flat!.items!.type).toBe('number');
  });
});

/**
 * Unit tests for the W1 command-contract extension:
 *   - `CommandResult.data` (query channel) round-trips through `applyMcpToolCall`.
 *   - `ParamSpec` supports `enum`, nested `object` properties, and array-of-objects
 *     `items` — and those shapes are preserved verbatim (the tool-schema generators
 *     map `paramsSchema` through unchanged).
 *
 * The registry is mocked here so we can exercise the `data` passthrough without a
 * real query command (the first one, measure_*, lands with M1).
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

import { applyMcpToolCall } from '@core/mcp/dispatch';

describe('CommandResult.data — MCP passthrough', () => {
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
});

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

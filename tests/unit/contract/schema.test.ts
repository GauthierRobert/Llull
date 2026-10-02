/**
 * MG2 defineCommand / toParamsSchema: one zod schema drives the agent-facing schema and
 * runtime validation in `execute`.
 */
import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defineCommand, formatIssues, toParamsSchema, vec2, vec3, z } from '@core/commands/schema';

describe('toParamsSchema', () => {
  it('maps primitives, optionality, enums, tuples, arrays and nested objects', () => {
    const schema = toParamsSchema(
      z.object({
        count: z.number().int().describe('How many'),
        label: z.string().optional().describe('Label'),
        flag: z.boolean().default(false).describe('Flag'),
        mode: z.enum(['a', 'b']).describe('Mode'),
        kind: z.literal('box').describe('Kind'),
        side: z.union([z.literal('left'), z.literal('right')]).describe('Side'),
        level: z.union([z.literal(1), z.literal(2)]).describe('Level'),
        either: z.union([z.number(), z.string()]).describe('Either'),
        note: z.string().nullable().describe('Note'),
        at: vec2('Point'),
        position: vec3('Position'),
        points: z.array(z.array(z.number())).describe('Points'),
        bag: z.record(z.string(), z.unknown()).describe('Bag'),
        nested: z
          .object({
            inner: z.number().describe('Inner'),
            opt: z.string().optional().describe('Opt'),
          })
          .describe('Nested'),
        empty: z.object({}).describe('Empty'),
        items: z
          .array(z.object({ id: z.string().describe('Id') }).describe('Item'))
          .describe('Items'),
      }),
    );
    expect(schema.required).toEqual([
      'count',
      'mode',
      'kind',
      'side',
      'level',
      'either',
      'note',
      'at',
      'position',
      'points',
      'bag',
      'nested',
      'empty',
      'items',
    ]);
    expect(schema.properties['count']).toEqual({ type: 'number', description: 'How many' });
    expect(schema.properties['flag']).toEqual({ type: 'boolean', description: 'Flag' });
    expect(schema.properties['mode']).toEqual({
      type: 'string',
      description: 'Mode',
      enum: ['a', 'b'],
    });
    expect(schema.properties['kind']?.enum).toEqual(['box']);
    expect(schema.properties['side']?.enum).toEqual(['left', 'right']);
    expect(schema.properties['level']).toMatchObject({ type: 'number', enum: [1, 2] });
    expect(schema.properties['either']).toEqual({ type: 'number', description: 'Either' });
    expect(schema.properties['position']).toEqual({
      type: 'array',
      description: 'Position',
      items: { type: 'number' },
    });
    expect(schema.properties['points']?.items).toEqual({
      type: 'array',
      items: { type: 'number' },
    });
    expect(schema.properties['bag']).toEqual({ type: 'object', description: 'Bag' });
    expect(schema.properties['nested']).toEqual({
      type: 'object',
      description: 'Nested',
      properties: {
        inner: { type: 'number', description: 'Inner' },
        opt: { type: 'string', description: 'Opt' },
      },
      required: ['inner'],
    });
    expect(schema.properties['empty']).toEqual({ type: 'object', description: 'Empty' });
    expect(schema.properties['items']?.items).toEqual({
      type: 'object',
      description: 'Item',
      properties: { id: { type: 'string', description: 'Id' } },
      required: ['id'],
    });
  });

  it('requires a description on every top-level property', () => {
    expect(() => toParamsSchema(z.object({ bare: z.number() }))).toThrow(/bare/);
  });
});

describe('formatIssues', () => {
  it('names the path, message and offending input', () => {
    const result = z
      .object({ size: vec3('Size') })
      .safeParse({ size: [1, 'x', 2] }, { reportInput: true });
    expect(result.success).toBe(false);
    if (!result.success) expect(formatIssues(result.error)).toMatch(/^size\.1: .*\(got "x"\)/);
  });

  it('labels root-level issues', () => {
    const result = z.object({}).safeParse(5);
    if (!result.success) expect(formatIssues(result.error)).toMatch(/^\(params\): /);
  });
});

describe('defineCommand', () => {
  const echo = defineCommand({
    name: 'echo_test',
    description: 'Test command.',
    params: z.object({ value: z.number().describe('Value') }),
    annotations: { readOnly: true },
    run: (doc, { value }) => ({ document: doc, summary: `value ${value}`, affected: [] }),
  });

  it('derives paramsSchema and keeps annotations', () => {
    expect(echo.paramsSchema.required).toEqual(['value']);
    expect(echo.annotations).toEqual({ readOnly: true });
  });

  it('validator keeps unknown keys (recorded legacy params still pass)', () => {
    expect(echo.paramsValidator?.safeParse({ value: 1, legacy: true }).success).toBe(true);
    expect(echo.paramsValidator?.safeParse({ value: 'x' }).success).toBe(false);
  });

  it('omits annotations when none are given', () => {
    const bare = defineCommand({
      name: 'bare_test',
      description: 'Test.',
      params: z.object({}),
      run: (doc) => ({ document: doc, summary: '', affected: [] }),
    });
    expect('annotations' in bare).toBe(false);
  });
});

describe('execute validates migrated commands', () => {
  it('no-ops set_units with an invalid unit and reports the path and input', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'set_units', { units: 'km' });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.summary).toMatch(/set_units rejected: invalid params — units: .*"km"/);
  });
});

import { describe, it, expect } from 'vitest';
import { execute, getCommand } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { toParamsSchema, z } from '@core/commands/schema';

describe('union params publish every branch', () => {
  it('set_dynamics_solver.timestepS is anyOf [enum auto, number]', () => {
    const spec = getCommand('set_dynamics_solver')!.paramsSchema.properties['timestepS']!;
    expect(spec.type).toBeUndefined();
    expect(spec.description).toBeTruthy();
    expect(spec.anyOf?.map((b) => b.type)).toEqual(['string', 'number']);
    expect(spec.anyOf?.[0]?.enum).toEqual(['auto']);
  });

  it('keeps object branches with their fields (set_temperature_field.source)', () => {
    const spec = getCommand('set_temperature_field')!.paramsSchema.properties['source']!;
    expect(spec.anyOf?.length).toBeGreaterThan(1);
    expect(spec.anyOf?.every((b) => b.type === 'object' && Object.keys(b.properties ?? {}).length > 0)).toBe(true);
  });

  it('compute_margins.allowable keeps its object branch', () => {
    const spec = getCommand('compute_margins')!.paramsSchema.properties['allowable']!;
    expect(spec.anyOf?.map((b) => b.type)).toContain('object');
  });

  it('collapses same-typed branches and single-branch unions, and nests anyOf in items', () => {
    const schema = toParamsSchema(
      z.object({
        a: z.union([z.string(), z.string().min(1)]).describe('a'),
        b: z.array(z.union([z.number(), z.string()])).describe('b'),
        c: z.union([z.literal('x'), z.literal('y')]).describe('c'),
      }),
    );
    expect(schema.properties['a']).toEqual({ type: 'string', description: 'a' });
    expect(schema.properties['b']?.items?.anyOf?.map((x) => x.type)).toEqual(['number', 'string']);
    expect(schema.properties['c']).toMatchObject({ type: 'string', enum: ['x', 'y'] });
  });
});

describe('unknown params are named in the summary', () => {
  it('a misspelled key is ignored but reported, with the known keys', () => {
    const r = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1], colour: '#ffffff' });
    expect(r.affected).toHaveLength(1);
    expect(r.summary).toContain('ignored unknown param(s): colour (known: size');
  });

  it('is also reported on a rejected call, and absent when every key is known', () => {
    const rejected = execute(createEmptyDocument(), 'add_box', { sizes: [1, 1, 1] });
    expect(rejected.rejected).toBe(true);
    expect(rejected.summary).toContain('ignored unknown param(s): sizes');
    expect(execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).summary).not.toContain('ignored unknown');
  });
});

describe('record params publish their value schema', () => {
  it('emits additionalProperties for a typed record and nothing for a record of unknown', () => {
    const schema = toParamsSchema(
      z.object({
        typed: z.record(z.string(), z.object({ kind: z.enum(['secant', 'instantaneous']).describe('basis') })).describe('typed'),
        open: z.record(z.string(), z.unknown()).describe('open'),
      }),
    );
    expect(schema.properties['typed']).toMatchObject({
      type: 'object',
      additionalProperties: { type: 'object', properties: { kind: { enum: ['secant', 'instantaneous'] } }, required: ['kind'] },
    });
    expect(schema.properties['open']?.additionalProperties).toBeUndefined();
  });
});

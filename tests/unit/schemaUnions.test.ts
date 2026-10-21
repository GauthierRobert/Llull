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

describe('unknown params are rejected', () => {
  it('a misspelled key rejects the call and suggests the closest declared key', () => {
    const doc = createEmptyDocument();
    const r = execute(doc, 'add_box', { size: [1, 1, 1], positon: [5, 0, 0] });
    expect(r.rejected).toBe(true);
    expect(r.affected).toEqual([]);
    expect(r.document).toBe(doc);
    expect(r.summary).toContain("add_box rejected: unknown param 'positon' — did you mean 'position'?");
    expect(r.error).toMatchObject({ code: 'CMD_UNKNOWN_PARAM', paths: ['positon'] });
  });

  it('lists the known keys when nothing is close, and passes when every key is declared', () => {
    const r = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1], zzzzzzzzzz: 1 });
    expect(r.summary).toContain("unknown param 'zzzzzzzzzz' (known: size");
    expect(execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).affected).toHaveLength(1);
  });

  it('invalid-params remediation names the failing paths and the command', () => {
    const r = execute(createEmptyDocument(), 'add_box', { size: 'big' });
    expect(r.error?.code).toBe('CMD_INVALID_PARAMS');
    expect(r.error?.remediation).toBe('Fix the params at `size`; the schema of the command: `llull describe add_box`.');
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

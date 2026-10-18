import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute, listCommands } from '@core/commands/registry';
import {
  defineCommand,
  formatIssues,
  looseVec2,
  looseVec3,
  tolerant,
  toParamsSchema,
  untypedArray,
  vec2,
  vec3,
  z,
} from '@core/commands/schema';
import { expectNoOp } from '../../helpers/expectNoOp';
import type { ParamItemSpec, ParamSpec } from '@core/commands/types';

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
        nested: z.object({ inner: z.number().describe('Inner'), opt: z.string().optional().describe('Opt') }).describe('Nested'),
        empty: z.object({}).describe('Empty'),
        items: z.array(z.object({ id: z.string().describe('Id') }).describe('Item')).describe('Items'),
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
    expect(schema.properties['count']).toEqual({ type: 'integer', description: 'How many' });
    expect(schema.properties['flag']).toEqual({ type: 'boolean', description: 'Flag' });
    expect(schema.properties['mode']).toEqual({ type: 'string', description: 'Mode', enum: ['a', 'b'] });
    expect(schema.properties['kind']?.enum).toEqual(['box']);
    expect(schema.properties['side']?.enum).toEqual(['left', 'right']);
    expect(schema.properties['level']).toMatchObject({ type: 'number', enum: [1, 2] });
    expect(schema.properties['either']).toEqual({ anyOf: [{ type: 'number' }, { type: 'string' }], description: 'Either' });
    expect(schema.properties['position']).toEqual({ type: 'array', description: 'Position', items: { type: 'number' } });
    expect(schema.properties['points']?.items).toEqual({ type: 'array', items: { type: 'number' } });
    expect(schema.properties['bag']).toEqual({ type: 'object', description: 'Bag' });
    expect(schema.properties['nested']).toEqual({
      type: 'object',
      description: 'Nested',
      properties: { inner: { type: 'number', description: 'Inner' }, opt: { type: 'string', description: 'Opt' } },
      required: ['inner'],
    });
    expect(schema.properties['empty']).toEqual({ type: 'object', description: 'Empty', properties: {} });
    expect(schema.properties['items']?.items).toEqual({
      type: 'object',
      description: 'Item',
      properties: { id: { type: 'string', description: 'Id' } },
      required: ['id'],
    });
  });
  it('advertises int-checked numbers as integer, plain and float numbers as number', () => {
    const schema = toParamsSchema(
      z.object({
        steps: z.int().describe('Steps'),
        bounded: z.number().int().min(1).max(64).describe('Bounded'),
        indices: z.array(z.number().int().nonnegative()).describe('Indices'),
        maybe: z.number().int().optional().describe('Maybe'),
        ratio: z.number().min(0).describe('Ratio'),
      }),
    );
    expect(schema.properties['steps']).toEqual({ type: 'integer', description: 'Steps' });
    expect(schema.properties['bounded']?.type).toBe('integer');
    expect(schema.properties['indices']?.items).toEqual({ type: 'integer' });
    expect(schema.properties['maybe']?.type).toBe('integer');
    expect(schema.properties['ratio']?.type).toBe('number');
  });
  it('requires a description on every top-level property', () => {
    expect(() => toParamsSchema(z.object({ bare: z.number() }))).toThrow(/bare/);
  });
});

describe('schema helpers', () => {
  it('untypedArray emits no items; tolerant never rejects but keeps the advertised spec', () => {
    const params = z.object({
      path: untypedArray('Path'),
      rotation: tolerant(vec3('Rotation').optional()),
      loose: looseVec2('Loose 2D'),
      loose3: looseVec3('Loose 3D'),
    });
    const schema = toParamsSchema(params);
    expect(schema.properties['path']).toEqual({ type: 'array', description: 'Path' });
    expect(schema.properties['rotation']).toEqual({ type: 'array', description: 'Rotation', items: { type: 'number' } });
    expect(schema.required).toEqual(['path', 'loose', 'loose3']);
    expect(params.safeParse({ path: [1, 'x'], rotation: 'bad', loose: [1, 2, 3], loose3: [1] }).success).toBe(true);
  });
});

describe('formatIssues', () => {
  it('names the path, message and offending input', () => {
    const result = z.object({ size: vec3('Size') }).safeParse({ size: [1, 'x', 2] }, { reportInput: true });
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
    expectNoOp(result, doc);
    expect(result.summary).toMatch(/set_units rejected: invalid params — units: .*"km"/);
  });
});

const ID_KEY = /^id$|Id$/;
const IDS_KEY = /Ids$|^ids$/;

function seeded(): { doc: CadDocument; entityId: string } {
  let doc = createEmptyDocument();
  const box = execute(doc, 'add_box', { size: [10, 10, 10] });
  doc = box.document;
  doc = execute(doc, 'draw_rectangle', { corner: [0, 0], width: 10, height: 5 }).document;
  return { doc, entityId: box.affected[0] ?? 'missing' };
}

function sample(spec: ParamSpec | ParamItemSpec, key: string, entityId: string): unknown {
  if (spec.enum && spec.enum.length > 0) return spec.enum[0];
  switch (spec.type) {
    case 'number':
      return 1;
    case 'boolean':
      return false;
    case 'string':
      return ID_KEY.test(key) ? entityId : 'sample';
    case 'array':
      if (IDS_KEY.test(key)) return [entityId];
      return spec.items ? [sample(spec.items, key, entityId)] : [];
    case 'object': {
      const object: Record<string, unknown> = {};
      for (const name of spec.required ?? []) {
        const child = spec.properties?.[name];
        if (child) object[name] = sample(child, name, entityId);
      }
      return object;
    }
  }
}

describe('schema conformance: schema-shaped params never make a command throw', () => {
  let warn: MockInstance<typeof console.warn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());
  for (const def of listCommands()) {
    it(def.name, () => {
      const { doc, entityId } = seeded();
      const params: Record<string, unknown> = {};
      for (const name of def.paramsSchema.required) {
        const spec = def.paramsSchema.properties[name];
        if (spec) params[name] = sample(spec, name, entityId);
      }
      const result = execute(doc, def.name, params);
      const threw = warn.mock.calls.some((call) => String(call[0]).startsWith('[llull] command'));
      expect(threw, `${def.name} threw on ${JSON.stringify(params)}: ${result.summary}`).toBe(false);
    });
  }
});

describe('schemas never rewrite params (run receives the raw, validated params)', () => {
  function rewritingNodes(schema: unknown, path: string, out: string[], depth = 0): void {
    if (depth > 12 || schema === null || typeof schema !== 'object') return;
    const def = (schema as { def?: Record<string, unknown> }).def;
    if (!def) return;
    if (def['type'] === 'default' || def['type'] === 'transform' || def['type'] === 'pipe') {
      out.push(`${path}: ${String(def['type'])}`);
    }
    for (const key of ['innerType', 'element', 'in', 'out']) {
      rewritingNodes(def[key], path, out, depth + 1);
    }
    for (const key of ['shape']) {
      const shape = def[key];
      if (shape && typeof shape === 'object') {
        for (const [k, v] of Object.entries(shape)) rewritingNodes(v, `${path}.${k}`, out, depth + 1);
      }
    }
    for (const key of ['items', 'options']) {
      const list = def[key];
      if (Array.isArray(list)) list.forEach((v, i) => rewritingNodes(v, `${path}[${i}]`, out, depth + 1));
    }
  }
  it('no command schema uses .default(), .transform() or .pipe()', () => {
    const offenders: string[] = [];
    for (const def of listCommands()) {
      if (def.paramsValidator) rewritingNodes(def.paramsValidator, def.name, offenders);
    }
    expect(offenders).toEqual([]);
  });
});

/** M4b review fixes: work budget, string / operator limits, units inside objects, text calls, expand_design isolation, schema coverage. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { setGeometryKernel } from '@core/geometry/kernel';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { describeDesignSyntax } from '@design/syntax';
import { buildValueExpr } from '@design/valueExpr';
import { evaluateValue } from '@design/valueEval';
import { coerceValue } from '@design/valueSchema';
import { DesignError } from '@design/errors';
import { RefValue } from '@design/valueEval';

beforeAll(async () => {
  setGeometryKernel(await createManifoldKernel());
});
afterAll(() => setGeometryKernel(null));

function evaluate(text: string, aliases: Record<string, readonly string[]> = {}): unknown {
  const expr = buildValueExpr(text, { units: 'mm', paramKey: null, line: 1 });
  const host = {
    line: 1,
    vars: {},
    parameters: {},
    functions: new Map(),
    alias: (name: string) => (aliases[name] === undefined ? undefined : { ids: aliases[name], group: aliases[name].length !== 1, name }),
  };
  return evaluateValue(expr, host as never);
}
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
    return 'ok';
  } catch (error) {
    return error instanceof DesignError ? error.code : 'defect';
  }
};

describe('work budget', () => {
  it('charges list builders, not only evaluation nodes', () => {
    expect(codeOf(() => evaluate('len([for i in 0..<3000: 0..<100000])'))).toBe('DESIGN_EVAL_LIMIT');
    expect(codeOf(() => evaluate('[for i in 0..<100000: zip(0..<100000, 0..<100000)][0][0]'))).toMatch(/DESIGN_(EVAL|LIST)_LIMIT/);
    expect(codeOf(() => evaluate('let a = 0..<100000 in len([for i in 0..<20000: sum(a)])'))).toBe('DESIGN_EVAL_LIMIT');
    expect(codeOf(() => evaluate('let a = 0..<100000 in len([for i in 0..<100: concat(a, a)])'))).toMatch(/DESIGN_(EVAL|LIST)_LIMIT/);
    expect(codeOf(() => evaluate('let a = linspace(0, 1, 100000) in len([for i in 0..<100: linspace(0, 1, 100000)])'))).toBe(
      'DESIGN_EVAL_LIMIT',
    );
    expect(evaluate('sum(0..<1000)')).toBe(499500);
    expect(codeOf(() => evaluate('let a = 0..<100000 in len([for i in 0..<100: a[0..<50000]])'))).toBe('DESIGN_EVAL_LIMIT');
  });

  it('refuses a shared list repeated into the command params', () => {
    const expr = buildValueExpr('let a = 0..<100000 in [for i in 0..<1000: a]', { units: 'mm', paramKey: null, line: 1 });
    const value = evaluateValue(expr, { line: 1, vars: {}, parameters: {}, functions: new Map(), alias: () => undefined });
    expect(codeOf(() => coerceValue(value, { type: 'array' }, 'p', 1))).toBe('DESIGN_EVAL_LIMIT');
    expect(codeOf(() => coerceValue(value, {}, 'p', 1))).toBe('DESIGN_EVAL_LIMIT');
  });

  it('bounds strings, flat operator chains and flat index chains', () => {
    const doubling = Array.from({ length: 30 }, (_, k) => `let a${k + 1} = a${k} + a${k} in `).join('');
    expect(codeOf(() => evaluate(`let a0 = "xxxxxxxxxx" in ${doubling}len(a30)`))).toBe('DESIGN_EVAL_LIMIT');
    expect(codeOf(() => evaluate(`len(concat("${'x'.repeat(60000)}", "${'y'.repeat(60000)}"))`))).toBe('DESIGN_EVAL_LIMIT');
    expect(codeOf(() => evaluate(`1${'+1'.repeat(50000)}`))).toBe('DESIGN_SYNTAX');
    expect(codeOf(() => evaluate(`[[0]]${'[0]'.repeat(20000)}`))).toBe('DESIGN_SYNTAX');
    expect(evaluate(`1${'+1'.repeat(200)}`)).toBe(201);
  });

  it('refuses reserved and duplicate object keys', () => {
    expect(codeOf(() => evaluate('{__proto__: 1}'))).toBe('DESIGN_SYNTAX');
    expect(codeOf(() => evaluate('{constructor: 1}'))).toBe('DESIGN_SYNTAX');
    expect(codeOf(() => evaluate('{a: 1, a: 2}'))).toBe('DESIGN_SYNTAX');
    expect(evaluate('{a: 1}.a')).toBe(1);
  });
});

describe('guide and slots', () => {
  it('the documented object example applies', () => {
    const guide = execute(createEmptyDocument(), 'describe_design_syntax', {}).summary;
    const line = guide.split('\n').find((l) => l.includes('or write the object'));
    expect(line).toBeDefined();
    const object = /write the object (\{.*\})/.exec(line ?? '')?.[1];
    const r = execute(createEmptyDocument(), 'apply_design', {
      source: `add_box b size=[40, 40, 20]\nadd_hole h target=b face=b.top point=[0, 0] hole=${(object ?? '').replace(/ /g, '')} extent.kind=through_all`,
    });
    expect(r.error?.code).not.toBe('DESIGN_UNKNOWN_PARAMETER');
    expect(describeDesignSyntax.name).toBe('describe_design_syntax');
  });

  it('units inside objects use the full field path', () => {
    const r = execute(createEmptyDocument(), 'expand_design', {
      source:
        'add_box b size=[40, 40, 20]\nadd_hole h target=b face=b.top pointsFrame=world_xy points=[[0, 0]] hole={kind: "countersink", diameter: 6mm, cskDiameter: 12mm, cskAngle: 90deg} extent.kind=through_all',
    });
    expect(r.error).toBeUndefined();
    const params = (r.data as { lines: { command: string; params: { hole: { cskAngle: number; diameter: number } } }[] }).lines[1]?.params;
    expect(params?.hole.cskAngle).toBe(90);
    expect(params?.hole.diameter).toBe(6);
  });

  it('a call-shaped word in a string slot is text', () => {
    const r = execute(createEmptyDocument(), 'expand_design', { source: 'add_layer _ name=Bracket(v2)' });
    expect(r.error).toBeUndefined();
    const text = JSON.stringify(r.data);
    expect(text).toContain('Bracket(v2)');
  });
});

describe('expand_design inside another step', () => {
  it('does not shift the ids of later steps', () => {
    const plain = execute(createEmptyDocument(), 'build_project', {
      actions: [
        { command: 'add_box', params: { size: [1, 1, 1] } },
        { command: 'add_box', params: { size: [2, 2, 2] } },
      ],
    });
    const withExpand = execute(createEmptyDocument(), 'build_project', {
      actions: [
        { command: 'add_box', params: { size: [1, 1, 1] } },
        { command: 'expand_design', params: { source: 'add_box q size=[1, 1, 1]' } },
        { command: 'add_box', params: { size: [2, 2, 2] } },
      ],
    });
    expect(plain.error).toBeUndefined();
    expect(Object.keys(withExpand.document.entities)).toEqual(Object.keys(plain.document.entities));
  });
});

describe('coerceValue branches', () => {
  const one = new RefValue(['a-1'], false, 'a');
  const group = new RefValue(['a-1', 'a-2'], true, 'g');
  it('aliases on untyped, array and string slots', () => {
    expect(coerceValue(one, {}, 'p', 1)).toBe('a-1');
    expect(coerceValue(group, {}, 'p', 1)).toEqual(['a-1', 'a-2']);
    expect(coerceValue(group, { type: 'array', items: { type: 'string' } }, 'p', 1)).toEqual(['a-1', 'a-2']);
    expect(codeOf(() => coerceValue(group, { type: 'string' }, 'p', 1))).toBe('DESIGN_ALIAS_ARITY');
    expect(codeOf(() => coerceValue(one, { type: 'number' }, 'p', 1))).toBe('DESIGN_VALUE_SCHEMA');
  });
  it('untyped nests lists, objects and aliases', () => {
    expect(coerceValue([1, { k: [one, group] }, null], {}, 'p', 1)).toEqual([1, { k: ['a-1', ['a-1', 'a-2']] }, null]);
  });
  it('anyOf reports the first failure when no branch fits', () => {
    expect(codeOf(() => coerceValue('x', { anyOf: [{ type: 'number' }, { type: 'boolean' }] }, 'p', 1))).toBe('DESIGN_VALUE_SCHEMA');
    expect(coerceValue(3, { anyOf: [{ type: 'string' }, { type: 'number' }] }, 'p', 1)).toBe(3);
    expect(codeOf(() => coerceValue(1.5, { type: 'integer' }, 'p', 1))).toBe('DESIGN_VALUE_SCHEMA');
    expect(codeOf(() => coerceValue('z', { enum: ['a', 'b'] }, 'p', 1))).toBe('DESIGN_VALUE_SCHEMA');
    expect(codeOf(() => coerceValue({ q: 1 }, { type: 'object', properties: { k: { type: 'number', description: 'k' } } }, 'p', 1))).toBe(
      'DESIGN_VALUE_SCHEMA',
    );
    expect(
      codeOf(() => coerceValue({}, { type: 'object', properties: { k: { type: 'number', description: 'k' } }, required: ['k'] }, 'p', 1)),
    ).toBe('DESIGN_VALUE_SCHEMA');
    expect(codeOf(() => coerceValue(1, { type: 'array' }, 'p', 1))).toBe('DESIGN_VALUE_SCHEMA');
    expect(codeOf(() => coerceValue(1, { type: 'object' }, 'p', 1))).toBe('DESIGN_VALUE_SCHEMA');
  });
});

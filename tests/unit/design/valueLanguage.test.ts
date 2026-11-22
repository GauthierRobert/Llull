/**
 * M4b of the assembly-scale pack: the `.lld` value language (ranges, comprehensions, `if`, `let`, built-ins, user functions, object / list
 * values bound to the param schema) and `expand_design`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { setGeometryKernel } from '@core/geometry/kernel';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { createEmptyDocument } from '@core/model/types';
import { MAX_CALL_DEPTH, MAX_EVAL_STEPS, MAX_LIST_ITEMS } from '@design/valueEval';

const apply = (source: string): CommandResult => execute(createEmptyDocument(), 'apply_design', { source });
const code = (source: string): string | undefined => apply(source).error?.code;

/** The x size of a box whose size is `[x, 1, 1]`, or the error code. */
function size(expression: string, prefix = ''): number | string {
  const r = apply(`${prefix}add_box b size=[${expression}, 1, 1]\ncheck bbox of=b expect == [0, 0, 0]`);
  if (r.error !== undefined) return r.error.code;
  const actual = (r.data as { checks: { actual: number[] }[] }).checks[0]?.actual;
  return actual?.[0] ?? Number.NaN;
}

beforeAll(async () => {
  setGeometryKernel(await createManifoldKernel());
});
afterAll(() => setGeometryKernel(null));

describe('expressions', () => {
  it('arithmetic, comparison, boolean logic, if and let', () => {
    expect(size('(if 2 > 1 && !(3 == 4) then 5 else 6)')).toBe(5);
    expect(size('(if 1 >= 2 || 3 != 3 then 5 else 6)')).toBe(6);
    expect(size('(let a = 2 in let b = a * 3 in a + b)')).toBe(8);
    expect(size('(if 1 < 2 then -2 + 4 * 2 - 1 else 0)')).toBe(5);
    expect(size('(let s = "a" + "b" in len(s))')).toBe(2);
  });

  it('units convert at parse time, powers use pow, math built-ins work', () => {
    expect(size('(let l = 2m in l)')).toBe(2000);
    expect(size('(let k = pow(2, 10) + sqrt(16) + max(1, 3) + abs(-1) in k)')).toBe(1024 + 4 + 3 + 1);
  });

  it('ranges, comprehensions with a filter, slices, negative indexes', () => {
    expect(size('sum([for k in 0..<5: k])')).toBe(10);
    expect(size('sum([for k in 0..4: k])')).toBe(10);
    expect(size('sum([for k in 0..<10 if mod(k, 2) == 0: k])')).toBe(20);
    expect(size('([10, 20, 30])[-1]')).toBe(30);
    expect(size('sum(([1, 2, 3, 4])[1..<3])')).toBe(5);
    expect(size('sum(([1, 2, 3, 4])[1..2])')).toBe(5);
  });

  it('len, sum, concat, zip, linspace, object fields', () => {
    expect(size('len(concat([1, 2], [3]))')).toBe(3);
    expect(size('len(concat("ab", "cd"))')).toBe(4);
    expect(size('sum([for p in zip([1, 2, 3], [4, 5, 6]): p[0] * p[1]])')).toBe(32);
    expect(size('sum(linspace(0, 10, 5))')).toBe(25);
    expect(size('len(linspace(3, 3, 1))')).toBe(1);
    expect(size('({a: 1, "b": 2}).b + ({a: 1}).a')).toBe(3);
    expect(size('len(concat([1], [for k in 0..<0: k]))')).toBe(1);
  });

  it('loop variables and parameters are values; functions see parameters but not loop variables', () => {
    expect(size('sum([for k in 0..<n: k])', 'param n = 4\nfn f(x) = x + n\n')).toBe(6);
    expect(size('f(2)', 'param n = 4\nfn f(x) = x + n\n')).toBe(6);
    expect(size('f(1)', 'fn f(x) = x + i\nfor i in 0..0 {\n  add_box q size=[1,1,1]\n}\n')).toBe('DESIGN_UNKNOWN_PARAMETER');
  });
});

describe('functions', () => {
  it('calls, defaults, nesting, a call in a loop bound', () => {
    const fns = 'fn sq(x) = x * x\nfn tip(x, k = 2) = sq(x) + k\n';
    expect(size('tip(3)', fns)).toBe(11);
    expect(size('tip(3, 10)', fns)).toBe(19);
    const r = apply(`${fns}for i in 0..sq(2) {\n  add_box b{i} size=[1,1,1]\n}`);
    expect(r.error).toBeUndefined();
    expect(r.affected).toHaveLength(5);
  });

  it('refuses recursion, wrong arguments, unknown functions, duplicates and built-in names', () => {
    expect(code('fn a(x) = b(x)\nfn b(x) = a(x)\nadd_box b size=[1,1,1]')).toBe('DESIGN_FN_RECURSION');
    expect(code('fn a(x) = a(x)\nadd_box b size=[1,1,1]')).toBe('DESIGN_FN_RECURSION');
    expect(size('f()', 'fn f(x) = x\n')).toBe('DESIGN_FN_ARGS');
    expect(size('f(1, 2)', 'fn f(x) = x\n')).toBe('DESIGN_FN_ARGS');
    expect(size('nope(1)')).toBe('DESIGN_FN_ARGS');
    expect(size('sqrt(1, 2)')).toBe('DESIGN_FN_ARGS');
    expect(code('fn f(x) = x\nfn f(y) = y\nadd_box b size=[1,1,1]')).toBe('DESIGN_SYNTAX');
    expect(code('fn len(x) = x\nadd_box b size=[1,1,1]')).toBe('DESIGN_SYNTAX');
    expect(code('for i in 0..1 {\n  fn f(x) = x\n}')).toBe('DESIGN_SYNTAX');
    expect(code('fn f(x, x) = x\nadd_box b size=[1,1,1]')).toBe('DESIGN_SYNTAX');
    expect(code('fn f x = x\nadd_box b size=[1,1,1]')).toBe('DESIGN_SYNTAX');
    expect(code('fn f(1) = x\nadd_box b size=[1,1,1]')).toBe('DESIGN_SYNTAX');
  });

  it('a function cannot read aliases', () => {
    expect(size('f(1)', 'add_box a size=[1,1,1]\nfn f(x) = len(a)\n')).toBe('DESIGN_UNKNOWN_PARAMETER');
  });
});

describe('call graph and units', () => {
  it('finds recursion through every expression form', () => {
    const wrappers = [
      '[a(x)]',
      '{k: a(x)}',
      '[for k in 0..<1: a(x)]',
      '[for k in [a(x)]: k]',
      '[for k in 0..<1 if a(x) > 0: k]',
      '(if a(x) then 1 else 2)',
      '(if true then a(x) else 2)',
      '(let y = a(x) in y)',
      '(let y = 1 in a(x))',
      '(-a(x))',
      '(1 + a(x))',
      '(0..a(x))',
      '([1])[a(x)]',
      '(a(x))[0]',
      '({k: 1}).k + a(x)',
      '(a(x)).k',
    ];
    for (const body of wrappers) expect(code(`fn a(x) = ${body}\nadd_box b size=[1,1,1]`), body).toBe('DESIGN_FN_RECURSION');
    expect(code('fn a(x, y = a(1)) = x\nadd_box b size=[1,1,1]')).toBe('DESIGN_FN_RECURSION');
  });

  it('a long acyclic chain is fine; angle units convert for angle params and are refused elsewhere', () => {
    expect(size('f1(1)', 'fn f1(x) = f2(x)\nfn f2(x) = f3(x)\nfn f3(x) = x\n')).toBe(1);
    expect(apply('revolve_profile r profile=[[10,0],[12,0],[12,5],[10,5]] axis="x" angle=(let a = 90deg in a)').error).toBeUndefined();
    expect(apply('revolve_profile r profile=[[10,0],[12,0],[12,5],[10,5]] axis="x" angle=(let a = 1.5rad in a)').error).toBeUndefined();
    expect(size('(let a = 90deg in a)')).toBe('DESIGN_UNIT_NOT_SUPPORTED');
    expect(size('(let a = 2in + 1cm + 1ft in a)')).toBe(50.8 + 10 + 304.8);
  });
});

describe('bounded evaluation', () => {
  it('names its limits', () => {
    expect([MAX_LIST_ITEMS, MAX_EVAL_STEPS, MAX_CALL_DEPTH]).toEqual([100_000, 2_000_000, 64]);
  });

  it('a list over the limit is DESIGN_LIST_LIMIT, a huge workload DESIGN_EVAL_LIMIT, deep calls DESIGN_EVAL_LIMIT', () => {
    expect(size(`len(0..<${MAX_LIST_ITEMS + 1})`)).toBe('DESIGN_LIST_LIMIT');
    expect(size(`len([for k in 0..<${MAX_LIST_ITEMS}: k])`)).toBe(MAX_LIST_ITEMS);
    expect(size('len(linspace(0, 1, 100001))')).toBe('DESIGN_LIST_LIMIT');
    expect(size('len([for a in 0..<2000: [for b in 0..<2000: a]])')).toBe('DESIGN_EVAL_LIMIT');
    const chain = Array.from({ length: MAX_CALL_DEPTH + 2 }, (_, k) => `fn f${k}(x) = f${k + 1}(x)`).join('\n');
    expect(size('f0(1)', `${chain}\nfn f${MAX_CALL_DEPTH + 2}(x) = x\n`)).toBe('DESIGN_EVAL_LIMIT');
  });

  it('deep nesting is refused as a syntax error', () => {
    expect(size(`${'{a:'.repeat(120)}1${'}'.repeat(120)}`)).toBe('DESIGN_SYNTAX');
  });
});

describe('errors', () => {
  it('types: DESIGN_EXPR_TYPE', () => {
    for (const bad of [
      '(if 1 then 2 else 3)',
      '(let s = "a" in s + 1)',
      '(!3)',
      '1 / 0',
      'len(3)',
      'sum(["a"])',
      'zip([1], [1, 2])',
      'linspace(0, 1, 0)',
      '({a: 1}).b',
    ])
      expect(size(bad), bad).toBe('DESIGN_EXPR_TYPE');
    for (const bad of ['(1 && 2)', '(true && 2)', '(1 == [2])', 'sqrt(-1)', '(let a = 1 in a.b)', '(1 < "a")'])
      expect(size(bad), bad).toBe('DESIGN_EXPR_TYPE');
  });

  it('indexes and names', () => {
    expect(size('([1, 2])[2]')).toBe('DESIGN_INDEX_RANGE');
    expect(size('([1, 2])[1.5]')).toBe('DESIGN_INDEX_RANGE');
    expect(size('(1)[0]')).toBe('DESIGN_EXPR_TYPE');
    expect(size('(let a = 1 in b)')).toBe('DESIGN_UNKNOWN_PARAMETER');
  });

  it('syntax', () => {
    for (const bad of [
      '(1 +)',
      '{a: }',
      '{1: 2}',
      '(let in 3)',
      '(if 1 then 2)',
      '[for k 0..<2: k]',
      '{a: 1 b: 2}',
      '(1 $ 2)',
      '(let a 1 in a)',
    ])
      expect(code(`add_box b size=[${bad}, 1, 1]`), bad).toMatch(/DESIGN_SYNTAX|DESIGN_BAD_VALUE/);
  });
});

describe('schema binding of object and list values (VC-ASC-15)', () => {
  const airfoils =
    'airfoil_from_naca af0 designation="0012"\nairfoil_from_naca af1 designation="0012"\nairfoil_from_naca af2 designation="0012"\n';
  const wing = (sections: string): CommandResult => apply(`${airfoils}create_wing w sections=${sections}`);

  it('builds a wing from sections computed per index, aliases resolved inside the objects', () => {
    const r = wing('(let ids = [af0, af1, af2] in [for k in 0..<3: {airfoilId: ids[k], span: k * 290, chord: 170 + 20 * k}])');
    expect(r.error).toBeUndefined();
    expect(Object.values(r.document.aero?.wings ?? {})).toHaveLength(1);
  });

  it('a wrong field or type names its path', () => {
    const extra = wing('[for k in 0..<2: {airfoilId: af0, span: k * 100, chord: 100, spam: 1}]');
    expect(extra.error?.code).toBe('DESIGN_VALUE_SCHEMA');
    expect(extra.summary).toContain('sections[0].spam');
    const type = wing('[{airfoilId: af0, span: 0, chord: 100}, {airfoilId: af0, span: "far", chord: 100}]');
    expect(type.error?.code).toBe('DESIGN_VALUE_SCHEMA');
    expect(type.summary).toContain('sections[1].span');
    expect(wing('[{airfoilId: af0, span: 0}, {span: 5}]').summary).toContain('airfoilId');
    expect(wing('[for k in 0..<2: {airfoilId: 3, span: k}]').error?.code).toBe('DESIGN_VALUE_SCHEMA');
    expect(wing('3').error?.code).toBe('DESIGN_BAD_VALUE');
  });

  it('enum, boolean, integer and array slots', () => {
    const base = `${airfoils}create_wing w sections=[{airfoilId: af0, span: 0, chord: 100}, {airfoilId: af0, span: 50, chord: 100}]`;
    expect(apply(`${base} loft=("smooth")`).error).toBeUndefined();
    expect(apply(`${base} loft=("bogus")`).error?.code).toBe('DESIGN_VALUE_SCHEMA');
    expect(apply(`${base} mirror=(1 < 2)`).error).toBeUndefined();
    expect(apply(`${base} mirror=(if true then 1 else 2)`).error?.code).toBe('DESIGN_VALUE_SCHEMA');
    expect(apply(`${base} origin=[for k in 0..<3: k * 2]`).error).toBeUndefined();
    expect(apply(`${base} origin=[for k in 0..<3: "a"]`).error?.code).toBe('DESIGN_VALUE_SCHEMA');
  });

  it('a group alias in a one-id slot of an object is DESIGN_ALIAS_ARITY; an indexed one works', () => {
    const boxes = 'add_box a size=[1,1,1]\nadd_box b size=[1,1,1]\nduplicate_entities g ids=[a, b]\n';
    expect(
      apply(`${boxes}airfoil_from_naca af0 designation="0012"\ncreate_wing w sections=[{airfoilId: g, span: 0}, {airfoilId: g, span: 1}]`)
        .error?.code,
    ).toBe('DESIGN_ALIAS_ARITY');
    expect(apply(`${boxes}move_entities m ids=(g[0..<2]) delta=[0, 0, 1]`).error).toBeUndefined();
    expect(apply(`${boxes}move_entities m ids=([for e in g: e]) delta=[0, 0, 1]`).error).toBeUndefined();
    expect(apply(`${boxes}move_entities m ids=(g.entities) delta=[0, 0, 1]`).error).toBeUndefined();
    expect(apply(`${boxes}move_entities m ids=(g[0].entity) delta=[0, 0, 1]`).error?.code).toBe('DESIGN_EXPR_TYPE');
    expect(apply(`${boxes}move_entities m ids=([len(g)]) delta=[0, 0, 1]`).error?.code).toBe('DESIGN_VALUE_SCHEMA');
    expect(apply(`${boxes}move_entities m ids=(g[5..<9]) delta=[0, 0, 1]`).error?.code).toBe('DESIGN_INDEX_RANGE');
  });

  it('alias values from objects work with .entity', () => {
    const r = apply(
      'airfoil_from_naca af designation="0012"\nmove_entities m ids=([af.entity]) delta=[0, 0, 1]\nmove_entities m2 ids=(af.entity) delta=[0, 0, 1]',
    );
    expect(r.error).toBeUndefined();
  });
});

describe('expand_design', () => {
  const source =
    'design d units=mm\nparam n = 3\nfn w(i) = 10 * i + 1\nfor i in 0..n-1 {\n  add_box b{i} size=[w(i), 2, 2] position=[i * 20, 0, 0]\n}\n';

  it('lists every command with resolved params and does not touch the document', () => {
    const doc = createEmptyDocument();
    const before = JSON.stringify(doc);
    const r = execute(doc, 'expand_design', { source });
    expect(r.error).toBeUndefined();
    const lines = (r.data as { lines: { line: number; command: string; alias: string; params: { size: number[] } }[] }).lines;
    expect(lines.map((l) => l.params.size[0])).toEqual([1, 11, 21]);
    expect(lines.map((l) => l.alias)).toEqual(['b0', 'b1', 'b2']);
    expect(lines[0]?.line).toBe(5);
    expect(r.document).toBe(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('expands the document design when no source is given; refuses without one', () => {
    const applied = apply(source);
    expect((execute(applied.document, 'expand_design', {}).data as { commands: number }).commands).toBe(3);
    expect(execute(createEmptyDocument(), 'expand_design', {}).error?.code).toBe('DESIGN_NO_DESIGN');
  });

  it('a comprehension over a function gives the literal profile point for point (VC-ASC-17)', () => {
    const profile = 'fn tip(x) = 100 + x * 2 / 3 - pow(x, 2) / 1000\ndraw_polyline p points=[for k in 0..<6: [k * 10, tip(k * 10)]]\n';
    const literal = Array.from({ length: 6 }, (_, k) => [k * 10, 100 + (k * 10 * 2) / 3 - Math.pow(k * 10, 2) / 1000]);
    const r = execute(createEmptyDocument(), 'expand_design', { source: profile });
    expect(r.error).toBeUndefined();
    const lines = (r.data as { lines: { params: { points: number[][] } }[] }).lines;
    expect(lines[0]?.params.points).toEqual(literal);
  });

  it('reports a design error with its line and a design that calls it is refused', () => {
    const bad = execute(createEmptyDocument(), 'expand_design', { source: 'add_box b size=[(1 +), 1, 1]' });
    expect(bad.error).toBeDefined();
    expect(code('expand_design source="add_box b size=[1,1,1]"')).toBe('DESIGN_UNKNOWN_COMMAND');
  });
});

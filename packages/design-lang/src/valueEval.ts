/**
 * The shared pure evaluator of `.lld` values (valueExpr.ts trees): numbers, booleans, strings, lists, objects and alias references,
 * with ranges, comprehensions, `if`, `let`, built-ins and user functions.
 * @invariant no clock, no randomness, no environment; powers use `pow` (@lib/pow); evaluation is bounded (MAX_LIST_ITEMS, MAX_EVAL_STEPS,
 *   MAX_CALL_DEPTH) and a function cannot reach aliases or loop variables, only its arguments and the document parameters
 * @failure type errors -> DESIGN_EXPR_TYPE; bad index -> DESIGN_INDEX_RANGE; lists over the limit -> DESIGN_LIST_LIMIT; too many steps or
 *   calls nested too deep -> DESIGN_EVAL_LIMIT; wrong argument count -> DESIGN_FN_ARGS; unknown name -> DESIGN_UNKNOWN_PARAMETER
 */

import { BUILTIN_CONSTANTS, BUILTIN_FUNCTIONS } from '@lib/expression';
import { pow } from '@lib/pow';
import { similarNames } from '@lib/similarNames';
import { DesignError, type DesignErrorCode } from './errors';
import { pickAt, pickSlice } from './aliasRef';
import type { Expr } from './valueExpr';

/** An alias (or a part of one) as a value: the ids it names; `name` is set only for a whole alias (for `.entity`). */
export class RefValue {
  constructor(
    readonly ids: readonly string[],
    readonly group: boolean,
    readonly name: string | null,
  ) {}
}

/** A module instance namespace (`fan` of `use "fan.lld" as fan`): `fan.blades` reads its exported alias. */
export class NamespaceValue {
  constructor(readonly path: string) {}
}

export type Value = number | boolean | string | null | readonly Value[] | { readonly [key: string]: Value } | RefValue | NamespaceValue;

export interface FnDef {
  readonly name: string;
  readonly params: readonly { readonly name: string; readonly fallback: Expr | null }[];
  readonly body: Expr;
}

export interface EvalHost {
  readonly line: number;
  /** Loop variables (not visible inside functions). */
  readonly vars: Readonly<Record<string, number>>;
  /** Document parameters. */
  readonly parameters: Readonly<Record<string, number>>;
  readonly functions: ReadonlyMap<string, FnDef>;
  /** The alias `name`, or `.entity` / `.entities` of it; undefined when unbound. */
  alias(name: string, member: 'entity' | 'entities' | null): RefValue | undefined;
  /** True when `name` is a module instance namespace (some exported alias lives under it). */
  namespace?(name: string): boolean;
}

/** A list (range, comprehension, linspace, concat) longer than this is refused. */
export const MAX_LIST_ITEMS = 100_000;
/** Expression nodes evaluated by one value. */
export const MAX_EVAL_STEPS = 2_000_000;
/** Nested user-function calls. */
export const MAX_CALL_DEPTH = 64;

const VALUE_BUILTINS: Readonly<Record<string, { min: number; max: number }>> = {
  len: { min: 1, max: 1 },
  sum: { min: 1, max: 1 },
  concat: { min: 1, max: 64 },
  zip: { min: 2, max: 8 },
  linspace: { min: 3, max: 3 },
};

/** Names a user function may not take. */
export const isBuiltinFunction = (name: string): boolean => Object.hasOwn(VALUE_BUILTINS, name) || Object.hasOwn(BUILTIN_FUNCTIONS, name);

interface Scope {
  readonly name: string;
  readonly value: Value;
  readonly parent: Scope | null;
}

const describe = (value: Value): string =>
  value === null
    ? 'null'
    : Array.isArray(value)
      ? 'list'
      : value instanceof RefValue
        ? `alias ${value.group ? 'group' : 'id'}`
        : typeof value === 'object'
          ? 'object'
          : typeof value;

class Evaluator {
  private steps = 0;
  constructor(private readonly host: EvalHost) {}

  private error(code: DesignErrorCode, detail: string, fix: string): DesignError {
    return new DesignError(code, this.host.line, detail, fix);
  }

  private type(detail: string, fix = 'See describe_design_syntax for the value grammar.'): DesignError {
    return this.error('DESIGN_EXPR_TYPE', detail, fix);
  }

  private number(value: Value, what: string): number {
    if (typeof value !== 'number') throw this.type(`${what} must be a number, got ${describe(value)}`);
    return value;
  }

  private finite(value: number, what: string): number {
    if (!Number.isFinite(value)) throw this.type(`${what} is not a finite number`, 'Check for a division by zero.');
    return value;
  }

  private list(value: Value, what: string): readonly Value[] {
    if (Array.isArray(value)) return value as readonly Value[];
    if (value instanceof RefValue) return value.ids.map((id) => new RefValue([id], false, null));
    throw this.type(`${what} must be a list, got ${describe(value)}`);
  }

  private checkSize(count: number, what: string): void {
    if (count > MAX_LIST_ITEMS)
      throw this.error('DESIGN_LIST_LIMIT', `${what} would have ${count} items`, `A list holds at most ${MAX_LIST_ITEMS} items.`);
  }

  eval(expr: Expr, scope: Scope | null, fnDepth: number): Value {
    if (++this.steps > MAX_EVAL_STEPS)
      throw this.error(
        'DESIGN_EVAL_LIMIT',
        `the value needs more than ${MAX_EVAL_STEPS} evaluation steps`,
        'Simplify it or shorten its lists.',
      );
    switch (expr.t) {
      case 'num':
      case 'str':
      case 'bool':
        return expr.v;
      case 'null':
        return null;
      case 'id':
        return this.identifier(expr.name, scope, fnDepth);
      case 'list':
        return expr.items.map((item) => this.eval(item, scope, fnDepth));
      case 'obj':
        return Object.fromEntries(expr.entries.map((e) => [e.key, this.eval(e.value, scope, fnDepth)]));
      case 'if': {
        const cond = this.eval(expr.cond, scope, fnDepth);
        if (typeof cond !== 'boolean') throw this.type(`if needs a true / false condition, got ${describe(cond)}`);
        return this.eval(cond ? expr.then : expr.otherwise, scope, fnDepth);
      }
      case 'let':
        return this.eval(expr.body, { name: expr.name, value: this.eval(expr.value, scope, fnDepth), parent: scope }, fnDepth);
      case 'un':
        return this.unary(expr.op, this.eval(expr.operand, scope, fnDepth));
      case 'bin':
        return this.binary(expr, scope, fnDepth);
      case 'range':
        return this.range(expr, scope, fnDepth);
      case 'comp':
        return this.comprehension(expr, scope, fnDepth);
      case 'index':
        return this.index(expr, scope, fnDepth);
      case 'member':
        return this.member(expr.base, expr.name, scope, fnDepth);
      case 'call':
        return this.call(expr, scope, fnDepth);
    }
  }

  private identifier(name: string, scope: Scope | null, fnDepth: number): Value {
    for (let s = scope; s !== null; s = s.parent) if (s.name === name) return s.value;
    if (fnDepth === 0 && Object.hasOwn(this.host.vars, name)) return this.host.vars[name] ?? 0;
    if (Object.hasOwn(this.host.parameters, name)) return this.host.parameters[name] ?? 0;
    if (Object.hasOwn(BUILTIN_CONSTANTS, name)) return BUILTIN_CONSTANTS[name] ?? 0;
    const ref = fnDepth === 0 ? this.host.alias(name, null) : undefined;
    if (ref !== undefined) return ref;
    if (fnDepth === 0 && this.host.namespace?.(name) === true) return new NamespaceValue(name);
    const known = [...Object.keys(this.host.parameters), ...(fnDepth === 0 ? Object.keys(this.host.vars) : [])];
    for (let s = scope; s !== null; s = s.parent) known.push(s.name);
    const near = similarNames(name, known);
    throw this.error(
      'DESIGN_UNKNOWN_PARAMETER',
      `unknown name "${name}"${fnDepth > 0 ? ' (a function sees only its arguments and the document parameters)' : ''}`,
      near.length > 0 ? `Did you mean ${near.join(', ')}?` : 'Declare it with param, bind it as an alias, or pass it as an argument.',
    );
  }

  private unary(op: '-' | '!', value: Value): Value {
    if (op === '-') return -this.number(value, 'the operand of "-"');
    if (typeof value !== 'boolean') throw this.type(`"!" needs true / false, got ${describe(value)}`);
    return !value;
  }

  private binary(expr: Extract<Expr, { t: 'bin' }>, scope: Scope | null, fnDepth: number): Value {
    const { op } = expr;
    const left = this.eval(expr.left, scope, fnDepth);
    if (op === '&&' || op === '||') {
      if (typeof left !== 'boolean') throw this.type(`"${op}" needs true / false, got ${describe(left)}`);
      if (op === '&&' ? !left : left) return left;
      const right = this.eval(expr.right, scope, fnDepth);
      if (typeof right !== 'boolean') throw this.type(`"${op}" needs true / false, got ${describe(right)}`);
      return right;
    }
    const right = this.eval(expr.right, scope, fnDepth);
    if (op === '+' && typeof left === 'string' && typeof right === 'string') return left + right;
    if (op === '==' || op === '!=') {
      if ((typeof left === 'object' && left !== null) || (typeof right === 'object' && right !== null))
        throw this.type(`"${op}" compares numbers, strings and booleans, not ${describe(left)}`);
      return (left === right) === (op === '==');
    }
    const a = this.number(left, `the left side of "${op}"`);
    const b = this.number(right, `the right side of "${op}"`);
    switch (op) {
      case '+':
        return this.finite(a + b, 'the sum');
      case '-':
        return this.finite(a - b, 'the difference');
      case '*':
        return this.finite(a * b, 'the product');
      case '/':
        return this.finite(a / b, 'the quotient');
      case '<':
        return a < b;
      case '<=':
        return a <= b;
      case '>':
        return a > b;
      default:
        return a >= b;
    }
  }

  private integer(value: Value, what: string): number {
    const n = this.number(value, what);
    if (!Number.isInteger(n)) throw this.type(`${what} must be an integer, got ${n}`, 'Use whole numbers for ranges.');
    return n;
  }

  private range(expr: Extract<Expr, { t: 'range' }>, scope: Scope | null, fnDepth: number): Value {
    const from = this.integer(this.eval(expr.from, scope, fnDepth), 'the start of a range');
    const to = this.integer(this.eval(expr.to, scope, fnDepth), 'the end of a range');
    const end = expr.inclusive ? to + 1 : to;
    this.checkSize(Math.max(0, end - from), `the range ${from}..${expr.inclusive ? '' : '<'}${to}`);
    return Array.from({ length: Math.max(0, end - from) }, (_, k) => from + k);
  }

  private comprehension(expr: Extract<Expr, { t: 'comp' }>, scope: Scope | null, fnDepth: number): Value {
    const items = this.list(this.eval(expr.source, scope, fnDepth), 'the source of a comprehension');
    const out: Value[] = [];
    for (const item of items) {
      const inner: Scope = { name: expr.variable, value: item, parent: scope };
      if (expr.filter !== null) {
        const keep = this.eval(expr.filter, inner, fnDepth);
        if (typeof keep !== 'boolean') throw this.type(`a comprehension "if" needs true / false, got ${describe(keep)}`);
        if (!keep) continue;
      }
      out.push(this.eval(expr.body, inner, fnDepth));
      this.checkSize(out.length, 'the comprehension');
    }
    return out;
  }

  private index(expr: Extract<Expr, { t: 'index' }>, scope: Scope | null, fnDepth: number): Value {
    const base = this.eval(expr.base, scope, fnDepth);
    const label = expr.base.t === 'id' ? expr.base.name : 'list';
    const { selector } = expr;
    if (base instanceof RefValue) {
      if (selector.t === 'range') {
        const [from, to] = this.bounds(selector, scope, fnDepth);
        return new RefValue(pickSlice(base.ids, label, from, to, selector.inclusive, this.host.line), true, null);
      }
      const at = this.number(this.eval(selector, scope, fnDepth), 'an index');
      return new RefValue([pickAt(base.ids, label, at, this.host.line)], false, null);
    }
    if (!Array.isArray(base)) throw this.type(`only lists and alias groups can be indexed, got ${describe(base)}`);
    const items = base as readonly Value[];
    if (selector.t === 'range') {
      const [from, to] = this.bounds(selector, scope, fnDepth);
      return pickSlice(items, label, from, to, selector.inclusive, this.host.line);
    }
    return pickAt(items, label, this.number(this.eval(selector, scope, fnDepth), 'an index'), this.host.line);
  }

  private bounds(selector: Extract<Expr, { t: 'range' }>, scope: Scope | null, fnDepth: number): [number, number] {
    return [
      this.number(this.eval(selector.from, scope, fnDepth), 'the start of a slice'),
      this.number(this.eval(selector.to, scope, fnDepth), 'the end of a slice'),
    ];
  }

  private member(baseExpr: Expr, name: string, scope: Scope | null, fnDepth: number): Value {
    const base = this.eval(baseExpr, scope, fnDepth);
    if (base instanceof NamespaceValue) {
      const path = `${base.path}.${name}`;
      const ref = this.host.alias(path, null);
      if (ref !== undefined) return ref;
      if (this.host.namespace?.(path) === true) return new NamespaceValue(path);
      throw this.type(`module ${base.path} exports no "${name}"`, 'Only names in the module `export` line are visible outside it.');
    }
    if (base instanceof RefValue) {
      if ((name === 'entity' || name === 'entities') && base.name !== null) {
        const ref = this.host.alias(base.name, name);
        if (ref !== undefined) return ref;
      }
      throw this.type(`".${name}" needs a whole alias with that member (.entity, .entities)`, 'Write alias.entity or alias.entities.');
    }
    if (base !== null && typeof base === 'object' && !Array.isArray(base)) {
      const object = base as { readonly [key: string]: Value };
      const found = Object.hasOwn(object, name) ? object[name] : undefined;
      if (found !== undefined) return found;
      throw this.type(`the object has no field "${name}"`, `Fields: ${Object.keys(object).join(', ') || '(none)'}.`);
    }
    throw this.type(`".${name}" needs an object or an alias, got ${describe(base)}`);
  }

  private call(expr: Extract<Expr, { t: 'call' }>, scope: Scope | null, fnDepth: number): Value {
    const user = this.host.functions.get(expr.name);
    const args = expr.args.map((arg) => this.eval(arg, scope, fnDepth));
    if (user !== undefined) return this.callUser(user, args, fnDepth);
    const spec = Object.hasOwn(VALUE_BUILTINS, expr.name) ? VALUE_BUILTINS[expr.name] : undefined;
    const math = Object.hasOwn(BUILTIN_FUNCTIONS, expr.name) ? BUILTIN_FUNCTIONS[expr.name] : undefined;
    const range = spec ?? math;
    if (range === undefined) {
      const near = similarNames(expr.name, [
        ...this.host.functions.keys(),
        ...Object.keys(VALUE_BUILTINS),
        ...Object.keys(BUILTIN_FUNCTIONS),
      ]);
      throw this.error(
        'DESIGN_FN_ARGS',
        `unknown function "${expr.name}"`,
        near.length > 0 ? `Did you mean ${near.join(', ')}?` : 'Define it: fn name(a, b = 2) = expr',
      );
    }
    if (args.length < range.min || args.length > range.max)
      throw this.error(
        'DESIGN_FN_ARGS',
        `${expr.name}() takes ${range.min}-${range.max} argument(s), got ${args.length}`,
        `See describe_design_syntax.`,
      );
    if (spec !== undefined) return this.builtin(expr.name, args);
    const numbers = args.map((a) => this.number(a, `an argument of ${expr.name}()`));
    const result = expr.name === 'pow' ? pow(numbers[0] ?? 0, numbers[1] ?? 0) : (math?.fn(...numbers) ?? 0);
    if (Number.isNaN(result)) throw this.type(`${expr.name}() is undefined for these arguments`);
    return this.finite(result, `${expr.name}()`);
  }

  private callUser(fn: FnDef, args: readonly Value[], fnDepth: number): Value {
    if (fnDepth >= MAX_CALL_DEPTH)
      throw this.error('DESIGN_EVAL_LIMIT', `functions nested deeper than ${MAX_CALL_DEPTH} calls`, 'Flatten the function calls.');
    const required = fn.params.filter((p) => p.fallback === null).length;
    if (args.length < required || args.length > fn.params.length)
      throw this.error(
        'DESIGN_FN_ARGS',
        `${fn.name}() takes ${required === fn.params.length ? required : `${required}-${fn.params.length}`} argument(s), got ${args.length}`,
        `fn ${fn.name}(${fn.params.map((p) => p.name + (p.fallback === null ? '' : ' = …')).join(', ')})`,
      );
    let scope: Scope | null = null;
    fn.params.forEach((param, k) => {
      const value = k < args.length ? (args[k] as Value) : this.eval(param.fallback as Expr, scope, fnDepth + 1);
      scope = { name: param.name, value, parent: scope };
    });
    return this.eval(fn.body, scope, fnDepth + 1);
  }

  private builtin(name: string, args: readonly Value[]): Value {
    switch (name) {
      case 'len':
        return typeof args[0] === 'string' ? args[0].length : this.list(args[0] as Value, 'the argument of len()').length;
      case 'sum':
        return this.finite(
          this.list(args[0] as Value, 'the argument of sum()').reduce<number>((total, v) => total + this.number(v, 'a summand'), 0),
          'the sum',
        );
      case 'concat':
        return this.concat(args);
      case 'zip':
        return this.zip(args);
      default:
        return this.linspace(args);
    }
  }

  private concat(args: readonly Value[]): Value {
    if (args.every((a) => typeof a === 'string')) return args.join('');
    const out = args.flatMap((a) => this.list(a, 'an argument of concat()'));
    this.checkSize(out.length, 'concat()');
    return out;
  }

  private zip(args: readonly Value[]): Value {
    const lists = args.map((a) => this.list(a, 'an argument of zip()'));
    const length = lists[0]?.length ?? 0;
    if (lists.some((l) => l.length !== length))
      throw this.type(`zip() needs lists of one length, got ${lists.map((l) => l.length).join(', ')}`, 'Slice them to one length.');
    return Array.from({ length }, (_, k) => lists.map((l) => l[k] as Value));
  }

  private linspace(args: readonly Value[]): Value {
    const a = this.number(args[0] as Value, 'the start of linspace()');
    const b = this.number(args[1] as Value, 'the end of linspace()');
    const n = this.integer(args[2] as Value, 'the count of linspace()');
    if (n < 1) throw this.type(`linspace() needs a count of at least 1, got ${n}`);
    this.checkSize(n, 'linspace()');
    return Array.from({ length: n }, (_, k) => (k === n - 1 && n > 1 ? b : a + ((b - a) * k) / Math.max(1, n - 1)));
  }
}

/** The value of `expr` under `host`. */
export function evaluateValue(expr: Expr, host: EvalHost): Value {
  return new Evaluator(host).eval(expr, null, 0);
}

/**
 * The `.lld` value grammar: text -> expression tree. Pure; no document, no aliases (names resolve when the tree is evaluated).
 *
 *   expr    = "if" expr "then" expr "else" expr | "let" NAME "=" expr "in" expr | or
 *   or/and  = "||" / "&&" over comparisons;  comparison = range [ ("==" | "!=" | "<" | "<=" | ">" | ">=") range ]
 *   range   = sum [ (".." | "..<") sum ]       (inclusive | end-exclusive, a list of integers)
 *   sum/product/unary ( + - * / - ! ), postfix ( "[" expr | range "]"  |  "." NAME ), call NAME "(" args ")"
 *   primary = NUMBER [UNIT] | STRING | true | false | null | NAME | "(" expr ")" | "[" list "]" | "{" NAME-or-STRING ":" expr, … "}"
 *   list    = expr, … | "for" NAME "in" or [ "if" expr ] ":" expr
 * @invariant length / angle unit suffixes convert at parse time (document unit / the param's angle unit); numbers never use `**`
 * @failure malformed text -> DESIGN_SYNTAX naming the position; nesting deeper than MAX_EXPR_NESTING -> DESIGN_SYNTAX
 */

import { DesignError } from './errors';
import { MM_PER_UNIT } from '@core/model/units';
import type { CadDocument } from '@core/model/types';
import { ANGLE_PARAMS } from './units';

export type Expr =
  | { readonly t: 'num'; readonly v: number }
  | { readonly t: 'str'; readonly v: string }
  | { readonly t: 'bool'; readonly v: boolean }
  | { readonly t: 'null' }
  | { readonly t: 'id'; readonly name: string }
  | { readonly t: 'call'; readonly name: string; readonly args: readonly Expr[] }
  | { readonly t: 'list'; readonly items: readonly Expr[] }
  | { readonly t: 'obj'; readonly entries: readonly { readonly key: string; readonly value: Expr }[] }
  | { readonly t: 'comp'; readonly variable: string; readonly source: Expr; readonly filter: Expr | null; readonly body: Expr }
  | { readonly t: 'if'; readonly cond: Expr; readonly then: Expr; readonly otherwise: Expr }
  | { readonly t: 'let'; readonly name: string; readonly value: Expr; readonly body: Expr }
  | { readonly t: 'un'; readonly op: '-' | '!'; readonly operand: Expr }
  | { readonly t: 'bin'; readonly op: string; readonly left: Expr; readonly right: Expr }
  | { readonly t: 'range'; readonly from: Expr; readonly to: Expr; readonly inclusive: boolean }
  | { readonly t: 'index'; readonly base: Expr; readonly selector: Expr }
  | { readonly t: 'member'; readonly base: Expr; readonly name: string };

/** Words that cannot be names. */
const KEYWORDS: readonly string[] = ['for', 'in', 'if', 'then', 'else', 'let', 'true', 'false', 'null'];

/** Parentheses / brackets / `if` / `let` nested deeper than this are refused instead of overflowing the call stack. */
const MAX_EXPR_NESTING = 100;

interface Token {
  readonly kind: 'num' | 'id' | 'str' | 'op' | 'eof';
  readonly text: string;
  readonly value: number;
  readonly at: number;
}

export interface ParseContext {
  readonly units: CadDocument['units'];
  /** `<command>.<param path>` for angle literals (units.ts ANGLE_PARAMS), or null. */
  readonly paramKey: string | null;
  readonly line: number;
}

const TOKEN =
  /\s*(?:(?<num>(?:\d+(?:\.\d+)?)(?:[eE][+-]?\d+)?(?:(?:mm|cm|m|in|ft|deg|rad)(?![\w]))?)|(?<id>[A-Za-z_]\w*)|(?<str>"(?:[^"\\]|\\.)*")|(?<op>\.\.<|\.\.|==|!=|<=|>=|&&|\|\||[-+*/()[\]{},:.<>!=]))/y;

function fail(ctx: ParseContext, detail: string, fix = 'See describe_design_syntax for the value grammar.'): DesignError {
  return new DesignError('DESIGN_SYNTAX', ctx.line, detail, fix);
}

const format = (value: number): number => Number(value.toPrecision(15));

function numberToken(text: string, ctx: ParseContext): number {
  const m = /^(.*?)(mm|cm|m|in|ft|deg|rad)?$/.exec(text);
  const base = Number(m?.[1] ?? text);
  const unit = m?.[2];
  if (unit === undefined) return base;
  if (unit === 'deg' || unit === 'rad') {
    const target = ctx.paramKey === null ? undefined : ANGLE_PARAMS[ctx.paramKey];
    if (target === undefined)
      throw new DesignError(
        'DESIGN_UNIT_NOT_SUPPORTED',
        ctx.line,
        `angle unit "${unit}" is not supported for ${ctx.paramKey ?? 'this value'}`,
        'Write the number in the unit the command description states.',
      );
    const radians = unit === 'deg' ? (base * Math.PI) / 180 : base;
    return format(target === 'deg' ? (radians * 180) / Math.PI : radians);
  }
  return format((base * MM_PER_UNIT[unit as keyof typeof MM_PER_UNIT]) / MM_PER_UNIT[ctx.units]);
}

function tokenize(text: string, ctx: ParseContext): Token[] {
  const pattern = new RegExp(TOKEN);
  const tokens: Token[] = [];
  while (pattern.lastIndex < text.length) {
    const start = pattern.lastIndex;
    if (/^\s*$/.test(text.slice(start))) break;
    const match = pattern.exec(text);
    if (match?.groups === undefined) {
      const at = start + text.slice(start).search(/\S/);
      throw fail(ctx, `unexpected character "${text.charAt(at)}" in "${text}"`);
    }
    const g = match.groups;
    if (g['num'] !== undefined) tokens.push({ kind: 'num', text: g['num'], value: numberToken(g['num'], ctx), at: start });
    else if (g['id'] !== undefined) tokens.push({ kind: 'id', text: g['id'], value: 0, at: start });
    else if (g['str'] !== undefined) tokens.push({ kind: 'str', text: JSON.parse(g['str']) as string, value: 0, at: start });
    else tokens.push({ kind: 'op', text: g['op'] ?? '', value: 0, at: start });
  }
  tokens.push({ kind: 'eof', text: '', value: 0, at: text.length });
  return tokens;
}

class Parser {
  private pos = 0;
  private depth = 0;
  constructor(
    private readonly tokens: readonly Token[],
    private readonly ctx: ParseContext,
    private readonly source: string,
  ) {}

  private get peek(): Token {
    return this.tokens[this.pos] ?? (this.tokens[this.tokens.length - 1] as Token);
  }

  private is(text: string): boolean {
    const t = this.peek;
    return (t.kind === 'op' || t.kind === 'id') && t.text === text;
  }

  private eat(text: string): boolean {
    if (!this.is(text)) return false;
    this.pos++;
    return true;
  }

  private expect(text: string): void {
    if (!this.eat(text)) throw fail(this.ctx, `expected "${text}" but found "${this.peek.text || 'end of value'}" in "${this.source}"`);
  }

  private name(): string {
    const t = this.peek;
    if (t.kind !== 'id' || KEYWORDS.includes(t.text)) throw fail(this.ctx, `expected a name, found "${t.text || 'end of value'}"`);
    this.pos++;
    return t.text;
  }

  parseAll(): Expr {
    const e = this.expr();
    if (this.peek.kind !== 'eof') throw fail(this.ctx, `unexpected "${this.peek.text}" after the value in "${this.source}"`);
    return e;
  }

  private nested<T>(fn: () => T): T {
    if (++this.depth > MAX_EXPR_NESTING) throw fail(this.ctx, `value nested deeper than ${MAX_EXPR_NESTING}`, 'Flatten the expression.');
    const r = fn();
    this.depth--;
    return r;
  }

  expr(): Expr {
    return this.nested(() => {
      if (this.eat('if')) {
        const cond = this.expr();
        this.expect('then');
        const then = this.expr();
        this.expect('else');
        return { t: 'if', cond, then, otherwise: this.expr() };
      }
      if (this.eat('let')) {
        const name = this.name();
        this.expect('=');
        const value = this.expr();
        this.expect('in');
        return { t: 'let', name, value, body: this.expr() };
      }
      return this.or();
    });
  }

  private binary(next: () => Expr, ops: readonly string[]): Expr {
    let left = next();
    while (this.peek.kind === 'op' && ops.includes(this.peek.text)) {
      const op = this.peek.text;
      this.pos++;
      left = { t: 'bin', op, left, right: next() };
    }
    return left;
  }

  private or(): Expr {
    return this.binary(() => this.and(), ['||']);
  }

  private and(): Expr {
    return this.binary(() => this.comparison(), ['&&']);
  }

  private comparison(): Expr {
    const left = this.range();
    const op = this.peek;
    if (op.kind === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(op.text)) {
      this.pos++;
      return { t: 'bin', op: op.text, left, right: this.range() };
    }
    return left;
  }

  private range(): Expr {
    const from = this.sum();
    if (this.is('..<') || this.is('..')) {
      const inclusive = this.peek.text === '..';
      this.pos++;
      return { t: 'range', from, to: this.sum(), inclusive };
    }
    return from;
  }

  private sum(): Expr {
    return this.binary(() => this.product(), ['+', '-']);
  }

  private product(): Expr {
    return this.binary(() => this.unary(), ['*', '/']);
  }

  private unary(): Expr {
    return this.nested(() => {
      if (this.eat('-')) return { t: 'un', op: '-', operand: this.unary() };
      if (this.eat('!')) return { t: 'un', op: '!', operand: this.unary() };
      return this.postfix();
    });
  }

  private postfix(): Expr {
    let base = this.primary();
    for (;;) {
      if (this.eat('[')) {
        const selector = this.nested(() => this.range());
        this.expect(']');
        base = { t: 'index', base, selector };
      } else if (this.is('.') && this.tokens[this.pos + 1]?.kind === 'id') {
        this.pos++;
        base = { t: 'member', base, name: this.name() };
      } else return base;
    }
  }

  private primary(): Expr {
    const t = this.peek;
    if (t.kind === 'num') return this.advance({ t: 'num', v: t.value });
    if (t.kind === 'str') return this.advance({ t: 'str', v: t.text });
    if (t.kind === 'id') return this.identifier(t);
    if (this.eat('(')) {
      const inner = this.expr();
      this.expect(')');
      return inner;
    }
    if (this.eat('[')) return this.nested(() => this.listBody());
    if (this.eat('{')) return this.nested(() => this.objectBody());
    throw fail(this.ctx, `unexpected "${t.text || 'end of value'}" in "${this.source}"`);
  }

  private advance(e: Expr): Expr {
    this.pos++;
    return e;
  }

  private identifier(t: Token): Expr {
    if (t.text === 'true' || t.text === 'false') return this.advance({ t: 'bool', v: t.text === 'true' });
    if (t.text === 'null') return this.advance({ t: 'null' });
    const name = this.name();
    if (!this.eat('(')) return { t: 'id', name };
    const args: Expr[] = [];
    if (!this.is(')'))
      do args.push(this.expr());
      while (this.eat(','));
    this.expect(')');
    return { t: 'call', name, args };
  }

  private listBody(): Expr {
    if (this.eat('for')) {
      const variable = this.name();
      this.expect('in');
      const source = this.or();
      const filter = this.eat('if') ? this.or() : null;
      this.expect(':');
      const body = this.expr();
      this.expect(']');
      return { t: 'comp', variable, source, filter, body };
    }
    const items: Expr[] = [];
    if (!this.is(']'))
      do {
        if (this.is(']')) break;
        items.push(this.expr());
      } while (this.eat(','));
    this.expect(']');
    return { t: 'list', items };
  }

  private objectBody(): Expr {
    const entries: { key: string; value: Expr }[] = [];
    if (!this.is('}'))
      do {
        if (this.is('}')) break;
        const t = this.peek;
        if (t.kind !== 'id' && t.kind !== 'str') throw fail(this.ctx, `expected a key, found "${t.text || 'end of value'}"`);
        this.pos++;
        this.expect(':');
        entries.push({ key: t.text, value: this.expr() });
      } while (this.eat(','));
    this.expect('}');
    return { t: 'obj', entries };
  }
}

/** The expression tree of `text`. */
export function buildValueExpr(text: string, ctx: ParseContext): Expr {
  if (text.trim() === '') throw fail(ctx, 'the value is empty');
  return new Parser(tokenize(text, ctx), ctx, text).parseAll();
}

/** Names called as `name(…)` anywhere in `expr` (for the function call graph). */
export function calledNames(expr: Expr, into: Set<string> = new Set()): Set<string> {
  switch (expr.t) {
    case 'call':
      into.add(expr.name);
      expr.args.forEach((a) => calledNames(a, into));
      break;
    case 'list':
      expr.items.forEach((a) => calledNames(a, into));
      break;
    case 'obj':
      expr.entries.forEach((e) => calledNames(e.value, into));
      break;
    case 'comp':
      [expr.source, expr.filter, expr.body].forEach((e) => e !== null && calledNames(e, into));
      break;
    case 'if':
      [expr.cond, expr.then, expr.otherwise].forEach((e) => calledNames(e, into));
      break;
    case 'let':
      calledNames(expr.value, into);
      calledNames(expr.body, into);
      break;
    case 'un':
      calledNames(expr.operand, into);
      break;
    case 'bin':
      calledNames(expr.left, into);
      calledNames(expr.right, into);
      break;
    case 'range':
      calledNames(expr.from, into);
      calledNames(expr.to, into);
      break;
    case 'index':
      calledNames(expr.base, into);
      calledNames(expr.selector, into);
      break;
    case 'member':
      calledNames(expr.base, into);
      break;
    default:
      break;
  }
  return into;
}

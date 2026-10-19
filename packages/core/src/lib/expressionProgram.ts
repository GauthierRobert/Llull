/**
 * An expression of the `@lib/expression` grammar compiled to a postfix program over indexed variables, so it can be evaluated many
 * times without parsing (Monte Carlo), differentiated exactly (forward-mode dual numbers) and shipped to a native job (the program is
 * plain JSON; `llull-stats` runs the same operations in the same order).
 * @invariant `runProgram(compile(e, names), x)` performs the operations of `evaluateExpression(e, env)` in the same order, so both
 *   give the same bits
 */

import { BUILTIN_CONSTANTS, BUILTIN_FUNCTIONS, tokenize, type Token } from './expression';

type ProgramOp =
  | { readonly op: 'const'; readonly value: number }
  | { readonly op: 'var'; readonly index: number }
  | { readonly op: 'neg' | 'add' | 'sub' | 'mul' | 'div' }
  | { readonly op: 'call'; readonly fn: string; readonly argc: number };

export type Program = readonly ProgramOp[];

/** Functions whose V8 result has no bit-exact native twin (trigonometry): a native run of a program using them agrees statistically. */
const INEXACT_FUNCTIONS: ReadonlySet<string> = new Set(['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2']);

interface Compiler {
  readonly tokens: readonly Token[];
  pos: number;
  readonly names: readonly string[];
  readonly out: ProgramOp[];
}

const peek = (c: Compiler): Token | undefined => c.tokens[c.pos];

function binary(c: Compiler, operators: string, operand: (c: Compiler) => string | null): string | null {
  const first = operand(c);
  if (first !== null) return first;
  for (let t = peek(c); t?.kind === 'op' && operators.includes(t.text); t = peek(c)) {
    c.pos += 1;
    const error = operand(c);
    if (error !== null) return error;
    c.out.push({ op: t.text === '+' ? 'add' : t.text === '-' ? 'sub' : t.text === '*' ? 'mul' : 'div' });
  }
  return null;
}

const expr = (c: Compiler): string | null => binary(c, '+-', term);
const term = (c: Compiler): string | null => binary(c, '*/', factor);

function factor(c: Compiler): string | null {
  const t = peek(c);
  if (t?.kind !== 'op' || t.text !== '-') return primary(c);
  c.pos += 1;
  const error = primary(c);
  if (error === null) c.out.push({ op: 'neg' });
  return error;
}

function call(c: Compiler, name: string): string | null {
  const def = Object.hasOwn(BUILTIN_FUNCTIONS, name) ? BUILTIN_FUNCTIONS[name] : undefined;
  if (def === undefined) return `unknown function: ${name}`;
  c.pos += 1;
  let argc = 0;
  if (peek(c)?.kind !== 'rparen') {
    for (;;) {
      const error = expr(c);
      if (error !== null) return error;
      argc += 1;
      if (peek(c)?.kind !== 'comma') break;
      c.pos += 1;
    }
  }
  if (peek(c)?.kind !== 'rparen') return `expected ')' in call to ${name}`;
  c.pos += 1;
  if (argc < def.min || argc > def.max) return `${name}() takes ${def.min}-${def.max} argument(s), got ${argc}`;
  c.out.push({ op: 'call', fn: name, argc });
  return null;
}

function primary(c: Compiler): string | null {
  const t = peek(c);
  if (t === undefined) return 'unexpected end of expression';
  c.pos += 1;
  if (t.kind === 'number') {
    c.out.push({ op: 'const', value: parseFloat(t.text) });
    return null;
  }
  if (t.kind === 'ident') {
    if (peek(c)?.kind === 'lparen') return call(c, t.text);
    const index = c.names.indexOf(t.text);
    if (index >= 0) c.out.push({ op: 'var', index });
    else if (Object.hasOwn(BUILTIN_CONSTANTS, t.text)) c.out.push({ op: 'const', value: BUILTIN_CONSTANTS[t.text] as number });
    else return `unknown name: ${t.text}`;
    return null;
  }
  if (t.kind === 'lparen') {
    const error = expr(c);
    if (error !== null) return error;
    if (peek(c)?.kind !== 'rparen') return `expected ')' but found '${peek(c)?.text ?? 'end of expression'}'`;
    c.pos += 1;
    return null;
  }
  return `unexpected token '${t.text}'`;
}

/**
 * Compiles `expression` over the variables `names` (index = position). Built-in constants (`pi`, `tau`) are inlined; a name in `names`
 * shadows them.
 * @failure syntax error, unknown name or function, wrong argument count -> the error message
 */
export function compileExpression(expression: string, names: readonly string[]): Program | string {
  const tokens = tokenize(expression);
  if (typeof tokens === 'string') return tokens;
  if (tokens.length === 0) return 'expression is empty';
  const compiler: Compiler = { tokens, pos: 0, names, out: [] };
  const error = expr(compiler);
  if (error !== null) return error;
  if (compiler.pos < tokens.length) return `unexpected token '${tokens[compiler.pos]?.text ?? ''}' after expression`;
  return compiler.out;
}

/** The program Σ a_i x_i, summed left to right. */
export function linearProgram(coefficients: readonly number[]): Program {
  return coefficients.flatMap((a, index): ProgramOp[] => [
    { op: 'const', value: a },
    { op: 'var', index },
    { op: 'mul' },
    ...(index > 0 ? [{ op: 'add' } as const] : []),
  ]);
}

/** True when every operation of the program has a bit-exact native twin (no trigonometric function). */
export const programIsBitExact = (program: Program): boolean =>
  program.every((step) => step.op !== 'call' || !INEXACT_FUNCTIONS.has(step.fn));

const ARITHMETIC: Readonly<Record<'add' | 'sub' | 'mul' | 'div', (a: number, b: number) => number>> = {
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  div: (a, b) => a / b,
};

type Node = (x: ArrayLike<number>) => number;

/** The program as a closure tree (no parsing, no allocation per evaluation). */
export function programFunction(program: Program): Node {
  const stack: Node[] = [];
  for (const step of program) {
    if (step.op === 'const') {
      const value = step.value;
      stack.push(() => value);
    } else if (step.op === 'var') {
      const index = step.index;
      stack.push((x) => x[index] as number);
    } else if (step.op === 'neg') {
      const a = stack.pop() as Node;
      stack.push((x) => -a(x));
    } else if (step.op === 'call') {
      const args = stack.splice(stack.length - step.argc, step.argc);
      const fn = (BUILTIN_FUNCTIONS[step.fn] as { fn: (...values: number[]) => number }).fn;
      const [a, b] = args as [Node, Node | undefined];
      stack.push(
        args.length === 1 ? (x) => fn(a(x)) : args.length === 2 && b ? (x) => fn(a(x), b(x)) : (x) => fn(...args.map((n) => n(x))),
      );
    } else {
      const b = stack.pop() as Node;
      const a = stack.pop() as Node;
      const operate = ARITHMETIC[step.op];
      stack.push((x) => operate(a(x), b(x)));
    }
  }
  return stack[0] ?? (() => Number.NaN);
}

interface Dual {
  readonly v: number;
  readonly d: readonly number[];
}

const scaled = (d: readonly number[], k: number): number[] => d.map((value) => value * k);
const combined = (a: readonly number[], ka: number, b: readonly number[], kb: number): number[] =>
  a.map((value, i) => value * ka + (b[i] ?? 0) * kb);

function dualCall(fn: string, args: readonly Dual[]): Dual {
  const [a = { v: Number.NaN, d: [] }, b = { v: Number.NaN, d: [] }] = args;
  const v = (BUILTIN_FUNCTIONS[fn] as { fn: (...values: number[]) => number }).fn(...args.map((arg) => arg.v));
  const zero = a.d.map(() => 0);
  switch (fn) {
    case 'sin':
      return { v, d: scaled(a.d, Math.cos(a.v)) };
    case 'cos':
      return { v, d: scaled(a.d, -Math.sin(a.v)) };
    case 'tan':
      return { v, d: scaled(a.d, 1 / (Math.cos(a.v) * Math.cos(a.v))) };
    case 'asin':
      return { v, d: scaled(a.d, 1 / Math.sqrt(1 - a.v * a.v)) };
    case 'acos':
      return { v, d: scaled(a.d, -1 / Math.sqrt(1 - a.v * a.v)) };
    case 'atan':
      return { v, d: scaled(a.d, 1 / (1 + a.v * a.v)) };
    case 'atan2': {
      const r2 = a.v * a.v + b.v * b.v;
      return { v, d: combined(a.d, b.v / r2, b.d, -a.v / r2) };
    }
    case 'sqrt':
      return { v, d: scaled(a.d, 1 / (2 * v)) };
    case 'abs':
      return { v, d: scaled(a.d, Math.sign(a.v)) };
    case 'exp':
      return { v, d: scaled(a.d, v) };
    case 'ln':
      return { v, d: scaled(a.d, 1 / a.v) };
    case 'log10':
      return { v, d: scaled(a.d, 1 / (a.v * Math.LN10)) };
    case 'pow':
      return { v, d: combined(a.d, b.v * Math.pow(a.v, b.v - 1), b.d, b.d.some((x) => x !== 0) ? v * Math.log(a.v) : 0) };
    case 'hypot':
      return { v, d: args.reduce<number[]>((sum, arg) => combined(sum, 1, arg.d, v === 0 ? 0 : arg.v / v), zero) };
    case 'mod':
      return { v, d: combined(a.d, 1, b.d, -Math.floor(a.v / b.v)) };
    case 'min':
    case 'max':
      return { v, d: (args.find((arg) => arg.v === v) ?? a).d };
    default:
      return { v, d: zero };
  }
}

/**
 * Value and exact partial derivatives ∂f/∂x_i at `x` (forward-mode automatic differentiation; floor, ceil, round, trunc and sign have
 * zero derivative, min / max follow the selected argument).
 */
export function programGradient(program: Program, x: readonly number[]): { readonly value: number; readonly gradient: number[] } {
  const n = x.length;
  const zero = (): number[] => new Array<number>(n).fill(0);
  const stack: Dual[] = [];
  for (const step of program) {
    if (step.op === 'const') stack.push({ v: step.value, d: zero() });
    else if (step.op === 'var') stack.push({ v: x[step.index] as number, d: zero().map((_, i) => (i === step.index ? 1 : 0)) });
    else if (step.op === 'neg') {
      const a = stack.pop() as Dual;
      stack.push({ v: -a.v, d: scaled(a.d, -1) });
    } else if (step.op === 'call') stack.push(dualCall(step.fn, stack.splice(stack.length - step.argc, step.argc)));
    else {
      const b = stack.pop() as Dual;
      const a = stack.pop() as Dual;
      const v = ARITHMETIC[step.op](a.v, b.v);
      const d =
        step.op === 'add'
          ? combined(a.d, 1, b.d, 1)
          : step.op === 'sub'
            ? combined(a.d, 1, b.d, -1)
            : step.op === 'mul'
              ? combined(a.d, b.v, b.d, a.v)
              : combined(a.d, 1 / b.v, b.d, -a.v / (b.v * b.v));
      stack.push({ v, d });
    }
  }
  const top = stack[0] ?? { v: Number.NaN, d: zero() };
  return { value: top.v, gradient: [...top.d] };
}

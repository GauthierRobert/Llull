/**
 * Stack-up expressions (03 GDT TR-GDT-11): the `parametric/expression` grammar (+ - * / unary minus, parentheses, numbers, names, calls)
 * parsed once to a tree, then evaluated as plain numbers (corners, Monte Carlo) or as dual numbers (exact forward-mode derivatives of
 * every contributor: no finite difference). Differentiable built-ins only: sin cos tan asin acos atan sqrt abs exp ln pow hypot; pi, tau.
 */

export type StackNode =
  | { readonly kind: 'num'; readonly value: number }
  | { readonly kind: 'var'; readonly index: number }
  | { readonly kind: 'neg'; readonly operand: StackNode }
  | { readonly kind: 'bin'; readonly op: '+' | '-' | '*' | '/'; readonly left: StackNode; readonly right: StackNode }
  | { readonly kind: 'call'; readonly name: string; readonly args: readonly StackNode[] };

export type StackParse = { readonly ok: true; readonly tree: StackNode } | { readonly ok: false; readonly error: string };

/** A value and its partial derivatives with respect to each contributor. */
interface Dual {
  readonly v: number;
  readonly d: readonly number[];
}

interface FunctionSpec {
  readonly arity: number;
  readonly value: (...x: number[]) => number;
  /** Partial derivative of the function with respect to argument `i` at `x`. */
  readonly partial: (i: number, ...x: number[]) => number;
}

const FUNCTIONS: Readonly<Record<string, FunctionSpec>> = {
  sin: { arity: 1, value: Math.sin, partial: (_i, x = 0) => Math.cos(x) },
  cos: { arity: 1, value: Math.cos, partial: (_i, x = 0) => -Math.sin(x) },
  tan: { arity: 1, value: Math.tan, partial: (_i, x = 0) => 1 / Math.cos(x) ** 2 },
  asin: { arity: 1, value: Math.asin, partial: (_i, x = 0) => 1 / Math.sqrt(1 - x * x) },
  acos: { arity: 1, value: Math.acos, partial: (_i, x = 0) => -1 / Math.sqrt(1 - x * x) },
  atan: { arity: 1, value: Math.atan, partial: (_i, x = 0) => 1 / (1 + x * x) },
  sqrt: { arity: 1, value: Math.sqrt, partial: (_i, x = 0) => 0.5 / Math.sqrt(x) },
  abs: { arity: 1, value: Math.abs, partial: (_i, x = 0) => Math.sign(x) },
  exp: { arity: 1, value: Math.exp, partial: (_i, x = 0) => Math.exp(x) },
  ln: { arity: 1, value: Math.log, partial: (_i, x = 0) => 1 / x },
  pow: { arity: 2, value: Math.pow, partial: (i, a = 0, b = 0) => (i === 0 ? b * Math.pow(a, b - 1) : Math.pow(a, b) * Math.log(a)) },
  hypot: { arity: 2, value: Math.hypot, partial: (i, a = 0, b = 0) => (i === 0 ? a : b) / Math.hypot(a, b) },
};

const CONSTANTS: Readonly<Record<string, number>> = { pi: Math.PI, tau: 2 * Math.PI };

const TOKEN = /\s*(?:(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_]\w*)|([-+*/(),])|(\S))/y;

interface Token {
  readonly kind: 'num' | 'name' | 'sym';
  readonly text: string;
}

function tokenize(source: string): Token[] | string {
  const tokens: Token[] = [];
  const pattern = new RegExp(TOKEN);
  while (pattern.lastIndex < source.length) {
    const match = pattern.exec(source);
    if (match === null) break;
    if (match[4] !== undefined) return `unexpected character '${match[4]}'`;
    if (match[1] !== undefined) tokens.push({ kind: 'num', text: match[1] });
    else if (match[2] !== undefined) tokens.push({ kind: 'name', text: match[2] });
    else if (match[3] !== undefined) tokens.push({ kind: 'sym', text: match[3] });
  }
  return tokens;
}

class ParseError extends Error {}

/** Parse `source` over the contributor `names` (position = variable index). */
export function parseStackExpression(source: string, names: readonly string[]): StackParse {
  const tokens = tokenize(source);
  if (typeof tokens === 'string') return { ok: false, error: tokens };
  let at = 0;
  const peek = (): Token | undefined => tokens[at];
  const take = (): Token | undefined => tokens[at++];
  const isSym = (text: string): boolean => peek()?.kind === 'sym' && peek()?.text === text;
  const expect = (text: string): void => {
    if (!isSym(text)) throw new ParseError(`expected '${text}'`);
    at++;
  };

  const expression = (): StackNode => {
    let left = term();
    while (isSym('+') || isSym('-')) {
      const op = take()?.text === '+' ? '+' : '-';
      left = { kind: 'bin', op, left, right: term() };
    }
    return left;
  };
  const term = (): StackNode => {
    let left = factor();
    while (isSym('*') || isSym('/')) {
      const op = take()?.text === '*' ? '*' : '/';
      left = { kind: 'bin', op, left, right: factor() };
    }
    return left;
  };
  const factor = (): StackNode => {
    if (isSym('-')) {
      take();
      return { kind: 'neg', operand: factor() };
    }
    return primary();
  };
  const primary = (): StackNode => {
    const token = take();
    if (token === undefined) throw new ParseError('unexpected end of expression');
    if (token.kind === 'num') return { kind: 'num', value: Number(token.text) };
    if (token.kind === 'sym' && token.text === '(') {
      const inner = expression();
      expect(')');
      return inner;
    }
    if (token.kind !== 'name') throw new ParseError(`unexpected '${token.text}'`);
    if (isSym('(')) return call(token.text);
    const index = names.indexOf(token.text);
    if (index >= 0) return { kind: 'var', index };
    const constant = CONSTANTS[token.text];
    if (constant !== undefined) return { kind: 'num', value: constant };
    throw new ParseError(`unknown name '${token.text}' (contributors: ${names.join(', ')})`);
  };
  const call = (name: string): StackNode => {
    const spec = Object.hasOwn(FUNCTIONS, name) ? FUNCTIONS[name] : undefined;
    if (spec === undefined) throw new ParseError(`unknown function '${name}' (available: ${Object.keys(FUNCTIONS).join(', ')})`);
    expect('(');
    const args: StackNode[] = [expression()];
    while (isSym(',')) {
      take();
      args.push(expression());
    }
    expect(')');
    if (args.length !== spec.arity) throw new ParseError(`${name} takes ${spec.arity} argument(s), got ${args.length}`);
    return { kind: 'call', name, args };
  };

  try {
    const tree = expression();
    if (at < tokens.length) throw new ParseError(`unexpected '${peek()?.text ?? ''}'`);
    return { ok: true, tree };
  } catch (error) {
    if (error instanceof ParseError) return { ok: false, error: error.message };
    throw error;
  }
}

const spec = (name: string): FunctionSpec => FUNCTIONS[name] as FunctionSpec;

/** Plain-number evaluator of `tree`: `(values) => y`. */
export function compileStackExpression(tree: StackNode): (values: readonly number[]) => number {
  const build = (node: StackNode): ((values: readonly number[]) => number) => {
    switch (node.kind) {
      case 'num':
        return () => node.value;
      case 'var':
        return (values) => values[node.index] ?? NaN;
      case 'neg': {
        const operand = build(node.operand);
        return (values) => -operand(values);
      }
      case 'bin': {
        const [left, right] = [build(node.left), build(node.right)];
        if (node.op === '+') return (values) => left(values) + right(values);
        if (node.op === '-') return (values) => left(values) - right(values);
        return node.op === '*' ? (values) => left(values) * right(values) : (values) => left(values) / right(values);
      }
      case 'call': {
        const args = node.args.map(build);
        const fn = spec(node.name).value;
        return (values) => fn(...args.map((arg) => arg(values)));
      }
    }
  };
  return build(tree);
}

/** Value and exact gradient of `tree` at `point` (forward-mode dual numbers). */
export function stackGradient(tree: StackNode, point: readonly number[]): { value: number; gradient: number[] } {
  const zeros = point.map(() => 0);
  const evaluate = (node: StackNode): Dual => {
    switch (node.kind) {
      case 'num':
        return { v: node.value, d: zeros };
      case 'var':
        return { v: point[node.index] ?? NaN, d: zeros.map((_, i) => (i === node.index ? 1 : 0)) };
      case 'neg': {
        const operand = evaluate(node.operand);
        return { v: -operand.v, d: operand.d.map((x) => -x) };
      }
      case 'bin': {
        const [a, b] = [evaluate(node.left), evaluate(node.right)];
        if (node.op === '+') return { v: a.v + b.v, d: a.d.map((x, i) => x + (b.d[i] ?? 0)) };
        if (node.op === '-') return { v: a.v - b.v, d: a.d.map((x, i) => x - (b.d[i] ?? 0)) };
        if (node.op === '*') return { v: a.v * b.v, d: a.d.map((x, i) => x * b.v + a.v * (b.d[i] ?? 0)) };
        return { v: a.v / b.v, d: a.d.map((x, i) => (x * b.v - a.v * (b.d[i] ?? 0)) / (b.v * b.v)) };
      }
      case 'call': {
        const args = node.args.map(evaluate);
        const fn = spec(node.name);
        const x = args.map((arg) => arg.v);
        const partials = args.map((_, i) => fn.partial(i, ...x));
        return { v: fn.value(...x), d: zeros.map((_, k) => args.reduce((sum, arg, i) => sum + (partials[i] ?? 0) * (arg.d[k] ?? 0), 0)) };
      }
    }
  };
  const result = evaluate(tree);
  return { value: result.v, gradient: [...result.d] };
}

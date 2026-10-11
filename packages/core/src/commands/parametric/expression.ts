/**
 * Pure expression evaluator for the llull parametric parameter system.
 *
 * @layer core/commands
 * @pure — every exported function is stateless and side-effect-free.
 *
 * Supported grammar (EBNF):
 *   expr   = term { ('+' | '-') term }
 *   term   = factor { ('*' | '/') factor }
 *   factor = ['-'] primary
 *   primary = NUMBER | IDENT | IDENT '(' [expr {',' expr}] ')' | '(' expr ')'
 *   NUMBER  = digits with optional decimal fraction and optional exponent (1e-3, .5, 2.5E+4)
 *   IDENT   = letter/underscore followed by alphanumerics/underscore
 *
 * Built-ins: constants `pi`, `tau` (a name in `env` shadows them) and functions sin cos tan asin
 * acos atan atan2 sqrt abs floor ceil round trunc sign exp ln log10 pow hypot mod min max
 * (`name(a, b)` with comma-separated args). Trig is in radians. `^` is not supported (use `pow`).
 *
 * Limitations:
 *   - References must be resolved names in the supplied `env` map (or a built-in constant).
 *   - Non-finite results (e.g. divide-by-zero) are reported as errors.
 */

import type { Parameter } from '../../model/types';

/** Successful evaluation result. */
interface EvalOk {
  readonly ok: true;
  readonly value: number;
}

/** Failed evaluation result — contains a human-readable reason. */
interface EvalErr {
  readonly ok: false;
  readonly error: string;
}

export type EvalResult = EvalOk | EvalErr;

type TokenKind = 'number' | 'ident' | 'op' | 'lparen' | 'rparen' | 'comma' | 'eof';

interface Token {
  readonly kind: TokenKind;
  readonly text: string;
}

const EOF_TOKEN: Token = { kind: 'eof', text: '' };

const BUILTIN_CONSTANTS: Readonly<Record<string, number>> = { pi: Math.PI, tau: 2 * Math.PI };

/** Built-in functions: accepted argument count range and implementation. */
const BUILTIN_FUNCTIONS: Readonly<
  Record<string, { min: number; max: number; fn: (...args: number[]) => number }>
> = {
  sin: { min: 1, max: 1, fn: Math.sin },
  cos: { min: 1, max: 1, fn: Math.cos },
  tan: { min: 1, max: 1, fn: Math.tan },
  asin: { min: 1, max: 1, fn: Math.asin },
  acos: { min: 1, max: 1, fn: Math.acos },
  atan: { min: 1, max: 1, fn: Math.atan },
  atan2: { min: 2, max: 2, fn: Math.atan2 },
  sqrt: { min: 1, max: 1, fn: Math.sqrt },
  abs: { min: 1, max: 1, fn: Math.abs },
  floor: { min: 1, max: 1, fn: Math.floor },
  ceil: { min: 1, max: 1, fn: Math.ceil },
  round: { min: 1, max: 1, fn: Math.round },
  trunc: { min: 1, max: 1, fn: Math.trunc },
  sign: { min: 1, max: 1, fn: Math.sign },
  exp: { min: 1, max: 1, fn: Math.exp },
  ln: { min: 1, max: 1, fn: Math.log },
  log10: { min: 1, max: 1, fn: Math.log10 },
  pow: { min: 2, max: 2, fn: Math.pow },
  hypot: { min: 1, max: 8, fn: Math.hypot },
  mod: { min: 2, max: 2, fn: (a, b) => a - b * Math.floor(a / b) },
  min: { min: 1, max: 16, fn: Math.min },
  max: { min: 1, max: 16, fn: Math.max },
};

/** True when `name` is a built-in constant (`pi`, `tau`). */
export function isBuiltinConstant(name: string): boolean {
  return Object.hasOwn(BUILTIN_CONSTANTS, name);
}

/** Optional whitespace, then one token (the group name is its kind) or the end of the input. */
const TOKEN_PATTERN =
  /[ \t\n\r]*(?:(?<number>(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)|(?<ident>[A-Za-z_]\w*)|(?<op>[-+*/])|(?<lparen>\()|(?<rparen>\))|(?<comma>,)|$)/y;

function tokenize(src: string): Token[] | string {
  const pattern = new RegExp(TOKEN_PATTERN);
  const tokens: Token[] = [];
  while (pattern.lastIndex < src.length) {
    const start = pattern.lastIndex;
    const match = pattern.exec(src);
    if (match === null) {
      const at = start + src.slice(start).search(/[^ \t\n\r]/);
      return `unexpected character '${src.charAt(at)}' at position ${at}`;
    }
    const [kind, text] =
      Object.entries(match.groups ?? {}).find(([, value]) => value !== undefined) ?? [];
    if (kind !== undefined && text !== undefined) tokens.push({ kind: kind as TokenKind, text });
  }
  return tokens;
}

/** Mutable parser state (stays private to this module). */
interface ParseState {
  tokens: Token[];
  pos: number;
  env: Readonly<Record<string, number>>;
}

function peek(s: ParseState): Token {
  return s.tokens[s.pos] ?? EOF_TOKEN;
}

function consume(s: ParseState): Token {
  const t = s.tokens[s.pos] ?? EOF_TOKEN;
  s.pos++;
  return t;
}

function applyOperator(op: string, left: number, right: number): number {
  if (op === '+') return left + right;
  if (op === '-') return left - right;
  return op === '*' ? left * right : left / right;
}

/** Left-associative chain of `parseOperand` separated by operators drawn from `operators`. */
function parseBinary(
  s: ParseState,
  operators: string,
  parseOperand: (s: ParseState) => EvalResult,
): EvalResult {
  let left = parseOperand(s);
  while (left.ok && peek(s).kind === 'op' && operators.includes(peek(s).text)) {
    const op = consume(s).text;
    const right = parseOperand(s);
    if (!right.ok) return right;
    left = { ok: true, value: applyOperator(op, left.value, right.value) };
  }
  return left;
}

const parseExpr = (s: ParseState): EvalResult => parseBinary(s, '+-', parseTerm);

const parseTerm = (s: ParseState): EvalResult => parseBinary(s, '*/', parseFactor);

function parseFactor(s: ParseState): EvalResult {
  // Unary minus.
  if (peek(s).kind === 'op' && peek(s).text === '-') {
    consume(s);
    const inner = parsePrimary(s);
    if (!inner.ok) return inner;
    return { ok: true, value: -inner.value };
  }
  return parsePrimary(s);
}

/** `name(arg, ...)` — the ident is consumed, the next token is '('. */
function parseCall(s: ParseState, name: string): EvalResult {
  const def = Object.hasOwn(BUILTIN_FUNCTIONS, name) ? BUILTIN_FUNCTIONS[name] : undefined;
  if (def === undefined) return { ok: false, error: `unknown function: ${name}` };
  consume(s); // '('
  const args: number[] = [];
  if (peek(s).kind !== 'rparen') {
    for (;;) {
      const arg = parseExpr(s);
      if (!arg.ok) return arg;
      args.push(arg.value);
      if (peek(s).kind !== 'comma') break;
      consume(s);
    }
  }
  if (peek(s).kind !== 'rparen') {
    return { ok: false, error: `expected ')' in call to ${name}` };
  }
  consume(s);
  if (args.length < def.min || args.length > def.max) {
    return {
      ok: false,
      error: `${name}() takes ${def.min}-${def.max} argument(s), got ${args.length}`,
    };
  }
  const value = def.fn(...args);
  return Number.isNaN(value)
    ? { ok: false, error: `${name}() is undefined for these arguments` }
    : { ok: true, value };
}

function parsePrimary(s: ParseState): EvalResult {
  const t = peek(s);

  if (t.kind === 'number') {
    consume(s);
    return { ok: true, value: parseFloat(t.text) };
  }

  if (t.kind === 'ident') {
    consume(s);
    if (peek(s).kind === 'lparen') return parseCall(s, t.text);
    const value =
      (Object.hasOwn(s.env, t.text) ? s.env[t.text] : undefined) ??
      (Object.hasOwn(BUILTIN_CONSTANTS, t.text) ? BUILTIN_CONSTANTS[t.text] : undefined);
    return value === undefined
      ? { ok: false, error: `unknown parameter: ${t.text}` }
      : { ok: true, value };
  }

  if (t.kind === 'lparen') {
    consume(s); // consume '('
    const inner = parseExpr(s);
    if (!inner.ok) return inner;
    const closing = peek(s);
    if (closing.kind !== 'rparen') {
      return {
        ok: false,
        error: `expected ')' but found '${closing.text || 'end of expression'}'`,
      };
    }
    consume(s); // consume ')'
    return inner;
  }

  if (t.kind === 'eof') return { ok: false, error: 'unexpected end of expression' };

  return { ok: false, error: `unexpected token '${t.text}'` };
}

/**
 * Evaluate a single expression string against a flat `env` map of name→value.
 *
 * @pure — no side effects; returns a typed result rather than throwing.
 * @invariant Does not mutate `env`.
 * @failure Returns EvalErr with a descriptive message on any parse/eval error, or when the
 *   result is not finite (divide-by-zero, overflow).
 *
 * @param expression  The expression string, e.g. `"width * 2 + 5"`.
 * @param env         Map of parameter name → current numeric value.
 *                    Names not in this map trigger an unknown-reference error.
 */
export function evaluateExpression(
  expression: string,
  env: Readonly<Record<string, number>>,
): EvalResult {
  if (expression.trim() === '') return { ok: false, error: 'expression is empty' };

  const tokensOrError = tokenize(expression);
  if (typeof tokensOrError === 'string') return { ok: false, error: tokensOrError };

  const state: ParseState = { tokens: tokensOrError, pos: 0, env };
  const result = parseExpr(state);
  if (!result.ok) return result;

  // Ensure the entire input was consumed.
  if (peek(state).kind !== 'eof')
    return { ok: false, error: `unexpected token '${peek(state).text}' after expression` };

  if (!Number.isFinite(result.value))
    return { ok: false, error: 'expression result is not a finite number (divide by zero?)' };
  return result;
}

/**
 * Syntax problem of `expression` independent of which parameters exist, else null. Unknown
 * references are NOT a syntax problem (a parameter may be defined later); a non-finite result
 * (divide by zero) only counts when the expression has no references to blame it on.
 *
 * @pure
 */
export function expressionSyntaxError(expression: string): string | null {
  const refs = extractReferences(expression);
  const probeEnv = Object.fromEntries([...refs].map((name) => [name, 1]));
  const result = evaluateExpression(expression, probeEnv);
  if (result.ok) return null;
  if (result.error.startsWith('expression result is not a finite'))
    return refs.size === 0 ? result.error : null;
  return result.error;
}

/**
 * Extract the set of parameter names referenced in an expression.
 * Returns an empty set if the expression is unparseable or has no references.
 *
 * @pure — used by the topological-sort cycle detector in parameters.ts.
 */
export function extractReferences(expression: string): ReadonlySet<string> {
  const tokensOrError = tokenize(expression);
  if (typeof tokensOrError === 'string') return new Set();
  const refs = new Set<string>();
  tokensOrError.forEach((tok, i) => {
    // `name(` is a function call, not a parameter reference.
    if (tok.kind === 'ident' && tokensOrError[i + 1]?.kind !== 'lparen') refs.add(tok.text);
  });
  return refs;
}

/** Parameter name → last evaluated value (parameters in error keep their last good value). */
export function parameterValues(
  parameters: Readonly<Record<string, Parameter>>,
): Record<string, number> {
  return Object.fromEntries(Object.entries(parameters).map(([name, p]) => [name, p.value]));
}

/** A number, or an expression string evaluated over the parameter values; null when it fails. */
export function resolveNumeric(
  raw: number | string,
  parameters: Readonly<Record<string, Parameter>>,
): number | null {
  if (typeof raw === 'number') return raw;
  const result = evaluateExpression(raw, parameterValues(parameters));
  return result.ok ? result.value : null;
}

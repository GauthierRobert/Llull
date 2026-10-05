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
 *   primary = NUMBER | IDENT | '(' expr ')'
 *   NUMBER  = digits with optional decimal fraction
 *   IDENT   = letter/underscore followed by alphanumerics/underscore
 *
 * Limitations (intentional for v1):
 *   - No exponentiation, modulo, or built-in functions.
 *   - References must be resolved names in the supplied `env` map.
 *   - Divide-by-zero yields Infinity (IEEE 754); callers may treat as an error.
 */

import type { Parameter } from '../model/types';

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

type TokenKind = 'number' | 'ident' | 'op' | 'lparen' | 'rparen' | 'eof';

interface Token {
  readonly kind: TokenKind;
  readonly text: string;
}

const EOF_TOKEN: Token = { kind: 'eof', text: '' };

/** Optional whitespace, then one token (the group name is its kind) or the end of the input. */
const TOKEN_PATTERN =
  /[ \t\n\r]*(?:(?<number>\d+(?:\.\d*)?)|(?<ident>[A-Za-z_]\w*)|(?<op>[-+*/])|(?<lparen>\()|(?<rparen>\))|$)/y;

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

function parsePrimary(s: ParseState): EvalResult {
  const t = peek(s);

  if (t.kind === 'number') {
    consume(s);
    return { ok: true, value: parseFloat(t.text) };
  }

  if (t.kind === 'ident') {
    consume(s);
    const value = s.env[t.text];
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

  if (t.kind === 'eof') {
    return { ok: false, error: 'unexpected end of expression' };
  }

  return { ok: false, error: `unexpected token '${t.text}'` };
}

/**
 * Evaluate a single expression string against a flat `env` map of name→value.
 *
 * @pure — no side effects; returns a typed result rather than throwing.
 * @invariant Does not mutate `env`.
 * @failure Returns EvalErr with a descriptive message on any parse/eval error.
 *   Divide-by-zero produces Infinity (IEEE 754), reported as ok:true.
 *
 * @param expression  The expression string, e.g. `"width * 2 + 5"`.
 * @param env         Map of parameter name → current numeric value.
 *                    Names not in this map trigger an unknown-reference error.
 */
export function evaluateExpression(
  expression: string,
  env: Readonly<Record<string, number>>,
): EvalResult {
  if (expression.trim() === '') {
    return { ok: false, error: 'expression is empty' };
  }

  const tokensOrError = tokenize(expression);
  if (typeof tokensOrError === 'string') {
    return { ok: false, error: tokensOrError };
  }

  const state: ParseState = { tokens: tokensOrError, pos: 0, env };
  const result = parseExpr(state);
  if (!result.ok) return result;

  // Ensure the entire input was consumed.
  if (peek(state).kind !== 'eof') {
    return { ok: false, error: `unexpected token '${peek(state).text}' after expression` };
  }

  return result;
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
  for (const tok of tokensOrError) {
    if (tok.kind === 'ident') refs.add(tok.text);
  }
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

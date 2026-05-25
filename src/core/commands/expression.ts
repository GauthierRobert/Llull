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

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

/** Successful evaluation result. */
export interface EvalOk {
  readonly ok: true;
  readonly value: number;
}

/** Failed evaluation result — contains a human-readable reason. */
export interface EvalErr {
  readonly ok: false;
  readonly error: string;
}

export type EvalResult = EvalOk | EvalErr;

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenKind = 'number' | 'ident' | 'op' | 'lparen' | 'rparen' | 'eof';

interface Token {
  readonly kind: TokenKind;
  readonly text: string;
}

const EOF_TOKEN: Token = { kind: 'eof', text: '' };

function tokenize(src: string): Token[] | string {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;

    // Skip whitespace.
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }

    // Number literal.
    if (ch >= '0' && ch <= '9') {
      let j = i;
      while (j < src.length && src[j]! >= '0' && src[j]! <= '9') j++;
      if (j < src.length && src[j] === '.') {
        j++;
        while (j < src.length && src[j]! >= '0' && src[j]! <= '9') j++;
      }
      tokens.push({ kind: 'number', text: src.slice(i, j) });
      i = j;
      continue;
    }

    // Identifier (parameter name reference).
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      let j = i + 1;
      while (
        j < src.length &&
        ((src[j]! >= 'a' && src[j]! <= 'z') ||
          (src[j]! >= 'A' && src[j]! <= 'Z') ||
          (src[j]! >= '0' && src[j]! <= '9') ||
          src[j] === '_')
      ) {
        j++;
      }
      tokens.push({ kind: 'ident', text: src.slice(i, j) });
      i = j;
      continue;
    }

    // Operators and parens.
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      tokens.push({ kind: 'op', text: ch });
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen', text: ch });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen', text: ch });
      i++;
      continue;
    }

    return `unexpected character '${ch}' at position ${i}`;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Recursive-descent parser + evaluator
// ---------------------------------------------------------------------------

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

function parseExpr(s: ParseState): EvalResult {
  let left = parseTerm(s);
  if (!left.ok) return left;

  while (peek(s).kind === 'op' && (peek(s).text === '+' || peek(s).text === '-')) {
    const op = consume(s).text;
    const right = parseTerm(s);
    if (!right.ok) return right;
    left = { ok: true, value: op === '+' ? left.value + right.value : left.value - right.value };
  }
  return left;
}

function parseTerm(s: ParseState): EvalResult {
  let left = parseFactor(s);
  if (!left.ok) return left;

  while (peek(s).kind === 'op' && (peek(s).text === '*' || peek(s).text === '/')) {
    const op = consume(s).text;
    const right = parseFactor(s);
    if (!right.ok) return right;
    left = { ok: true, value: op === '*' ? left.value * right.value : left.value / right.value };
  }
  return left;
}

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
    if (!(t.text in s.env)) {
      return { ok: false, error: `unknown parameter: ${t.text}` };
    }
    return { ok: true, value: s.env[t.text]! };
  }

  if (t.kind === 'lparen') {
    consume(s); // consume '('
    const inner = parseExpr(s);
    if (!inner.ok) return inner;
    const closing = peek(s);
    if (closing.kind !== 'rparen') {
      return { ok: false, error: `expected ')' but found '${closing.text || 'end of expression'}'` };
    }
    consume(s); // consume ')'
    return inner;
  }

  if (t.kind === 'eof') {
    return { ok: false, error: 'unexpected end of expression' };
  }

  return { ok: false, error: `unexpected token '${t.text}'` };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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

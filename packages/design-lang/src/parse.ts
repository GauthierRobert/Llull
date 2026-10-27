/**
 * `.lld` source -> statements. Pure text work: no registry, no document. Values stay unparsed nodes; their meaning comes from the target
 * param's schema later (schemaValue.ts).
 * @failure malformed line, misplaced header, unclosed block -> DESIGN_SYNTAX with its line
 */

import { DesignError } from './errors';
import { isComma, isSpace, sourceLines, splitTop, type SourceLine } from './lexer';

export type ValueNode =
  | { readonly kind: 'list'; readonly items: readonly ValueNode[] }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'json'; readonly value: unknown }
  | { readonly kind: 'word'; readonly text: string };

export interface Pair {
  /** Dotted key path: `hole.kind` -> ['hole', 'kind']. */
  readonly key: readonly string[];
  readonly value: ValueNode;
}

export type CheckOp = '==' | '~=' | '<=' | '>=' | '<' | '>';

interface Tolerance {
  readonly value: number;
  /** '%' (relative), a length unit, or null (document units). */
  readonly unit: string | null;
}

export type Statement =
  | { readonly kind: 'header'; readonly line: number; readonly name: string; readonly pairs: readonly Pair[] }
  | { readonly kind: 'param'; readonly line: number; readonly name: string; readonly expression: string }
  | {
      readonly kind: 'command';
      readonly line: number;
      readonly command: string;
      /** Alias pattern (may hold `{expr}` placeholders), or null. */
      readonly alias: string | null;
      readonly pairs: readonly Pair[];
    }
  | {
      readonly kind: 'check';
      readonly line: number;
      readonly metric: string;
      readonly pairs: readonly Pair[];
      readonly op: CheckOp;
      readonly expected: ValueNode;
      readonly tolerance: Tolerance | null;
    }
  | {
      readonly kind: 'for';
      readonly line: number;
      readonly variable: string;
      readonly from: string;
      readonly to: string;
      readonly body: readonly Statement[];
    };

/** Words that start a statement and can never be a command name (contract-tested against the registry). */
export const RESERVED_WORDS: readonly string[] = ['design', 'param', 'check', 'expect', 'for', 'in'];

const IDENTIFIER = /^[A-Za-z_]\w*$/;
const ALIAS = /^[A-Za-z_][\w{}+\-*/]*$/;
const CHECK_OPS: readonly CheckOp[] = ['==', '~=', '<=', '>=', '<', '>'];

/** Nesting limit of `for` blocks and `[…]` lists: deeper input is refused instead of overflowing the call stack. */
const MAX_NESTING = 64;

const syntax = (line: number, detail: string, fix: string): DesignError => new DesignError('DESIGN_SYNTAX', line, detail, fix);

/** The statements of `source`. */
export function parseDesign(source: string): Statement[] {
  const lines = sourceLines(source);
  const cursor = { index: 0, depth: 0 };
  const statements = parseBlock(lines, cursor, null);
  const headerAt = statements.findIndex((s) => s.kind === 'header');
  if (headerAt > 0) {
    const header = statements[headerAt];
    throw syntax(header?.line ?? 0, '"design" header must be the first statement', 'Move the design line to the top.');
  }
  return statements;
}

function parseBlock(lines: readonly SourceLine[], cursor: { index: number; depth: number }, openedAt: number | null): Statement[] {
  if (cursor.depth >= MAX_NESTING) throw syntax(openedAt ?? 0, `blocks nested deeper than ${MAX_NESTING}`, 'Flatten the nested loops.');
  cursor.depth++;
  const statements: Statement[] = [];
  while (cursor.index < lines.length) {
    const current = lines[cursor.index];
    cursor.index++;
    if (current === undefined) break;
    if (current.text === '}') {
      if (openedAt === null) throw syntax(current.line, 'unexpected "}"', 'Remove it, or open a block with "for … {".');
      cursor.depth--;
      return statements;
    }
    statements.push(parseStatement(current, lines, cursor));
  }
  if (openedAt !== null) throw syntax(openedAt, 'block opened here is never closed', 'Add a line with "}".');
  return statements;
}

function parseStatement(source: SourceLine, lines: readonly SourceLine[], cursor: { index: number; depth: number }): Statement {
  const { line, text } = source;
  const first = /^\S+/.exec(text)?.[0] ?? '';
  if (first === 'param') return parseParam(line, text);
  if (first === 'check') return parseCheck(line, text);
  if (first === 'for') {
    const m = /^for\s+([A-Za-z_]\w*)\s+in\s+(.+?)\s*\.\.\s*(.+?)\s*\{$/.exec(text);
    if (!m?.[1] || !m[2] || !m[3]) throw syntax(line, `malformed loop "${text}"`, 'Write: for i in 0..n-1 {');
    return { kind: 'for', line, variable: m[1], from: m[2], to: m[3], body: parseBlock(lines, cursor, line) };
  }
  const tokens = splitTop(text, isSpace, line);
  if (first === 'design') {
    const name = tokens[1];
    if (name === undefined || !IDENTIFIER.test(name)) throw syntax(line, 'the design needs a name', 'Write: design bracket');
    return { kind: 'header', line, name, pairs: tokens.slice(2).map((t) => parsePair(t, line)) };
  }
  return parseCommand(line, tokens);
}

function parseParam(line: number, text: string): Statement {
  const m = /^param\s+(\S+)\s*=\s*(.+)$/.exec(text);
  if (!m?.[1] || !m[2]) throw syntax(line, `malformed param "${text}"`, 'Write: param width = 80mm');
  if (!IDENTIFIER.test(m[1])) throw syntax(line, `"${m[1]}" is not a valid parameter name`, 'Use letters, digits and _ (not first).');
  return { kind: 'param', line, name: m[1], expression: m[2].trim() };
}

function parseCommand(line: number, tokens: readonly string[]): Statement {
  const command = tokens[0] ?? '';
  if (!IDENTIFIER.test(command)) throw syntax(line, `"${command}" is not a command name`, 'Start the line with a command name.');
  const second = tokens[1];
  const hasAlias = second !== undefined && !second.includes('=');
  if (hasAlias && second !== '_' && !ALIAS.test(second))
    throw syntax(line, `"${second}" is not a valid alias`, 'Use letters, digits, _ and {expr} placeholders.');
  const alias = hasAlias && second !== '_' ? second : null;
  if (tokens.includes('expect'))
    throw syntax(line, `"expect" in a command line`, `A query is a check: check ${command} <params> path=<data path> expect == <value>`);
  return { kind: 'command', line, command, alias, pairs: tokens.slice(hasAlias ? 2 : 1).map((t) => parsePair(t, line)) };
}

function parseCheck(line: number, text: string): Statement {
  const tokens = splitTop(text.replace(/±/g, ' ± '), isSpace, line);
  const expectAt = tokens.indexOf('expect');
  const metric = tokens[1];
  if (metric === undefined || expectAt < 2) throw syntax(line, 'malformed check', 'Write: check volume of=part expect ~= 1200 ± 1%');
  const op = tokens[expectAt + 1] as CheckOp | undefined;
  if (op === undefined || !CHECK_OPS.includes(op))
    throw syntax(line, `unknown comparison "${op ?? ''}"`, `Use one of ${CHECK_OPS.join(' ')}.`);
  const rest = tokens.slice(expectAt + 2);
  const tolAt = rest.findIndex((t) => t === '±' || t === '+-' || t.startsWith('±') || t.startsWith('+-'));
  const valueTokens = tolAt < 0 ? rest : rest.slice(0, tolAt);
  if (valueTokens.length === 0) throw syntax(line, 'check has no expected value', 'Write the value after the comparison.');
  const tolText =
    tolAt < 0
      ? ''
      : rest
          .slice(tolAt)
          .join('')
          .replace(/^(±|\+-)/, '');
  return {
    kind: 'check',
    line,
    metric,
    pairs: tokens.slice(2, expectAt).map((t) => parsePair(t, line)),
    op,
    expected: parseValue(valueTokens.join(' '), line),
    tolerance: tolAt < 0 ? null : parseTolerance(tolText, line),
  };
}

function parseTolerance(text: string, line: number): Tolerance {
  const m = /^(\d+(?:\.\d+)?(?:e-?\d+)?)\s*(%|[a-z]+)?$/.exec(text);
  if (!m?.[1]) throw syntax(line, `malformed tolerance "${text}"`, 'Write: ± 0.1mm or ± 2%');
  return { value: Number(m[1]), unit: m[2] ?? null };
}

function parsePair(token: string, line: number): Pair {
  const eq = token.indexOf('=');
  if (eq <= 0) throw syntax(line, `expected key=value, got "${token}"`, 'Write params as key=value.');
  const key = token.slice(0, eq).split('.');
  if (!key.every((k) => IDENTIFIER.test(k))) throw syntax(line, `"${token.slice(0, eq)}" is not a valid key`, 'Use name or name.sub.');
  return { key, value: parseValue(token.slice(eq + 1), line) };
}

/** One value token: `[…]` list, `"…"` string, `{…}` JSON, anything else a word (number, expression, name, anchor, boolean). */
export function parseValue(text: string, line: number, depth = 0): ValueNode {
  if (depth > MAX_NESTING) throw syntax(line, `lists nested deeper than ${MAX_NESTING}`, 'Flatten the list.');
  if (text === '') throw syntax(line, 'missing value', 'Write a value after "=".');
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) throw syntax(line, `malformed list "${text}"`, 'Close the list with "]".');
    return { kind: 'list', items: splitTop(text.slice(1, -1), isComma, line).map((item) => parseValue(item, line, depth + 1)) };
  }
  if (text.startsWith('"') || text.startsWith('{')) {
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === 'string' ? { kind: 'string', value } : { kind: 'json', value };
    } catch {
      throw syntax(line, `malformed ${text.startsWith('"') ? 'string' : 'JSON'} ${text}`, 'Use JSON syntax inside quotes / braces.');
    }
  }
  return { kind: 'word', text };
}

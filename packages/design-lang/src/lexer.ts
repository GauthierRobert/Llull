/**
 * Lexing of `.lld` source: numbered lines without comments, and splitting at top level (outside quotes and brackets).
 * @invariant a `#` starts a comment only at the start of a line or after whitespace (`color="#c8553d"` and `color=#c8553d` survive)
 */

import { DesignError } from './errors';

export interface SourceLine {
  /** 1-based line number in the source. */
  readonly line: number;
  readonly text: string;
}

/** Non-empty lines, comments removed, trimmed. */
export function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  source.split(/\r?\n/).forEach((raw, index) => {
    const text = withoutComment(raw).trim();
    if (text !== '') lines.push({ line: index + 1, text });
  });
  return lines;
}

function withoutComment(raw: string): string {
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"' && raw[i - 1] !== '\\') quoted = !quoted;
    if (c === '#' && !quoted && (i === 0 || /\s/.test(raw[i - 1] ?? ''))) return raw.slice(0, i);
  }
  return raw;
}

const OPEN = new Set(['[', '{', '(']);
const CLOSE = new Set([']', '}', ')']);

/**
 * `text` split where `isSeparator` matches outside quotes and brackets; empty pieces dropped.
 * @failure unbalanced brackets or quotes -> DESIGN_SYNTAX on `line`
 */
export function splitTop(text: string, isSeparator: (c: string) => boolean, line: number): string[] {
  const pieces: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? '';
    if (c === '"' && text[i - 1] !== '\\') quoted = !quoted;
    if (!quoted && OPEN.has(c)) depth++;
    if (!quoted && CLOSE.has(c)) depth--;
    if (depth < 0) throw new DesignError('DESIGN_SYNTAX', line, `unexpected "${c}" in "${text}"`, 'Balance the brackets.');
    if (!quoted && depth === 0 && isSeparator(c)) {
      if (current.trim() !== '') pieces.push(current.trim());
      current = '';
    } else current += c;
  }
  if (quoted) throw new DesignError('DESIGN_SYNTAX', line, `unterminated string in "${text}"`, 'Close the string with ".');
  if (depth !== 0) throw new DesignError('DESIGN_SYNTAX', line, `unbalanced brackets in "${text}"`, 'Balance the brackets.');
  if (current.trim() !== '') pieces.push(current.trim());
  return pieces;
}

export const isSpace = (c: string): boolean => c === ' ' || c === '\t';
export const isComma = (c: string): boolean => c === ',';

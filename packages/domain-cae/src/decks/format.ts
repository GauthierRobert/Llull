/** Deterministic INP text primitives: numbers (12 significant digits, shortest form) and wrapped integer lists. */

import { significantNumber } from '@lib/compactNumber';

/** `%.12g`-style number: at most 12 significant digits, no trailing zeros, `-0` written as `0`. Non-finite values are a caller bug. */
export const num = (value: number): string => (value === 0 ? '0' : significantNumber(value, 12));

/** Comma-separated data line. */
export const row = (...values: readonly (number | string)[]): string => values.map((v) => (typeof v === 'number' ? num(v) : v)).join(', ');

/** Longest free-text fragment written into a deck comment. */
const COMMENT_FRAGMENT_MAX = 120;

/**
 * Free text made safe for a `**` comment: control characters (CR, LF, NUL, U+2028 ...) become one space, the result is trimmed and capped
 * at `max` characters, so user text can never start a new deck line.
 * @invariant the result has no line break; every free-text fragment written to a deck goes through it
 */
export const commentText = (text: string, max: number = COMMENT_FRAGMENT_MAX): string =>
  text
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ')
    .trim()
    .slice(0, max);

/** Integer ids wrapped at 16 per line (CalculiX limit), each line `a, b, c`. */
export function idLines(ids: readonly number[]): string[] {
  const lines: string[] = [];
  for (let i = 0; i < ids.length; i += 16) lines.push(ids.slice(i, i + 16).join(', '));
  return lines;
}

/** Lines to text: each line terminated by a newline; no lines = ''. */
export const linesText = (lines: readonly string[]): string => (lines.length === 0 ? '' : `${lines.join('\n')}\n`);

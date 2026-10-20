/**
 * Linear-time scanners for the composite records (no backtracking regular expressions on file content): references outside string literals, the number
 * list of a point / direction, the value of a measure / value / integer item. Hostile input (a megabyte of digits, a huge list) costs O(length).
 * @invariant every function is a single pass over its input; a malformed number yields undefined / an empty list, never an exception
 */

const MAX_TOKEN = 40;
const NUMBER_TOKEN = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[Ee][-+]?\d+)?$/;

/** A finite Part 21 number from one token (at most 40 characters), else undefined. */
export function toNumber(raw: string): number | undefined {
  const token = raw.trim();
  if (token.length === 0 || token.length > MAX_TOKEN || !NUMBER_TOKEN.test(token)) return undefined;
  const value = Number(token);
  return Number.isFinite(value) ? value : undefined;
}

/** Index just after the string literal that opens at `start` (a quote), '' escapes honoured; `length` when unterminated. */
function skipString(body: string, start: number): number {
  let at = start + 1;
  while (at < body.length) {
    if (body.charCodeAt(at) === 39) {
      if (body.charCodeAt(at + 1) === 39) at += 2;
      else return at + 1;
    } else at++;
  }
  return body.length;
}

/** The `#n` references of a body outside its string literals, in order. */
export function referencesOutsideStrings(body: string): number[] {
  const out: number[] = [];
  let at = 0;
  while (at < body.length) {
    const code = body.charCodeAt(at);
    if (code === 39) at = skipString(body, at);
    else if (code === 35) {
      let end = at + 1;
      while (end < body.length && body.charCodeAt(end) >= 48 && body.charCodeAt(end) <= 57) end++;
      if (end > at + 1 && end - at <= 12) out.push(Number(body.slice(at + 1, end)));
      at = Math.max(end, at + 1);
    } else at++;
  }
  return out;
}

/** The text after the first string literal of a body (its attribute list continues there), or '' when there is none. */
function afterFirstString(body: string): string {
  const open = body.indexOf("'");
  return open < 0 ? '' : body.slice(skipString(body, open));
}

/** The numbers of the last parenthesised list of a point / direction (`NAME('x',(1.,2.,3.))`), or [] when any token is not a number or there are more than `max`. */
export function numberList(body: string, max = 6): number[] {
  const text = afterFirstString(body);
  const open = text.indexOf('(');
  if (open < 0) return [];
  const close = text.indexOf(')', open);
  if (close < 0) return [];
  const tokens = text.slice(open + 1, close).split(',', max + 1);
  if (tokens.length > max) return [];
  const values = tokens.map(toNumber);
  return values.every((value) => value !== undefined) ? (values as number[]) : [];
}

/** The number of an item `NAME('x',KIND(1.5),#unit)` / `NAME('x',KIND(1.5))` / `NAME('x',1.5)`, else undefined. */
export function itemValue(body: string): number | undefined {
  const text = afterFirstString(body).replace(/^\s*,\s*/, '');
  const open = text.indexOf('(');
  const comma = text.indexOf(',');
  if (open >= 0 && (comma < 0 || open < comma)) {
    const close = text.indexOf(')', open);
    return close < 0 ? undefined : toNumber(text.slice(open + 1, close));
  }
  const end = text.search(/[,)]/);
  return toNumber(end < 0 ? text : text.slice(0, end));
}

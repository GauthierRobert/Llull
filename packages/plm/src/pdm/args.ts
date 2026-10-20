/**
 * Attribute lists of Part 21 records: `ENTITY(a,b,(c,d),#5,.ENUM.,TYPE(1.),$,*)` and complex instances `(A() B(#1))` parsed into plain values.
 * @invariant one pass, linear in the body; nesting is capped (a body of unbalanced or very deep parentheses is refused, never recursed to exhaustion); never throws
 */

import { unescapeStep } from '@lib/step21/decode';

export type Arg =
  | string
  | number
  | null
  | { readonly ref: number }
  | { readonly enumeration: string }
  | { readonly typed: string; readonly value: Arg }
  | readonly Arg[];

export interface Call {
  readonly entity: string;
  readonly args: readonly Arg[];
}

const MAX_DEPTH = 12;
const NAME = /[A-Z][A-Z0-9_]*/y;
const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[Ee][-+]?\d+)?/y;

class Cursor {
  at = 0;
  constructor(readonly text: string) {}
  skipSpace(): void {
    while (this.text.charCodeAt(this.at) === 32) this.at += 1;
  }
  peek(): string {
    this.skipSpace();
    return this.text[this.at] ?? '';
  }
}

function value(cursor: Cursor, depth: number): Arg | undefined {
  if (depth > MAX_DEPTH) return undefined;
  const char = cursor.peek();
  const { text } = cursor;
  if (char === '$' || char === '*') {
    cursor.at += 1;
    return null;
  }
  if (char === "'") {
    let end = cursor.at + 1;
    for (;;) {
      end = text.indexOf("'", end);
      if (end < 0) return undefined;
      if (text[end + 1] === "'") end += 2;
      else break;
    }
    const raw = text.slice(cursor.at + 1, end).replaceAll("''", "'");
    cursor.at = end + 1;
    return unescapeStep(raw);
  }
  if (char === '#') {
    let end = cursor.at + 1;
    while (end < text.length && text.charCodeAt(end) >= 48 && text.charCodeAt(end) <= 57) end += 1;
    if (end === cursor.at + 1 || end - cursor.at > 12) return undefined;
    const id = Number(text.slice(cursor.at + 1, end));
    cursor.at = end;
    return { ref: id };
  }
  if (char === '.') {
    const end = text.indexOf('.', cursor.at + 1);
    const name = end < 0 ? '' : text.slice(cursor.at + 1, end);
    if (/^[A-Z0-9_]+$/.test(name)) {
      cursor.at = end + 1;
      return { enumeration: name };
    }
  }
  if (char === '(') {
    cursor.at += 1;
    return list(cursor, depth + 1);
  }
  NAME.lastIndex = cursor.at;
  const name = NAME.exec(text);
  if (name !== null) {
    cursor.at = NAME.lastIndex;
    if (cursor.peek() !== '(') return undefined;
    cursor.at += 1;
    const inner = list(cursor, depth + 1);
    return inner === undefined ? undefined : { typed: name[0], value: inner.length === 1 ? (inner[0] as Arg) : inner };
  }
  NUMBER.lastIndex = cursor.at;
  const number = NUMBER.exec(text);
  if (number === null || number[0].length > 40) return undefined;
  cursor.at = NUMBER.lastIndex;
  return Number(number[0]);
}

/** Values up to the matching `)` (the opening one already consumed). */
function list(cursor: Cursor, depth: number): Arg[] | undefined {
  const items: Arg[] = [];
  if (cursor.peek() === ')') {
    cursor.at += 1;
    return items;
  }
  for (;;) {
    const item = value(cursor, depth);
    if (item === undefined) return undefined;
    items.push(item);
    const next = cursor.peek();
    cursor.at += 1;
    if (next === ')') return items;
    if (next !== ',') return undefined;
  }
}

function call(cursor: Cursor): Call | undefined {
  NAME.lastIndex = cursor.at;
  const name = NAME.exec(cursor.text);
  if (name === null) return undefined;
  cursor.at = NAME.lastIndex;
  if (cursor.peek() !== '(') return undefined;
  cursor.at += 1;
  const args = list(cursor, 1);
  return args === undefined ? undefined : { entity: name[0], args };
}

/** The calls of a record body: one for a simple instance, several for a complex instance `(A() B(...))`; null when it does not parse. */
export function parseBody(body: string): readonly Call[] | null {
  const cursor = new Cursor(body.trim());
  if (cursor.peek() !== '(') {
    const single = call(cursor);
    return single === undefined ? null : [single];
  }
  cursor.at += 1;
  const calls: Call[] = [];
  while (cursor.peek() !== ')') {
    const part = call(cursor);
    if (part === undefined) return null;
    calls.push(part);
  }
  return calls;
}

export const asString = (arg: Arg | undefined): string | null => (typeof arg === 'string' ? arg : null);
export const asRef = (arg: Arg | undefined): number | null => (typeof arg === 'object' && arg !== null && 'ref' in arg ? arg.ref : null);
export const asRefs = (arg: Arg | undefined): number[] =>
  Array.isArray(arg) ? (arg as readonly Arg[]).flatMap((item) => (asRef(item) === null ? [] : [asRef(item) as number])) : [];
export const asNumber = (arg: Arg | undefined): number | null => (typeof arg === 'number' ? arg : null);

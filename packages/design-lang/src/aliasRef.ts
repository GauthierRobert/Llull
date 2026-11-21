/**
 * Alias references in a value: `name`, `name[expr]`, `name[-1]`, `name[a..<b]`, `name[a..b]`, `name.entity`, `name.entities`,
 * `name.entities[expr]`. Pure parsing and selection; the interpreter supplies the live ids and the expression evaluator.
 * @invariant a selector never reaches outside the ids (DESIGN_INDEX_RANGE); an index yields one id, a range a group
 */

import { DesignError } from './errors';

export interface AliasRefParts {
  readonly name: string;
  /** `entity` = the first entity the line created, `entities` = all of them, null = the alias ids themselves. */
  readonly member: 'entity' | 'entities' | null;
  /** Text between `[` and `]`, else null. */
  readonly selector: string | null;
}

const REF = /^([A-Za-z_][\w{}+\-*/]*(?:\.[A-Za-z_][\w{}+\-*/]*)*?)(?:\.(entity|entities))?(?:\[([^[\]]*)\])?$/;

/** The parts of a reference word, or null when the word is not shaped like one (an expression, a number, a dotted id…). */
export function splitAliasRef(text: string): AliasRefParts | null {
  const m = REF.exec(text);
  if (m?.[1] === undefined) return null;
  return { name: m[1], member: m[2] === 'entity' || m[2] === 'entities' ? m[2] : null, selector: m[3] ?? null };
}

/** True when the word is a reference with no arithmetic outside its `{…}` and `[…]` parts (an untyped value then reads as a name). */
export function isPlainRef(text: string): boolean {
  return splitAliasRef(text) !== null && !/[+\-*/]/.test(text.replace(/\{[^{}]*\}|\[[^[\]]*\]/g, ''));
}

export interface Selection {
  readonly ids: string[];
  /** A range keeps group arity even when it selects one id. */
  readonly group: boolean;
}

function indexError(label: string, count: number, detail: string, line: number): DesignError {
  return new DesignError(
    'DESIGN_INDEX_RANGE',
    line,
    `${label}[…]: ${detail}`,
    count === 0 ? `${label} is empty.` : `${label} has ${count} item(s): index 0..${count - 1} or -${count}..-1.`,
  );
}

/** `items[index]` (negative counts from the end). @failure non-integer or outside -> DESIGN_INDEX_RANGE */
export function pickAt<T>(items: readonly T[], label: string, index: number, line: number): T {
  if (!Number.isInteger(index)) throw indexError(label, items.length, `${index} is not an integer`, line);
  const item = items[index < 0 ? items.length + index : index];
  if (item === undefined) throw indexError(label, items.length, `index ${index} is outside the ${items.length} item(s)`, line);
  return item;
}

/** `items[from..<to]` / `items[from..to]` (negative counts from the end). @failure empty or outside -> DESIGN_INDEX_RANGE */
export function pickSlice<T>(items: readonly T[], label: string, from: number, to: number, inclusive: boolean, line: number): T[] {
  if (!Number.isInteger(from) || !Number.isInteger(to)) throw indexError(label, items.length, `range ${from}..${to} is not integer`, line);
  const wrap = (value: number): number => (value < 0 ? items.length + value : value);
  const start = wrap(from);
  const end = inclusive ? wrap(to) + 1 : wrap(to);
  if (start < 0 || end > items.length || start >= end)
    throw indexError(label, items.length, `range ${start}..<${end} is empty or outside 0..<${items.length}`, line);
  return items.slice(start, end);
}

/** Apply the selector text to `ids` (`evalInt` evaluates an index expression to a number). */
export function selectIds(
  ids: readonly string[],
  name: string,
  selector: string,
  evalInt: (expression: string) => number,
  line: number,
): Selection {
  const range = /^(.*?)\.\.(<?)(.*)$/.exec(selector);
  const count = ids.length;
  const bad = (detail: string): DesignError =>
    new DesignError(
      'DESIGN_INDEX_RANGE',
      line,
      `${name}[${selector}]: ${detail}`,
      count === 0 ? `${name} has no ids.` : `${name} has ${count} id(s): index 0..${count - 1} or -${count}..-1.`,
    );
  const integer = (expression: string): number => {
    const value = evalInt(expression);
    if (!Number.isInteger(value)) throw bad(`"${expression}" is ${value}, not an integer`);
    return value;
  };
  const wrap = (value: number): number => (value < 0 ? count + value : value);
  if (range === null) {
    const index = integer(selector);
    const id = ids[wrap(index)];
    if (id === undefined) throw bad(`index ${index} is outside the ${count} id(s)`);
    return { ids: [id], group: false };
  }
  const from = wrap(integer(range[1] ?? ''));
  const last = wrap(integer(range[3] ?? ''));
  const end = range[2] === '<' ? last : last + 1;
  if (from < 0 || end > count || from >= end) throw bad(`range ${from}..<${end} is empty or outside 0..<${count}`);
  return { ids: ids.slice(from, end), group: true };
}

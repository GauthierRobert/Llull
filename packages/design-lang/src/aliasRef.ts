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

const REF = /^([A-Za-z_][\w{}+\-*/]*?)(?:\.(entity|entities))?(?:\[([^[\]]*)\])?$/;

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

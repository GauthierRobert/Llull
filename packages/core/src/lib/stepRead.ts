/**
 * ISO 10303-21 reader for the IFC / STEP physical files llull checks and summarises (plant 08 DAT §5.12): header schema, `#n=ENTITY(args);` records, strings
 * ('' and the `\X2\` escapes), nested lists, typed values (`IFCMASSMEASURE(5.)` is the list `['IFCMASSMEASURE', '5.']`), enumerations, `$`, `*` and the
 * reference closure of the file. Built on the one-pass record scanner of `step21/records.ts`; promoted from the tokenizer of the production IFC oracle.
 * @invariant pure; linear in the text; size, entity and nesting limits refuse with an error entry, never an exception; strings keep their quotes
 */

import { unescapeStep } from './step21/decode';
import { entityName, parseRecords } from './step21/records';

export type StepValue = string | StepValue[];

export interface StepEntity {
  readonly id: number;
  readonly type: string;
  readonly args: StepValue[];
}

export interface StepFile {
  /** First schema named by `FILE_SCHEMA` (`IFC4`, `IFC4X3_ADD2`), '' when the header has none. */
  readonly schema: string;
  readonly entities: Map<number, StepEntity>;
  /** Structure errors, at most `MAX_STEP_ERRORS` (an empty list means the file is well-formed). */
  readonly errors: string[];
}

const MAX_STEP_TEXT = 400_000_000;
const MAX_STEP_ENTITIES = 4_000_000;
export const MAX_STEP_ERRORS = 200;
const MAX_STEP_DEPTH = 64;

const SCHEMA = /FILE_SCHEMA\s{0,64}\(\s{0,64}\(\s{0,64}'([^']{1,128})'/;

/** Argument list of a record body (the text between the outer parentheses); null when nesting is deeper than `MAX_STEP_DEPTH`. */
function argumentsOf(text: string): StepValue[] | null {
  const root: StepValue[] = [];
  const stack: StepValue[][] = [root];
  let tokenStart = 0;
  let inString = false;
  const flush = (end: number): void => {
    const token = text.slice(tokenStart, end).trim();
    if (token !== '') stack[stack.length - 1]?.push(token);
  };
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if (inString) {
      if (code === 39) {
        if (text.charCodeAt(at + 1) === 39) at++;
        else inString = false;
      }
      continue;
    }
    if (code === 39) inString = true;
    else if (code === 40) {
      const typeName = text.slice(tokenStart, at).trim();
      const list: StepValue[] = typeName === '' ? [] : [typeName];
      stack[stack.length - 1]?.push(list);
      if (stack.length > MAX_STEP_DEPTH) return null;
      stack.push(list);
      tokenStart = at + 1;
    } else if (code === 41) {
      flush(at);
      if (stack.length > 1) stack.pop();
      tokenStart = at + 1;
    } else if (code === 44) {
      flush(at);
      tokenStart = at + 1;
    }
  }
  flush(text.length);
  return root;
}

/** Every `#n` reference inside a value tree. */
export function stepReferences(values: readonly StepValue[]): number[] {
  const refs: number[] = [];
  const visit = (items: readonly StepValue[]): void => {
    for (const value of items) {
      if (Array.isArray(value)) visit(value);
      else if (value.charCodeAt(0) === 35) {
        const id = Number(value.slice(1));
        if (Number.isInteger(id)) refs.push(id);
      }
    }
  };
  visit(values);
  return refs;
}

/** The text of a STEP string value (quotes removed, '' and the `\X2\` escapes undone); '$', '*' and non-strings give ''. */
export function stepString(value: StepValue | undefined): string {
  if (typeof value !== 'string' || !value.startsWith("'")) return '';
  return unescapeStep(value.slice(1, -1).replace(/''/g, "'"));
}

/** Reads a STEP physical file; a damaged record is reported in `errors` and skipped. */
export function readStep(text: string): StepFile {
  const errors: string[] = [];
  const entities = new Map<number, StepEntity>();
  const note = (message: string): void => {
    if (errors.length < MAX_STEP_ERRORS) errors.push(message);
  };
  if (text.length > MAX_STEP_TEXT) {
    note(`file larger than ${MAX_STEP_TEXT} characters`);
    return { schema: '', entities, errors };
  }
  const { header, bodies } = parseRecords(text);
  const schema = SCHEMA.exec(header)?.[1] ?? '';
  if (!text.startsWith('ISO-10303-21;')) note('missing ISO-10303-21 header');
  if (!text.trimEnd().endsWith('END-ISO-10303-21;')) note('missing END-ISO-10303-21 trailer');
  for (const [id, body] of bodies) {
    if (entities.size >= MAX_STEP_ENTITIES) {
      note(`more than ${MAX_STEP_ENTITIES} entities`);
      break;
    }
    const type = entityName(body);
    const open = body.indexOf('(');
    if (type === '(complex)' || open < 0 || !body.endsWith(')')) {
      note(`unparsable statement: #${id}=${body.slice(0, 60)}`);
      continue;
    }
    const args = argumentsOf(body.slice(open + 1, -1));
    if (args === null) {
      note(`#${id} ${type}: nesting deeper than ${MAX_STEP_DEPTH}`);
      continue;
    }
    entities.set(id, { id, type, args });
  }
  for (const entity of entities.values()) {
    for (const ref of stepReferences(entity.args)) if (!entities.has(ref)) note(`#${entity.id} ${entity.type} references missing #${ref}`);
  }
  return { schema, entities, errors };
}

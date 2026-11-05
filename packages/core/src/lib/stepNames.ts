/**
 * STEP part names that survive CadQuery's STEP writer (QUALITY_GATES defect 15: `Ø20 Welle` came back as `Ã20 Welle`).
 * The writer double-encodes non-ASCII names, so the generated script carries ASCII placeholders (`withAsciiStepNames`) and the STEP text
 * it returns gets the real names back, encoded as ISO 10303-21 strings (`restoreStepNames`).
 */

import { encodeStepString } from './step21/encode';

/** Placeholder map of one generated script: placeholder text -> the real name. */
export interface StepNamePlaceholders {
  readonly prefix: string;
  readonly names: ReadonlyMap<string, string>;
}

const PLACEHOLDER_DIGITS = 6;
/** A solid name in the generated script: `name=<json>` (a primitive) or `label(<ident>, <json>)` (a rename). */
const NAME_LITERAL = /(\bname=|\blabel\(\w+, )("(?:[^"\\\n]|\\.)*")/g;

/** True when the STEP writer would not carry `name` through unchanged: anything but plain printable ASCII without apostrophe or backslash. */
const needsPlaceholder = (name: string): boolean => /[^\x20-\x26\x28-\x5b\x5d-\x7e]/.test(name);

/**
 * `source` with every solid name that needs it replaced by an ASCII placeholder, and the map to put the names back. The placeholder prefix never occurs in
 * `source`, so a name that looks like a placeholder is never mistaken for one.
 */
export function withAsciiStepNames(source: string): { source: string; placeholders: StepNamePlaceholders } {
  let prefix = 'llull_name_';
  while (source.includes(prefix)) prefix += 'x';
  const names = new Map<string, string>();
  const byName = new Map<string, string>();
  const replaced = source.replace(NAME_LITERAL, (whole: string, head: string, literal: string) => {
    let name: unknown;
    try {
      name = JSON.parse(literal);
    } catch {
      return whole;
    }
    if (typeof name !== 'string' || !needsPlaceholder(name)) return whole;
    let placeholder = byName.get(name);
    if (placeholder === undefined) {
      placeholder = `${prefix}${String(names.size + 1).padStart(PLACEHOLDER_DIGITS, '0')}`;
      byName.set(name, placeholder);
      names.set(placeholder, name);
    }
    return `${head}${JSON.stringify(placeholder)}`;
  });
  return { source: replaced, placeholders: { prefix, names } };
}

/** A line break the STEP writer put inside a string literal, with the indentation that follows it. */
const LINE_FOLD = /\r?\n[ \t]*/g;

/**
 * `stepText` with every placeholder inside a STEP string literal replaced by the Part 21 encoding of its name. A literal the writer wrapped over lines
 * (a line break + indentation inside the quotes, e.g. a name longer than the 72-character line) is unfolded first, but only when that reveals a
 * placeholder: a raw line break is not a Part 21 string character (ours are escaped as \\X2\\000A\\X0\\), so no real name is altered.
 */
export function restoreStepNames(stepText: string, placeholders: StepNamePlaceholders): string {
  if (placeholders.names.size === 0) return stepText;
  const placeholder = new RegExp(`${placeholders.prefix}\\d{${PLACEHOLDER_DIGITS}}`, 'g');
  return stepText.replace(/'(?:[^']|'')*'/g, (literal) => {
    const unfolded = LINE_FOLD.test(literal) ? literal.replace(LINE_FOLD, '') : literal;
    LINE_FOLD.lastIndex = 0;
    if (!placeholder.test(unfolded)) return literal;
    placeholder.lastIndex = 0;
    return unfolded.replace(placeholder, (found) => {
      const name = placeholders.names.get(found);
      return name === undefined ? found : encodeStepString(name, 'run');
    });
  });
}

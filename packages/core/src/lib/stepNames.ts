/**
 * STEP part names that survive CadQuery's STEP writer (QUALITY_GATES defect 15: `Ø20 Welle` came back as `Ã20 Welle`).
 * The writer double-encodes non-ASCII names, so the generated script carries ASCII placeholders (`withAsciiStepNames`) and the STEP text
 * it returns gets the real names back, encoded as ISO 10303-21 strings (`restoreStepNames`).
 */

/**
 * A Part 21 string literal body for `text` (ISO 10303-21:2002, 6.4.3 "String"): printable ASCII (U+0020..U+007E) stands for itself, except that an
 * apostrophe is written twice and a reverse solidus twice; everything else is a hexadecimal escape: `\X2\` + four hex digits per UTF-16 code unit of
 * the Basic Multilingual Plane + `\X0\`, and `\X4\` + eight hex digits per code point for characters above U+FFFF (a surrogate pair is not a
 * UCS-2 character, so an astral code point is never written as two `\X2\` units). Control characters are escaped too: a raw one is not a Part 21 character.
 */
export function step21String(text: string): string {
  let out = '';
  let run = '';
  let runKind: 'X2' | 'X4' | null = null;
  const flush = (): void => {
    if (runKind !== null) out += `\\${runKind}\\${run}\\X0\\`;
    run = '';
    runKind = null;
  };
  const escape = (kind: 'X2' | 'X4', hex: string): void => {
    if (runKind !== kind) flush();
    runKind = kind;
    run += hex;
  };
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x20 && code <= 0x7e) {
      flush();
      out += char === "'" ? "''" : char === '\\' ? '\\\\' : char;
    } else if (code > 0xffff) escape('X4', code.toString(16).toUpperCase().padStart(8, '0'));
    else escape('X2', code.toString(16).toUpperCase().padStart(4, '0'));
  }
  flush();
  return out;
}

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

/** `stepText` with every placeholder inside a STEP string literal replaced by the Part 21 encoding of its name. */
export function restoreStepNames(stepText: string, placeholders: StepNamePlaceholders): string {
  if (placeholders.names.size === 0) return stepText;
  const placeholder = new RegExp(`${placeholders.prefix}\\d{${PLACEHOLDER_DIGITS}}`, 'g');
  return stepText.replace(/'(?:[^']|'')*'/g, (literal) =>
    literal.replace(placeholder, (found) => {
      const name = placeholders.names.get(found);
      return name === undefined ? found : step21String(name);
    }),
  );
}

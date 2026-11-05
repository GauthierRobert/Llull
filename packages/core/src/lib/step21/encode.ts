/**
 * Encoding of ISO 10303-21 string and REAL values (the inverse of `decode.ts` for strings).
 * @invariant pure; strings never contain a bare quote, backslash or non-ASCII character
 */

const hex = (value: number, width: number): string => value.toString(16).toUpperCase().padStart(width, '0');

/** How `encodeStepString` groups its escapes (see there). */
export type StepStringMode = 'per-char' | 'utf16-run' | 'run';

/** ISO 10303-21 6.4.3: only U+0020..U+007E stand for themselves; U+007F and the control characters are escaped. */
const isPrintable = (code: number): boolean => code >= 32 && code <= 126;

/**
 * The body of a Part 21 string (no surrounding quotes): `'` and `\` doubled, everything else outside U+0020..U+007E escaped.
 * @param mode 'per-char' (default): one `\X2\hhhh\X0\` (BMP) or `\X4\hhhhhhhh\X0\` (beyond it) per character, control characters escaped.
 *   'run': a run of escaped characters is ONE escape (`\X2\` units of the BMP, `\X4\` code points beyond it), control characters escaped too.
 *   'utf16-run': a run of non-ASCII characters is ONE `\X2\` escape of UTF-16 units (an astral character as a surrogate pair, no `\X4\`), control
 *   characters left as they are (labels whose control characters were replaced beforehand).
 */
export function encodeStepString(text: string, mode: StepStringMode = 'per-char'): string {
  let out = '';
  if (mode === 'per-char') {
    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;
      if (char === "'") out += "''";
      else if (char === '\\') out += '\\\\';
      else if (code > 0xffff) out += `\\X4\\${hex(code, 8)}\\X0\\`;
      else if (!isPrintable(code)) out += `\\X2\\${hex(code, 4)}\\X0\\`;
      else out += char;
    }
    return out;
  }
  let run = '';
  let runKind: 'X2' | 'X4' | null = null;
  const flush = (): void => {
    if (runKind !== null) out += `\\${runKind}\\${run}\\X0\\`;
    run = '';
    runKind = null;
  };
  const escape = (kind: 'X2' | 'X4', digits: string): void => {
    if (runKind !== kind) flush();
    runKind = kind;
    run += digits;
  };
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (mode === 'utf16-run' ? code > 126 : !isPrintable(code)) {
      if (mode === 'utf16-run') for (let i = 0; i < char.length; i++) escape('X2', hex(char.charCodeAt(i), 4));
      else escape(code > 0xffff ? 'X4' : 'X2', hex(code, code > 0xffff ? 8 : 4));
      continue;
    }
    flush();
    out += char === "'" ? "''" : char === '\\' ? '\\\\' : char;
  }
  flush();
  return out;
}

/** A quoted Part 21 string literal (`encodeStepString` between single quotes). */
export function quoteStepString(text: string): string {
  return `'${encodeStepString(text)}'`;
}

/**
 * A Part 21 REAL (`5.`, `0.25`, `1.E-7`).
 * @param nonFinite what a NaN / infinite value does: 'throw' ⇒ RangeError (a REAL cannot hold it), 'zero' ⇒ written as `0.`
 */
export function stepReal(value: number, nonFinite: 'throw' | 'zero' = 'throw'): string {
  if (!Number.isFinite(value) && nonFinite === 'throw') throw new RangeError(`a Part 21 REAL must be finite, got ${value}`);
  const text = String(Number.isFinite(value) ? value + 0 : 0);
  const [mantissa = '', exponent] = text.split(/e/i);
  const withPoint = mantissa.includes('.') ? mantissa : `${mantissa}.`;
  return exponent === undefined ? withPoint : `${withPoint}E${exponent.replace('+', '')}`;
}

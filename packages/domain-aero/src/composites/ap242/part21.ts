/** Part 21 value formatting and decoding for the composite records: reals, strings with the '' and \\ escapes and the \X2\ / \X4\ encodings of non-ASCII characters. */

import { unescapeStep } from '@lib/step21/decode';

/** A Part 21 REAL (`5.`, `0.25`, `1.E-7`). Throws RangeError for a non-finite number (a REAL cannot hold it): callers that write user data guard it. */
export function real(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError(`a Part 21 REAL must be finite, got ${value}`);
  const text = String(value + 0);
  const [mantissa = '', exponent] = text.split(/e/i);
  const withPoint = mantissa.includes('.') ? mantissa : `${mantissa}.`;
  return exponent === undefined ? withPoint : `${withPoint}E${exponent.replace('+', '')}`;
}

/** A quoted Part 21 string: quote and backslash doubled, characters outside printable ASCII as \X2\ (BMP) or \X4\ (beyond it) code points. */
export function quoted(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "'") out += "''";
    else if (char === '\\') out += '\\\\';
    else if (code > 0xffff) out += `\\X4\\${code.toString(16).toUpperCase().padStart(8, '0')}\\X0\\`;
    else if (code > 126 || code < 32) out += `\\X2\\${code.toString(16).toUpperCase().padStart(4, '0')}\\X0\\`;
    else out += char;
  }
  return `'${out}'`;
}

/** The text of a string literal body as `stringsOf` returns it (quotes already undone): every Part 21 escape decoded, left to right. */
export const unquoted = unescapeStep;

/** `text` with every character beyond ASCII written as a `\X2\` / `\X4\` escape (valid inside Part 21 strings, the only place such characters occur); ASCII text is returned as it is. */
export function asciiOnly(text: string): string {
  if (!/[^\t\n\r -~]/.test(text)) return text;
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0x7e)) out += char;
    else if (code > 0xffff) out += `\\X4\\${code.toString(16).toUpperCase().padStart(8, '0')}\\X0\\`;
    else out += `\\X2\\${code.toString(16).toUpperCase().padStart(4, '0')}\\X0\\`;
  }
  return out;
}

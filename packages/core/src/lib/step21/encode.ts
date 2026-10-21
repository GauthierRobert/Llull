/**
 * Encoding of ISO 10303-21 string and REAL values (the inverse of `decode.ts` for strings).
 * @invariant pure; strings never contain a bare quote, backslash or non-ASCII character
 */

const hex = (value: number, width: number): string => value.toString(16).toUpperCase().padStart(width, '0');

/**
 * The body of a Part 21 string (no surrounding quotes): `'` and `\` doubled; control characters and characters beyond printable ASCII as
 * `\X2\hhhh\X0\` (BMP) or `\X4\hhhhhhhh\X0\` (beyond it), one escape per character.
 * @param groupedUtf16 true ⇒ a run of non-ASCII characters is ONE `\X2\` escape of UTF-16 units (no `\X4\`), and control characters are left as they are
 */
export function encodeStepString(text: string, groupedUtf16 = false): string {
  let out = '';
  if (!groupedUtf16) {
    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;
      if (char === "'") out += "''";
      else if (char === '\\') out += '\\\\';
      else if (code > 0xffff) out += `\\X4\\${hex(code, 8)}\\X0\\`;
      else if (code > 126 || code < 32) out += `\\X2\\${hex(code, 4)}\\X0\\`;
      else out += char;
    }
    return out;
  }
  let wide = '';
  const flush = (): void => {
    if (wide !== '') out += `\\X2\\${wide}\\X0\\`;
    wide = '';
  };
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) > 126) {
      for (let i = 0; i < char.length; i++) wide += hex(char.charCodeAt(i), 4);
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

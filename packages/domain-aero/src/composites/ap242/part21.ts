/** Part 21 value formatting and decoding for the composite records: reals, strings with the '' and \\ escapes and \X2\ for non-ASCII characters. */

/** A Part 21 REAL (`5.`, `0.25`, `1.E-7`). */
export function real(value: number): string {
  if (!Number.isFinite(value)) return '0.';
  const text = String(value + 0);
  const [mantissa = '', exponent] = text.split(/e/i);
  const withPoint = mantissa.includes('.') ? mantissa : `${mantissa}.`;
  return exponent === undefined ? withPoint : `${withPoint}E${exponent.replace('+', '')}`;
}

/** A quoted Part 21 string: quote and backslash doubled, characters outside printable ASCII as \X2\ UTF-16 units. */
export function quoted(text: string): string {
  let out = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? '';
    const code = text.charCodeAt(index);
    if (char === "'") out += "''";
    else if (char === '\\') out += '\\\\';
    else if (code > 126 || code < 32) out += `\\X2\\${code.toString(16).toUpperCase().padStart(4, '0')}\\X0\\`;
    else out += char;
  }
  return `'${out}'`;
}

/** The text of a string literal body as `stringsOf` returns it (quotes already undone): \X2\ units and doubled backslashes decoded. */
export function unquoted(raw: string): string {
  return raw
    .replace(/\\X2\\((?:[0-9A-Fa-f]{4})+)\\X0\\/g, (_match, hex: string) =>
      (hex.match(/.{4}/g) ?? []).map((unit) => String.fromCharCode(parseInt(unit, 16))).join(''),
    )
    .replace(/\\\\/g, '\\');
}

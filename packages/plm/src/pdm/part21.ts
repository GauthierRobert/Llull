/** Part 21 value formatting for the PDM records: strings with the '' and \\ escapes and \X2\ / \X4\ for non-ASCII, finite REALs, ISO dates. */

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

/** `$` for an absent value, else the quoted string. */
export const optional = (text: string | undefined): string => (text === undefined ? '$' : quoted(text));

/** A Part 21 REAL (`5.`, `0.25`, `1.E-7`); a non-finite number is written as 0. (callers pass finite values). */
export function real(value: number): string {
  const text = String(Number.isFinite(value) ? value + 0 : 0);
  const [mantissa = '', exponent] = text.split(/e/i);
  const withPoint = mantissa.includes('.') ? mantissa : `${mantissa}.`;
  return exponent === undefined ? withPoint : `${withPoint}E${exponent.replace('+', '')}`;
}

export interface Instant {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z)?$/;

/** The calendar fields of an ISO date (`2026-11-02`) or UTC instant (`2026-11-02T09:00:00Z`, fractions of a second dropped); null when it is not one. */
export function parseInstant(iso: string): Instant | null {
  const match = ISO.exec(iso);
  if (match === null) return null;
  const [year, month, day, hour, minute, second] = [match[1], match[2], match[3], match[4] ?? '0', match[5] ?? '0', match[6] ?? '0'].map(
    Number,
  ) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  return { year, month, day, hour, minute, second };
}

const two = (n: number): string => String(n).padStart(2, '0');

/** The canonical ISO text of an instant: a date alone (`dateOnly`) or the UTC time to the second. */
export function isoOf(at: Instant, dateOnly: boolean): string {
  const date = `${String(at.year).padStart(4, '0')}-${two(at.month)}-${two(at.day)}`;
  return dateOnly ? date : `${date}T${two(at.hour)}:${two(at.minute)}:${two(at.second)}Z`;
}

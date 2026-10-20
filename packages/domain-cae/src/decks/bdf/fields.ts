/** Nastran small-field fixed format (8-character fields, 8 data fields per line): number formatting and card layout. */

/** Width of one field. */
const WIDTH = 8;
/** Data fields on the first line of a card and on each continuation line. */
const PER_LINE = 8;

/**
 * Real number in at most 8 characters, Nastran-legal (`.5`, `123.4568`, `7.85E-9`, `1.E10`): the largest precision whose text fits, fixed notation
 * for exponents -3..7, else `mantissaEexponent`, or the exponent without its E (`7.85-9`) when that keeps a digit. Rounds to fit, so a value with more than 7 significant digits loses its tail (see `roundingError`).
 * @failure non-finite -> null
 */
export function realField(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  if (value === 0) return '0.';
  for (let precision = 8; precision >= 1; precision--) {
    const rounded = Number(value.toPrecision(precision));
    const exponent = Math.floor(Math.log10(Math.abs(rounded)));
    if (exponent >= -3 && exponent <= 7) {
      let fixed = rounded.toFixed(Math.min(20, Math.max(0, precision - 1 - exponent)));
      fixed = fixed.includes('.') ? fixed.replace(/0+$/, '') : `${fixed}.`;
      fixed = fixed.replace(/^(-?)0\./, '$1.');
      if (fixed.length <= WIDTH) return fixed;
    }
    const [mantissa = '', power = '0'] = rounded.toExponential(precision - 1).split('e');
    const trimmed = mantissa.includes('.') ? mantissa.replace(/0+$/, '') : `${mantissa}.`;
    const text = `${trimmed}E${Number(power)}`;
    if (text.length <= WIDTH) return text;
    const compact = `${trimmed}${Number(power) < 0 ? '-' : '+'}${Math.abs(Number(power))}`;
    if (compact.length <= WIDTH) return compact;
  }
  return null;
}

/** Relative difference between a value and what the field text parses back to (0 for 0). */
export function roundingError(value: number, text: string): number {
  const compact = /^([+-]?[\d.]+)([+-]\d+)$/.exec(text);
  const parsed = compact === null ? Number(text) : Number(`${compact[1]}E${compact[2]}`);
  return value === 0 ? 0 : Math.abs(parsed - value) / Math.abs(value);
}

/** Integer field; null when it does not fit 8 characters. */
export function intField(value: number): string | null {
  const text = String(Math.trunc(value));
  return Number.isInteger(value) && text.length <= WIDTH ? text : null;
}

/**
 * Lines of one card: the name and up to 8 fields on the first line, 8 fields on each continuation line (first field blank, the automatic
 * continuation every Nastran accepts). Trailing blank fields are dropped; lines carry no trailing spaces.
 * @invariant every field is at most 8 characters (callers format numbers with `realField` / `intField`)
 */
export function cardLines(name: string, fields: readonly string[]): string[] {
  const used = [...fields];
  while (used.length > 0 && used.at(-1) === '') used.pop();
  const pad = (values: readonly string[]): string => values.map((value) => value.padEnd(WIDTH)).join('');
  const lines = [`${name.padEnd(WIDTH)}${pad(used.slice(0, PER_LINE))}`.trimEnd()];
  for (let at = PER_LINE; at < used.length; at += PER_LINE)
    lines.push(`${' '.repeat(WIDTH)}${pad(used.slice(at, at + PER_LINE))}`.trimEnd());
  return lines;
}

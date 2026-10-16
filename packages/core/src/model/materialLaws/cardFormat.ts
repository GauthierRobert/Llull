/** Number formatting of the solver cards (PHY-02 §6.3): shortest round-trip decimal, integral values with a trailing `.` in CalculiX. */

/** CalculiX / free-format real: `72000.`, `0.33`, `1e-10`, `-2.` (float noise beyond 15 significant digits is cleaned). */
export function calculixNumber(value: number): string {
  const cleaned = Number(value.toPrecision(15));
  const text = String(cleaned === 0 ? 0 : cleaned);
  return /^-?\d+$/.test(text) ? `${text}.` : text;
}

/** Nastran small-field real (8 characters, left-justified); null when it does not fit. */
export function nastranReal(value: number): string | null {
  const text = calculixNumber(value);
  return text.length <= 8 ? text : null;
}

/** Fixed-width small-field text. */
export const field = (text: string): string => text.padEnd(8);

/** Values joined with commas in lines of at most 8 data per CalculiX line. */
export function calculixLines(values: readonly string[], perLine = 8): string[] {
  const lines: string[] = [];
  for (let i = 0; i < values.length; i += perLine) lines.push(values.slice(i, i + perLine).join(','));
  return lines;
}

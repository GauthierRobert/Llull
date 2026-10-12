/**
 * @layer ui
 * @pure Form text -> command params: numbers and optional strings (param gathering only; the
 * commands validate).
 */

/** A finite number, or undefined for blank / invalid text. */
export function parseNumber(text: string): number | undefined {
  if (text.trim() === '') return undefined;
  const value = Number(text.trim());
  return Number.isFinite(value) ? value : undefined;
}

/** `{ [key]: number }` when `text` is a number, `{}` when blank or invalid. */
export function optionalNumber<K extends string>(key: K, text: string): Partial<Record<K, number>> {
  const value = parseNumber(text);
  return value === undefined ? {} : ({ [key]: value } as Record<K, number>);
}

/** `{ [key]: trimmed text }` when `text` is not blank, `{}` otherwise. */
export function optionalText<K extends string>(key: K, text: string): Partial<Record<K, string>> {
  const value = text.trim();
  return value === '' ? {} : ({ [key]: value } as Record<K, string>);
}

/** Numeric fields of one "a, b, c" (or space separated) row; null when one is not a number. */
export function parseNumberRow(row: string): number[] | null {
  const values = row
    .split(/[,\s]+/)
    .filter((field) => field !== '')
    .map(Number);
  return values.every(Number.isFinite) ? values : null;
}

/** "10, 20, 0" (`,` `;` or space separated) -> [10, 20, 0]; [] when blank, null when a value is not a number. */
export function parseNumberList(text: string): number[] | null {
  return text.trim() === '' ? [] : parseNumberRow(text.replace(/;/g, ','));
}

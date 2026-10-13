/**
 * @layer ui/panels
 * @pure "Send only the changed fields" param gathering for the edit forms: each helper returns an
 * object to spread into the command params (`{}` when the field is unchanged or unusable).
 */

import { parseNumber } from '@ui/numberText';

/** `{ [key]: number }` when `text` is a number (blank / invalid -> none) that differs from `original`. */
export function changedNumber(key: string, text: string, original: number): Record<string, number> {
  const value = parseNumber(text);
  return text !== String(original) && value !== undefined ? { [key]: value } : {};
}

/** `{ [key]: trimmed text }` when `text` is not blank and differs from `original`. */
export function changedText(key: string, text: string, original: string): Record<string, string> {
  const value = text.trim();
  return value !== '' && value !== original ? { [key]: value } : {};
}

/** The `keys` whose text differs between `initial` and `values`, with the edited text as typed. */
export function changedFields<K extends string>(
  initial: Readonly<Record<K, string>>,
  values: Readonly<Record<K, string>>,
  keys: ReadonlyArray<K>,
): Partial<Record<K, string>> {
  const changes: Partial<Record<K, string>> = {};
  for (const key of keys) if (values[key] !== initial[key]) changes[key] = values[key];
  return changes;
}

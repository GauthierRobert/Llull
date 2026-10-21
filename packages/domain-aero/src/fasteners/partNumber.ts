/** Part-number grammar: decode a part number into its fields and format fields back into a part number. */

import type { PartNumberField } from '@aero/fasteners/types';

export type FieldValues = Readonly<Record<string, string | number>>;

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function fieldPattern(field: PartNumberField): string {
  switch (field.kind) {
    case 'literal':
      return escapeRegex(field.text);
    case 'code':
      return `(${Object.keys(field.table)
        .sort((a, b) => b.length - a.length)
        .map(escapeRegex)
        .join('|')})`;
    case 'int': {
      const digits = field.width === undefined ? '\\d+' : `\\d{${field.width}}`;
      return field.optional === true ? `(${digits})?` : `(${digits})`;
    }
  }
}

const caseInsensitiveKey = (table: Readonly<Record<string, string>>, text: string): string | undefined =>
  Object.keys(table).find((key) => key.toLowerCase() === text.toLowerCase());

/**
 * Field values of `text` under the grammar `fields`, or null when it does not match.
 * @invariant code values are the table's own keys; int values are numbers
 */
export function decodeWithGrammar(fields: readonly PartNumberField[], text: string): FieldValues | null {
  const match = new RegExp(`^${fields.map(fieldPattern).join('')}$`, 'i').exec(text.trim());
  if (match === null) return null;
  const values: Record<string, string | number> = {};
  let group = 1;
  for (const field of fields) {
    if (field.kind === 'literal') continue;
    const captured = match[group++];
    if (captured === undefined) continue;
    values[field.name] = field.kind === 'code' ? (caseInsensitiveKey(field.table, captured) ?? captured) : Number(captured);
  }
  return values;
}

/** The part number of `values` under `fields`; a missing code takes the table's first key. Null when a required int is missing. */
export function formatWithGrammar(fields: readonly PartNumberField[], values: FieldValues): string | null {
  let text = '';
  for (const field of fields) {
    if (field.kind === 'literal') text += field.text;
    else if (field.kind === 'code') text += String(values[field.name] ?? Object.keys(field.table)[0] ?? '');
    else {
      const value = values[field.name];
      if (typeof value !== 'number') {
        if (field.optional === true) continue;
        return null;
      }
      text += field.width === undefined ? String(value) : String(value).padStart(field.width, '0');
    }
  }
  return text;
}

/** Names of the code fields a caller did not choose although the table offers several (the first key is used and named as a default). */
export function defaultedCodes(fields: readonly PartNumberField[], values: FieldValues): string[] {
  return fields.flatMap((field) =>
    field.kind === 'code' && values[field.name] === undefined && Object.keys(field.table).length > 1 ? [field.name] : [],
  );
}

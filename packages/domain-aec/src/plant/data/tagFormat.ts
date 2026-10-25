/**
 * Tag formats (plant 08 DAT §5.2, TR-DAT-06). Grammar: `format := part+`, `part := literal | field`, `field := '{' name (':' width)? '}'`,
 * `name := classCode | hierarchy.<kind>.<property> | identifier`; `{{` and `}}` write braces; `width` zero-pads an integer.
 * @invariant generate and the matcher use the same parts, so a generated tag always matches its own matcher
 */

import { HIERARCHY_KINDS, type HierarchyKind, type PlantValue } from './model';
import { IDENTIFIER } from './properties';

export interface LiteralPart {
  readonly kind: 'literal';
  readonly text: string;
}
export interface FieldPart {
  readonly kind: 'field';
  readonly name: string;
  readonly width?: number;
}
export type TagPart = LiteralPart | FieldPart;

export type ParsedFormat = { readonly ok: true; readonly parts: readonly TagPart[] } | { readonly ok: false; readonly problem: string };

const HIERARCHY_FIELD = new RegExp(`^hierarchy\\.(${HIERARCHY_KINDS.join('|')})\\.([A-Za-z][A-Za-z0-9_]*)$`);

/** `hierarchy.<kind>.<property>` split, or null. */
export function hierarchyField(name: string): { readonly kind: HierarchyKind; readonly property: string } | null {
  const match = HIERARCHY_FIELD.exec(name);
  return match === null ? null : { kind: match[1] as HierarchyKind, property: match[2] as string };
}

const MAX_WIDTH = 12;

export function parseTagFormat(format: string): ParsedFormat {
  if (format.trim() === '') return { ok: false, problem: 'the format is empty' };
  if (format.length > 200) return { ok: false, problem: 'the format is longer than 200 characters' };
  const parts: TagPart[] = [];
  let text = '';
  const flush = (): void => {
    if (text !== '') parts.push({ kind: 'literal', text });
    text = '';
  };
  for (let index = 0; index < format.length; index += 1) {
    const ch = format[index] as string;
    const next = format[index + 1];
    if (ch === '{' && next === '{') {
      text += '{';
      index += 1;
    } else if (ch === '}' && next === '}') {
      text += '}';
      index += 1;
    } else if (ch === '}') return { ok: false, problem: `stray "}" at ${index} (write }} for a brace)` };
    else if (ch === '{') {
      const end = format.indexOf('}', index);
      if (end < 0) return { ok: false, problem: `unclosed "{" at ${index}` };
      const body = format.slice(index + 1, end);
      const [name = '', width, ...rest] = body.split(':');
      const known = name === 'classCode' || hierarchyField(name) !== null || IDENTIFIER.test(name);
      if (!known || rest.length > 0)
        return {
          ok: false,
          problem: `unknown field "{${body}}" (classCode, hierarchy.<site|plant|area|unit|system>.<property>, or an identifier)`,
        };
      if (width !== undefined && !(/^[1-9][0-9]*$/.test(width) && Number(width) <= MAX_WIDTH))
        return { ok: false, problem: `width of {${body}} must be an integer from 1 to ${MAX_WIDTH}` };
      flush();
      parts.push({ kind: 'field', name, ...(width === undefined ? {} : { width: Number(width) }) });
      index = end;
    } else text += ch;
  }
  flush();
  for (const [index, part] of parts.entries()) {
    const following = parts[index + 1];
    if (part.kind === 'field' && part.width === undefined && following?.kind === 'field' && following.width === undefined)
      return {
        ok: false,
        problem: `{${part.name}}{${following.name}} are adjacent: separate them with a literal, or pad one with {name:width}`,
      };
  }
  if (!parts.some((part) => part.kind === 'field')) return { ok: false, problem: 'the format has no {field}: every tag would be the same' };
  return { ok: true, parts };
}

/** Names of the fields of a format, in order, without repeats. */
export const fieldNames = (parts: readonly TagPart[]): string[] => [
  ...new Set(parts.flatMap((part) => (part.kind === 'field' ? [part.name] : []))),
];

/** The field that counts objects: `seq`, else the last zero-padded field. */
export function sequenceField(parts: readonly TagPart[]): FieldPart | undefined {
  const fields = parts.filter((part): part is FieldPart => part.kind === 'field');
  return fields.find((part) => part.name === 'seq') ?? [...fields].reverse().find((part) => part.width !== undefined);
}

export const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/** Value of a field as text, zero-padded when the part has a width; null when the value cannot fill the field. */
export function renderField(part: FieldPart, value: PlantValue): string | null {
  if (value === null || value === '') return null;
  if (part.width === undefined) return String(value);
  let digits: string | null = null;
  if (typeof value === 'number') digits = Number.isInteger(value) && value >= 0 ? String(value) : null;
  else if (/^\d+$/.test(String(value))) digits = String(value);
  if (digits === null || digits.length > part.width) return null;
  return digits.padStart(part.width, '0');
}

export type Generated =
  | { readonly ok: true; readonly tag: string }
  | { readonly ok: false; readonly code: 'DAT_TAG_FIELD_MISSING' | 'DAT_TAG_FORMAT'; readonly message: string; readonly field: string };

/** The tag of `parts` with the values `valueOf` gives; the first field without a value (or with one that cannot be rendered) is the failure. */
export function generateTag(parts: readonly TagPart[], valueOf: (name: string) => PlantValue | undefined): Generated {
  let tag = '';
  for (const part of parts) {
    if (part.kind === 'literal') {
      tag += part.text;
      continue;
    }
    const value = valueOf(part.name);
    if (value === undefined || value === null || value === '')
      return { ok: false, code: 'DAT_TAG_FIELD_MISSING', message: `the tag field {${part.name}} has no value`, field: part.name };
    const text = renderField(part, value);
    if (text === null)
      return {
        ok: false,
        code: 'DAT_TAG_FORMAT',
        message: `${JSON.stringify(value)} does not fit {${part.name}:${part.width}} (a non-negative integer of at most ${part.width} digits)`,
        field: part.name,
      };
    tag += text;
  }
  return { ok: true, tag };
}

export interface TagMatcher {
  readonly regex: RegExp;
  /** Field name of each capture group, in order (a field that occurs twice captures twice). */
  readonly groups: readonly string[];
}

/** Anchored matcher of a format; `sourceOf` gives the regular expression of one field (without a group) and the literal that follows it, if any. */
export function buildMatcher(
  parts: readonly TagPart[],
  sourceOf: (part: FieldPart, nextLiteral: string | undefined) => string,
): TagMatcher {
  const groups: string[] = [];
  const source = parts
    .map((part, index) => {
      if (part.kind === 'literal') return escapeRegex(part.text);
      const following = parts[index + 1];
      groups.push(part.name);
      return `(${sourceOf(part, following?.kind === 'literal' ? following.text : undefined)})`;
    })
    .join('');
  return { regex: new RegExp(`^${source}$`), groups };
}

/** Field values captured by `matcher` in `tag`, or null when the tag does not match. A repeated field must repeat the same text. */
export function captureFields(matcher: TagMatcher, tag: string): Record<string, string> | null {
  const match = matcher.regex.exec(tag);
  if (match === null) return null;
  const fields: Record<string, string> = {};
  for (const [index, name] of matcher.groups.entries()) {
    const text = match[index + 1] as string;
    if (fields[name] !== undefined && fields[name] !== text) return null;
    fields[name] = text;
  }
  return fields;
}

/** Tags compare after Unicode NFC normalisation and trimming, case-sensitively (§5.2). */
export const normaliseTag = (tag: string): string => tag.normalize('NFC').trim();

/**
 * @layer ui/components/commandPalette
 * @pure
 *
 * Generic param-gathering for ANY registry command: its `paramsSchema` becomes a list of form
 * fields; the string values typed into them become the params object passed to `dispatch`.
 * Validation of meaning stays in the command (`execute` + `run`); this only parses input shapes.
 */

import type { ParamSpec, ParamsSchema } from '@core/commands/types';
import type { EntityId } from '@core/model/types';

type FieldKind = 'number' | 'text' | 'enum' | 'boolean' | 'numberList' | 'textList' | 'json';

export interface FormField {
  name: string;
  kind: FieldKind;
  /** Human label derived from the param name (`entityId` -> "Entity id"). */
  label: string;
  description: string;
  required: boolean;
  /** Allowed values for `kind: 'enum'`. */
  options: readonly string[];
}

/** Raw text per field name, as typed by the user. Empty string = not provided. */
export type FormValues = Readonly<Record<string, string>>;

type ParseResult =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; errors: Readonly<Record<string, string>> };

/** `add_box` -> "Add box"; `entityId` -> "Entity id". */
export function humanizeName(name: string): string {
  const spaced = name
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function fieldKind(spec: ParamSpec): FieldKind {
  if (spec.enum !== undefined && spec.enum.length > 0) return 'enum';
  if (spec.type === 'number') return 'number';
  if (spec.type === 'string') return 'text';
  if (spec.type === 'boolean') return 'boolean';
  if (spec.type === 'array' && spec.items?.type === 'number') return 'numberList';
  if (spec.type === 'array' && spec.items?.type === 'string' && spec.items.enum === undefined) {
    return 'textList';
  }
  return 'json';
}

/** One form field per schema property, required ones first (stable within each group). */
export function fieldsFromSchema(schema: ParamsSchema): FormField[] {
  const required = new Set(schema.required);
  const fields = Object.entries(schema.properties).map(
    ([name, spec]): FormField => ({
      name,
      kind: fieldKind(spec),
      label: humanizeName(name),
      description: spec.description,
      required: required.has(name),
      options: (spec.enum ?? []).map(String),
    }),
  );
  return [...fields.filter((f) => f.required), ...fields.filter((f) => !f.required)];
}

const SINGLE_ID_FIELD = /^(id|entityId|targetId|sourceId|movingId|baseId|referenceId)$/;
const NUMBERED_ID_FIELD = /^(?:entity|line)Id([12])$/;
const MULTI_ID_FIELD = /^(ids|entityIds|targetIds|elementIds)$/;

/** The selected id a single-id field defaults to, if any. */
function selectedIdFor(name: string, selection: readonly EntityId[]): EntityId | undefined {
  if (SINGLE_ID_FIELD.test(name)) return selection[0];
  const numbered = NUMBERED_ID_FIELD.exec(name);
  return numbered === null ? undefined : selection[Number(numbered[1]) - 1];
}

/**
 * Pre-fill entity-id fields from the current selection so "select, then run" just works; required
 * enums / booleans start on the value their select shows (first option / `true`).
 */
export function initialValues(
  fields: readonly FormField[],
  selection: readonly EntityId[],
): FormValues {
  const values: Record<string, string> = {};
  for (const field of fields) {
    const selectedId = field.kind === 'text' ? selectedIdFor(field.name, selection) : undefined;
    if (selectedId !== undefined) {
      values[field.name] = selectedId;
    } else if (field.kind === 'textList' && MULTI_ID_FIELD.test(field.name)) {
      values[field.name] = selection.join(', ');
    } else if (field.kind === 'enum' && field.required) {
      values[field.name] = field.options[0] ?? '';
    } else if (field.kind === 'boolean' && field.required) {
      values[field.name] = 'true';
    } else {
      values[field.name] = '';
    }
  }
  return values;
}

/**
 * Option picked by typing into a select: an exact (case-insensitive) match wins over the first
 * prefix match, so "m" selects "m" rather than "mm". @pure
 */
export function matchTypeahead(options: readonly string[], query: string): string | undefined {
  const needle = query.toLowerCase();
  if (needle === '') return undefined;
  return (
    options.find((option) => option.toLowerCase() === needle) ??
    options.find((option) => option.toLowerCase().startsWith(needle))
  );
}

/** Text for one existing param value, the inverse of `parseField`; unusable values become blank. */
function formatParam(field: FormField, value: unknown): string {
  switch (field.kind) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
    case 'boolean':
      return typeof value === 'boolean' ? String(value) : '';
    case 'numberList':
    case 'textList':
      return Array.isArray(value) ? value.map(String).join(', ') : '';
    case 'json':
      return value === undefined ? '' : JSON.stringify(value);
    case 'enum':
    case 'text':
      return typeof value === 'string' ? value : '';
  }
}

/** Pre-fill the form from an existing params object (editing a recorded step). @pure */
export function valuesFromParams(
  fields: readonly FormField[],
  params: Readonly<Record<string, unknown>>,
): FormValues {
  return Object.fromEntries(
    fields.map((field) => [field.name, formatParam(field, params[field.name])]),
  );
}

function splitList(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Parse one non-empty raw value; a string result is an error message. */
function parseField(field: FormField, raw: string): { value: unknown } | string {
  switch (field.kind) {
    case 'number': {
      const value = Number(raw);
      return Number.isFinite(value) ? { value } : 'Enter a number.';
    }
    case 'boolean':
      return { value: raw === 'true' };
    case 'numberList': {
      const values = splitList(raw).map(Number);
      return values.every(Number.isFinite) ? { value: values } : 'Enter numbers, e.g. 0, 0, 10.';
    }
    case 'textList':
      return { value: splitList(raw) };
    case 'json':
      try {
        return { value: JSON.parse(raw) as unknown };
      } catch {
        return 'Enter valid JSON.';
      }
    case 'enum':
    case 'text':
      return { value: raw };
  }
}

/**
 * Turn form text into a params object. Blank optional fields are omitted (the command default
 * applies); blank required fields and unparseable values are reported per field.
 */
export function parseFormValues(fields: readonly FormField[], values: FormValues): ParseResult {
  const params: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const raw = (values[field.name] ?? '').trim();
    if (raw === '') {
      if (field.required) errors[field.name] = 'Required.';
      continue;
    }
    const parsed = parseField(field, raw);
    if (typeof parsed === 'string') errors[field.name] = parsed;
    else params[field.name] = parsed.value;
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, params };
}

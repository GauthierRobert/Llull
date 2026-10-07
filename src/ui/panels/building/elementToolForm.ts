/**
 * @layer ui/panels/building
 *
 * Form-spec types and field-reading helpers shared by the element and industrial tool
 * specs (param-gathering only, react R1).
 */

type FieldKind = 'number' | 'text' | 'select' | 'checkbox';

/** Live element lists a select field can offer. */
export type ElementListKind = 'walls' | 'hosts' | 'stairs' | 'slabs' | 'levels' | 'pipes';

export interface ToolField {
  readonly key: string;
  readonly label: string;
  readonly kind: FieldKind;
  readonly defaultValue: string;
  /** For 'select': [value, label] pairs, or a live list (active level's walls / stairs, all slabs). */
  readonly options?: ReadonlyArray<readonly [string, string]> | ElementListKind;
  /** For live-list selects: text of the blank first option (default depends on the list). */
  readonly blankLabel?: string;
  /** Optional numeric fields may be left blank → the command default applies. */
  readonly optional?: boolean;
  /** Shown only while the form field `key` holds one of `values` (e.g. joints for beams). */
  readonly showWhen?: { readonly key: string; readonly values: ReadonlyArray<string> };
}

/** Plan bounds [x1, y1, x2, y2] of the building's grid lines. */
export type PlanExtent = readonly [number, number, number, number];

interface ToolContext {
  readonly levelId: string | null;
  readonly wallIds: ReadonlyArray<string>;
  /** Extent of the structural grid, null when there is none. */
  readonly gridExtent?: PlanExtent | null;
}

type ToolCommand =
  | { readonly ok: true; readonly command: string; readonly params: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string };

export interface ElementTool {
  readonly id: string;
  readonly label: string;
  /** Picker group heading. Default "Building". */
  readonly group?: string;
  readonly fields: ReadonlyArray<ToolField>;
  readonly build: (values: Readonly<Record<string, string>>, context: ToolContext) => ToolCommand;
}

export function num(key: string, label: string, defaultValue = '', optional = false): ToolField {
  return { key, label, kind: 'number', defaultValue, optional };
}

export function txt(key: string, label: string, defaultValue = '', optional = false): ToolField {
  return { key, label, kind: 'text', defaultValue, optional };
}

export function select(
  key: string,
  label: string,
  defaultValue: string,
  options: NonNullable<ToolField['options']>,
): ToolField {
  return { key, label, kind: 'select', defaultValue, options };
}

export function checkbox(key: string, label: string, checked: boolean): ToolField {
  return { key, label, kind: 'checkbox', defaultValue: String(checked) };
}

/** Level selector: blank = the active level, else a level id (relative z / placement is on it). */
export function levelField(): ToolField {
  return select('levelId', 'Level', '', 'levels');
}

/** Select field with a blank "Default" first option: blank = omit the param, the command default applies. */
export function defaultedSelect(
  key: string,
  label: string,
  blankLabel: string,
  options: ReadonlyArray<readonly [string, string]>,
  showWhen?: ToolField['showWhen'],
): ToolField {
  return {
    ...select(key, label, '', [['', blankLabel], ...options]),
    ...(showWhen !== undefined ? { showWhen } : {}),
  };
}

/** Picker group of the steel hall / plant tools. */
export const INDUSTRIAL_TOOL_GROUP = 'Industrial / steel';

export function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function isFieldShown(field: ToolField, values: Readonly<Record<string, string>>): boolean {
  return (
    field.showWhen === undefined || field.showWhen.values.includes(values[field.showWhen.key] ?? '')
  );
}

export class FieldReader {
  readonly missing: string[] = [];

  constructor(private readonly values: Readonly<Record<string, string>>) {}

  /** Two numeric fields as an `[x, y]` point. */
  point(xKey: string, yKey: string): [number, number] {
    return [this.number(xKey), this.number(yKey)];
  }

  number(key: string): number {
    const value = Number(this.values[key]);
    if (this.values[key]?.trim() === '' || !Number.isFinite(value)) this.missing.push(key);
    return value;
  }

  optionalNumber(key: string): number | undefined {
    const raw = this.values[key]?.trim() ?? '';
    if (raw === '') return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value)) this.missing.push(key);
    return value;
  }

  text(key: string): string {
    return this.values[key]?.trim() ?? '';
  }

  flag(key: string): boolean {
    return this.values[key] === 'true';
  }

  numberList(key: string): number[] {
    const parts = this.text(key)
      .split(/[,;\s]+/)
      .filter((part) => part !== '')
      .map(Number);
    if (parts.length === 0 || parts.some((part) => !Number.isFinite(part))) this.missing.push(key);
    return parts;
  }

  /** "x,y,z; x,y,z; …" → [[x, y, z], …] (at least `minimum` points). */
  pointList(key: string, minimum: number): Array<[number, number, number]> {
    const points = this.text(key)
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .map((part) => part.split(/[,\s]+/).map(Number));
    if (
      points.length < minimum ||
      points.some((point) => point.length !== 3 || point.some((value) => !Number.isFinite(value)))
    ) {
      this.missing.push(key);
    }
    return points.map((point) => [point[0] ?? 0, point[1] ?? 0, point[2] ?? 0]);
  }
}

export function result(
  reader: FieldReader,
  command: string,
  params: Record<string, unknown>,
): ToolCommand {
  if (reader.missing.length > 0)
    return { ok: false, reason: `Check: ${reader.missing.join(', ')}` };
  const cleaned = Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined),
  );
  return { ok: true, command, params: cleaned };
}

/** Comma / semicolon separated text → trimmed non-empty items; blank → undefined. */
export function textList(reader: FieldReader, key: string): string[] | undefined {
  const items = reader
    .text(key)
    .split(/[,;]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return items.length === 0 ? undefined : items;
}

export function onLevel(context: ToolContext): Record<string, unknown> {
  return context.levelId === null ? {} : { levelId: context.levelId };
}

/** `levelId` of the form's Level selector, else the active level. */
export function placement(reader: FieldReader, context: ToolContext): Record<string, unknown> {
  const chosen = reader.text('levelId');
  return chosen === '' ? onLevel(context) : { levelId: chosen };
}

export function defaultValues(tool: ElementTool): Record<string, string> {
  return Object.fromEntries(tool.fields.map((field) => [field.key, field.defaultValue]));
}

/**
 * Spec sheet (+ branch sheet) -> spec file object (plant 01 PSC M5): the CSV written by `export_pipe_spec format csv`, with the header of the spec
 * given by the caller (the sheet carries components only). The result is the `llull-pipe-spec` file object that `parseSpecFile` validates, so every
 * rule of the JSON import applies. The `verified` column is an output of the export (it reflects the catalogue) and is ignored here.
 * @invariant pure, never throws; a problem names the sheet row (and column); extra keys are collected in Maps, so a hostile key never reaches a prototype
 */

import { COMPONENT_TYPES } from '../catalog/types';
import { cellNumber, isHostileName, type Sheet, type SheetRow } from '../catalog/sheetRead';
import type { SheetProblem } from '../catalog/sheetImport';
import { COMPONENT_KEYS } from './file';

export const SPEC_SHEET_COLUMNS = [
  'component',
  'type',
  'from',
  'to',
  'branchFrom',
  'branchTo',
  'ends',
  'class',
  'pn',
  'facing',
  'radius',
  'schedule',
  'scheduleFromPipe',
  'wallMm',
  'priority',
  'catalogRef',
  'standard',
  'commodityCode',
  'description',
  'material',
  'verified',
  'extra',
] as const;

const NUMBER_COLUMNS = ['class', 'pn', 'wallMm', 'priority'] as const;
const TEXT_COLUMNS = ['ends', 'facing', 'radius', 'schedule', 'standard', 'commodityCode', 'description', 'material'] as const;
const MAX_EXTRA = 64;

/** `"NPS 2"` -> `{ fromNps: "2" }`, `"DN 50"` -> `{ fromDn: "50" }` with the given prefix, or null. */
function sizeFields(cell: string, prefix: 'from' | 'to' | 'branchFrom' | 'branchTo'): Record<string, string> | null {
  const match = /^\s*(NPS|DN)\s+(\S+)\s*$/.exec(cell);
  if (match === null) return null;
  return { [`${prefix}${match[1] === 'NPS' ? 'Nps' : 'Dn'}`]: match[2] as string };
}

/** The scalar `extra` of a row from its JSON cell, or a problem message. */
function extraOf(cell: string): { readonly extra: ReadonlyMap<string, string | number | boolean> } | { readonly message: string } {
  if (cell.trim() === '') return { extra: new Map() };
  let parsed: unknown;
  try {
    parsed = JSON.parse(cell);
  } catch {
    return { message: 'extra is not valid JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    return { message: 'extra must be a JSON object of text, number or true / false values' };
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > MAX_EXTRA) return { message: `extra has more than ${MAX_EXTRA} keys` };
  const extra = new Map<string, string | number | boolean>();
  for (const [key, value] of entries) {
    if (isHostileName(key) || COMPONENT_KEYS.has(key)) return { message: `extra key "${key}" is not allowed (reserved or a spec field)` };
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')
      return { message: `extra.${key} must be text, a number or true / false` };
    extra.set(key, value);
  }
  return { extra };
}

function componentOf(row: SheetRow, problems: SheetProblem[]): Record<string, unknown> {
  const get = (name: string): string => row.cells.get(name) ?? '';
  const bad = (column: string, message: string): void => void problems.push({ row: row.line, column, message });
  const component: Record<string, unknown> = { id: get('component'), type: get('type').trim(), catalogRef: get('catalogRef') };
  if (!(COMPONENT_TYPES as readonly string[]).includes(get('type').trim())) bad('type', `type "${get('type')}" is not a component type`);
  for (const [column, prefix] of [
    ['from', 'from'],
    ['to', 'to'],
    ['branchFrom', 'branchFrom'],
    ['branchTo', 'branchTo'],
  ] as const) {
    const cell = get(column).trim();
    if (cell === '') {
      if (column === 'from' || column === 'to') bad(column, `${column} is empty: write the size as "NPS 2" or "DN 50"`);
      continue;
    }
    const fields = sizeFields(cell, prefix);
    if (fields === null) bad(column, `${column} "${cell}" must read "NPS <size>" or "DN <size>"`);
    else Object.assign(component, fields);
  }
  for (const column of TEXT_COLUMNS) if (get(column) !== '') component[column] = get(column);
  for (const column of NUMBER_COLUMNS) {
    if (get(column).trim() === '') continue;
    const value = cellNumber(get(column));
    if (value === null) bad(column, `${column} "${get(column)}" is not a number`);
    else component[column] = value;
  }
  const flag = get('scheduleFromPipe').trim().toLowerCase();
  if (flag === 'true') component['scheduleFromPipe'] = true;
  else if (flag === 'false') component['scheduleFromPipe'] = false;
  else if (flag !== '') bad('scheduleFromPipe', `scheduleFromPipe "${get('scheduleFromPipe')}" must be true or false`);
  const extra = extraOf(get('extra'));
  if ('message' in extra) bad('extra', extra.message);
  else for (const [key, value] of extra.extra) component[key] = value;
  return component;
}

/** The components of a spec sheet as file components (with the sheet row of each), or every problem found. */
export function componentsFromSheet(
  sheet: Sheet,
):
  | { readonly components: readonly Record<string, unknown>[]; readonly rows: readonly number[] }
  | { readonly problems: readonly SheetProblem[] } {
  const problems: SheetProblem[] = [];
  for (const column of ['component', 'type', 'from', 'to', 'catalogRef'])
    if (!sheet.headers.includes(column))
      problems.push({
        row: 1,
        column,
        message: `the sheet has no "${column}" column (columns: ${sheet.headers.join(', ')}; map yours with columns)`,
      });
  if (problems.length > 0) return { problems };
  const components = sheet.rows.map((row) => componentOf(row, problems));
  return problems.length > 0 ? { problems } : { components, rows: sheet.rows.map((row) => row.line) };
}

/** The branch table cells of a branch sheet (`header`, `branch`, `fitting`), or every problem found. */
export function branchCellsFromSheet(
  sheet: Sheet,
): { readonly cells: Record<string, Record<string, string>> } | { readonly problems: readonly SheetProblem[] } {
  const problems: SheetProblem[] = [];
  for (const column of ['header', 'branch', 'fitting'])
    if (!sheet.headers.includes(column)) problems.push({ row: 1, column, message: `the branch sheet has no "${column}" column` });
  if (problems.length > 0) return { problems };
  const table = new Map<string, Map<string, string>>();
  for (const row of sheet.rows) {
    const header = (row.cells.get('header') ?? '').trim();
    const branch = (row.cells.get('branch') ?? '').trim();
    const fitting = (row.cells.get('fitting') ?? '').trim();
    if (isHostileName(header) || isHostileName(branch)) {
      problems.push({ row: row.line, message: `the size "${isHostileName(header) ? header : branch}" is not allowed` });
      continue;
    }
    if (header === '' || branch === '' || fitting === '') {
      problems.push({ row: row.line, message: 'header, branch and fitting must all be filled' });
      continue;
    }
    const line = table.get(header) ?? new Map<string, string>();
    if (line.has(branch)) problems.push({ row: row.line, message: `the cell ${header} x ${branch} is listed twice` });
    line.set(branch, fitting);
    table.set(header, line);
  }
  if (problems.length > 0) return { problems };
  return { cells: Object.fromEntries([...table].map(([header, line]) => [header, Object.fromEntries(line)])) };
}

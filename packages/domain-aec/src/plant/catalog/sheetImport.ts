/**
 * Catalogue sheet -> catalogue file object (plant 01 PSC M5): the CSV written by `export_piping_catalog format csv` (one row per size, one column per
 * dimension) or a sheet from another tool whose columns are mapped with `columns`. The result is the `llull-piping-catalog` file object, which the
 * normal parser (`parseCatalogFile`) then validates: every rule of the JSON import applies (provenance, units, family schemas, licence).
 * @invariant pure, never throws; a problem is an issue with the sheet row (and cell) it came from; a dimension without a provenance is refused by the file parser
 */

import { END_TYPES, FACINGS, type Provenance } from './types';
import { cellNumber, type Sheet, type SheetRow } from './sheetRead';

/** Fixed columns of the catalogue sheet; every other column is a dimension (`dim.<name>` forces a dimension whose name equals a fixed column). */
export const CATALOG_FIXED_COLUMNS = [
  'family',
  'type',
  'standard',
  'size',
  'smallSize',
  'schedule',
  'class',
  'pn',
  'facing',
  'dimensionalStandard',
  'radius',
  'ends',
  'sourceId',
  'citation',
  'url',
  'accessed',
] as const;
const FIXED: ReadonlySet<string> = new Set([...CATALOG_FIXED_COLUMNS, 'verified']);
const DIM_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const DIM_PREFIX = 'dim.';
const FAMILY_LEVEL = ['type', 'standard', 'dimensionalStandard', 'radius', 'ends'] as const;

export interface SheetProblem {
  readonly row: number;
  readonly column?: string;
  readonly message: string;
}

export interface CatalogSheetMeta {
  readonly id: string;
  readonly version?: string | undefined;
  readonly title?: string | undefined;
  readonly licence: string;
  readonly unit?: string | undefined;
  readonly provenance?: { readonly [K in keyof Provenance]?: Provenance[K] | undefined } | undefined;
}

/** Where each file family / size came from in the sheet, to put the row on an issue of the file parser. */
export interface CatalogSheetOrigin {
  /** `[familyIndex][sizeIndex]` -> sheet row. */
  readonly rows: readonly (readonly number[])[];
}

/** `"NPS 4"` / `"DN 100"` -> the file keys (`nps` / `dn`), or null. */
function sizeKeys(cell: string, nps: 'nps' | 'smallNps', dn: 'dn' | 'smallDn'): Record<string, string> | null {
  const match = /^\s*(NPS|DN)\s+(\S+)\s*$/.exec(cell);
  return match === null ? null : { [match[1] === 'NPS' ? nps : dn]: match[2] as string };
}

function rowSize(row: SheetRow, problems: SheetProblem[]): Record<string, unknown> {
  const get = (name: string): string => (row.cells.get(name) ?? '').trim();
  const bad = (column: string, message: string): void => void problems.push({ row: row.line, column, message });
  const size: Record<string, unknown> = {};
  const main = sizeKeys(get('size'), 'nps', 'dn');
  if (main === null) bad('size', `size "${get('size')}" must read "NPS <size>" or "DN <size>"`);
  else Object.assign(size, main);
  if (get('smallSize') !== '') {
    const small = sizeKeys(get('smallSize'), 'smallNps', 'smallDn');
    if (small === null) bad('smallSize', `smallSize "${get('smallSize')}" must read "NPS <size>" or "DN <size>"`);
    else Object.assign(size, small);
  }
  if (get('schedule') !== '') size['schedule'] = row.cells.get('schedule');
  for (const column of ['class', 'pn'] as const) {
    if (get(column) === '') continue;
    const value = cellNumber(get(column));
    if (value === null) bad(column, `${column} "${get(column)}" is not a number`);
    else size[column] = value;
  }
  if (get('facing') !== '') {
    if (!(FACINGS as readonly string[]).includes(get('facing')))
      bad('facing', `facing "${get('facing')}" is not one of ${FACINGS.join(', ')}`);
    else size['facing'] = get('facing');
  }
  const provenance: Record<string, string> = {};
  for (const column of ['sourceId', 'citation', 'url', 'accessed'] as const)
    if (get(column) !== '') provenance[column] = row.cells.get(column) as string;
  if (Object.keys(provenance).length > 0) size['provenance'] = provenance;
  const verified = get('verified').toLowerCase();
  if (verified === 'true') size['verified'] = true;
  else if (verified !== '' && verified !== 'false') bad('verified', `verified "${get('verified')}" must be true or false`);
  return size;
}

/** The catalogue file object of `sheet`, or every problem found (with sheet rows). */
export function catalogFileFromSheet(
  sheet: Sheet,
  meta: CatalogSheetMeta,
): { readonly file: Record<string, unknown>; readonly origin: CatalogSheetOrigin } | { readonly problems: readonly SheetProblem[] } {
  const problems: SheetProblem[] = [];
  for (const column of ['family', 'type', 'standard', 'size'])
    if (!sheet.headers.includes(column))
      problems.push({
        row: 1,
        column,
        message: `the sheet has no "${column}" column (columns: ${sheet.headers.join(', ')}; map yours with columns)`,
      });
  if (problems.length > 0) return { problems };
  const dimColumns = sheet.headers.flatMap((header) => {
    const forced = header.startsWith(DIM_PREFIX);
    const name = forced ? header.slice(DIM_PREFIX.length) : header;
    if (!forced && FIXED.has(header)) return [];
    if (!DIM_NAME.test(name)) {
      problems.push({
        row: 1,
        column: header,
        message: `the column "${header}" is not a valid dimension name (letters, digits, underscore)`,
      });
      return [];
    }
    return [{ header, name }];
  });
  const families = new Map<string, { head: Record<string, string>; sizes: Record<string, unknown>[]; rows: number[] }>();
  for (const row of sheet.rows) {
    const id = row.cells.get('family') ?? '';
    const head = Object.fromEntries(FAMILY_LEVEL.map((name) => [name, (row.cells.get(name) ?? '').trim()]));
    const family = families.get(id) ?? { head, sizes: [], rows: [] };
    families.set(id, family);
    for (const name of FAMILY_LEVEL)
      if ((family.head[name] ?? '') !== (head[name] ?? ''))
        problems.push({
          row: row.line,
          column: name,
          message: `family ${id}: ${name} "${head[name]}" differs from "${family.head[name]}" on its first row`,
        });
    const size = rowSize(row, problems);
    for (const { header, name } of dimColumns) {
      const cell = (row.cells.get(header) ?? '').trim();
      if (cell === '') continue;
      const value = cellNumber(cell);
      if (value === null) problems.push({ row: row.line, column: header, message: `${header} "${cell}" is not a number` });
      else size[name] = value;
    }
    family.sizes.push(size);
    family.rows.push(row.line);
  }
  if (problems.length > 0) return { problems };
  const ordered = [...families.entries()];
  const file = {
    format: 'llull-piping-catalog',
    schemaVersion: 1,
    id: meta.id,
    ...(meta.version === undefined ? {} : { version: meta.version }),
    ...(meta.title === undefined ? {} : { title: meta.title }),
    licence: meta.licence,
    families: ordered.map(([id, family]) => {
      const ends = (family.head['ends'] ?? '').split(/\s+/).filter((end) => end !== '');
      const unknown = ends.find((end) => !(END_TYPES as readonly string[]).includes(end));
      if (unknown !== undefined)
        problems.push({
          row: family.rows[0] ?? 1,
          column: 'ends',
          message: `family ${id}: end type "${unknown}" is not one of ${END_TYPES.join(', ')}`,
        });
      return {
        id,
        type: family.head['type'],
        standard: family.head['standard'],
        ...(family.head['dimensionalStandard'] === '' ? {} : { dimensionalStandard: family.head['dimensionalStandard'] }),
        ...((family.head['radius'] ?? '') === '' ? {} : { radius: family.head['radius'] }),
        ...(ends.length === 0 ? {} : { ends }),
        unit: meta.unit ?? 'mm',
        sizes: family.sizes.map((size) => ({
          ...(meta.provenance === undefined || size['provenance'] !== undefined ? {} : { provenance: meta.provenance }),
          ...size,
        })),
      };
    }),
  };
  if (problems.length > 0) return { problems };
  return { file, origin: { rows: ordered.map(([, family]) => family.rows) } };
}

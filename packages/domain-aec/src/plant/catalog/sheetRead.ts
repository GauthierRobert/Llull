/**
 * Untrusted CSV sheet reader of the piping importers (plant 01 PSC M5): header + rows read through `@lib/csvRead` with bounds, never throwing.
 * Cells are read verbatim (a leading formula-guard apostrophe written by our own exporters is removed, nothing is evaluated or trimmed); a row is a
 * `Map` keyed by header name, so a hostile header such as `__proto__` can never reach an object prototype (it is refused by name anyway).
 * @invariant bounded: 5 MB of text, 20 000 rows, 200 columns, 4 000 characters a field; every refusal names the line; header names are unique
 */

import { readCsv } from '@lib/csvRead';
import { unguardCell } from './csvGuard';

export const SHEET_LIMITS = { maxChars: 5_000_000, maxRows: 20_001, maxColumns: 200, maxFieldChars: 4_000 } as const;
const HOSTILE_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);

export interface SheetRow {
  /** Spreadsheet row of the record: the record number + 1, the header is row 1. */
  readonly line: number;
  readonly cells: ReadonlyMap<string, string>;
}

export interface Sheet {
  readonly headers: readonly string[];
  readonly rows: readonly SheetRow[];
}

export interface SheetFailure {
  readonly code: string;
  readonly message: string;
  readonly line: number;
}

const failure = (code: string, message: string, line: number): SheetFailure => ({ code, message, line });

/** True for a header (or a user-chosen column / key name) that must never be used as a property name. */
export const isHostileName = (name: string): boolean => HOSTILE_NAMES.has(name) || [...name].some((char) => char.charCodeAt(0) < 32);

/** Reads `text` as a sheet: first record = header, the rest = rows (all-empty records skipped). */
export function readSheet(text: string, allowNoRows = false): { readonly sheet: Sheet } | { readonly failure: SheetFailure } {
  const csv = readCsv(text, SHEET_LIMITS);
  if (!csv.ok) return { failure: failure(csv.code, csv.message, csv.line) };
  const [headerRecord, ...records] = csv.rows;
  const headers = (headerRecord ?? []).map((header) => unguardCell(header).trim());
  const seen = new Set<string>();
  for (const header of headers) {
    if (header === '') return { failure: failure('SHEET_HEADER_EMPTY', 'row 1: a header cell is empty', 1) };
    if (isHostileName(header)) return { failure: failure('SHEET_HEADER_HOSTILE', `row 1: the header name "${header}" is not allowed`, 1) };
    if (seen.has(header)) return { failure: failure('SHEET_HEADER_DUPLICATE', `row 1: the header "${header}" appears twice`, 1) };
    seen.add(header);
  }
  if (records.length > SHEET_LIMITS.maxRows - 1)
    return { failure: failure('CSV_TOO_MANY_ROWS', `more than ${SHEET_LIMITS.maxRows - 1} data rows`, 1) };
  const rows: SheetRow[] = [];
  // csvRead drops blank lines, so `line` counts records, not file lines.
  records.forEach((record, index) => {
    if (record.every((cell) => cell === '')) return;
    rows.push({ line: index + 2, cells: new Map(headers.map((header, at) => [header, unguardCell(record[at] ?? '')])) });
  });
  const ragged = records.findIndex((record) => record.length !== headers.length && !record.every((cell) => cell === ''));
  if (ragged >= 0)
    return {
      failure: failure(
        'SHEET_ROW_WIDTH',
        `row ${ragged + 2}: the row has ${(records[ragged] as string[]).length} cell(s), the header has ${headers.length}`,
        ragged + 2,
      ),
    };
  if (rows.length === 0 && !allowNoRows) return { failure: failure('CSV_EMPTY', 'the sheet has a header but no data row', 1) };
  return { sheet: { headers, rows } };
}

/** Renames headers by `columns` ({ ourName: "name in the file" }); a name in `columns` that the file lacks, or a clash with another column, is a failure. */
export function renameHeaders(
  sheet: Sheet,
  columns: Readonly<Record<string, string>> | undefined,
): { readonly sheet: Sheet } | { readonly failure: SheetFailure } {
  if (columns === undefined || Object.keys(columns).length === 0) return { sheet };
  const rename = new Map<string, string>();
  for (const [ours, theirs] of Object.entries(columns)) {
    if (isHostileName(ours) || isHostileName(theirs))
      return { failure: failure('SHEET_HEADER_HOSTILE', `columns: the name "${isHostileName(ours) ? ours : theirs}" is not allowed`, 1) };
    if (!sheet.headers.includes(theirs))
      return {
        failure: failure(
          'SHEET_COLUMN_MISSING',
          `columns.${ours}: the file has no column "${theirs}" (columns: ${sheet.headers.join(', ')})`,
          1,
        ),
      };
    if (rename.has(theirs))
      return { failure: failure('SHEET_HEADER_DUPLICATE', `columns: the file column "${theirs}" is mapped twice`, 1) };
    rename.set(theirs, ours);
  }
  const headers = sheet.headers.map((header) => rename.get(header) ?? header);
  if (new Set(headers).size !== headers.length)
    return { failure: failure('SHEET_HEADER_DUPLICATE', 'columns: a mapped name equals another column', 1) };
  return {
    sheet: {
      headers,
      rows: sheet.rows.map((row) => ({
        line: row.line,
        cells: new Map([...row.cells].map(([header, cell]) => [rename.get(header) ?? header, cell])),
      })),
    },
  };
}

/** A finite non-negative decimal from a cell (plain or scientific notation), or null. */
export function cellNumber(cell: string): number | null {
  const text = cell.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

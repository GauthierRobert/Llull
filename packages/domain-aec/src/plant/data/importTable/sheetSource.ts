/**
 * The table a spreadsheet import reads (plant 08 DAT §5.10, §5.11): an XLSX (through `@lib/xlsxRead`) or a CSV text (through `@lib/csvRead`) becomes a
 * header row plus data rows of cell values. The file content is untrusted: sizes, rows, columns and cell lengths are bounded by the readers, a formula is
 * a cached value or an unreadable marker (never evaluated), and a CSV field that starts with `'` before `= + - @` has that guard quote removed.
 */

import { base64ToUint8Array } from '@lib/base64';
import { readCsv } from '@lib/csvRead';
import { sha256Hex } from '@lib/sha256';
import { xlsxColumnLetters } from '@lib/xlsxWrite';
import { readXlsx, type XlsxReadCell, type XlsxReadSheet } from '@lib/xlsxRead';
import { failure, type Outcome } from '../commands/params';
import { META_SHEET } from './meta';

export type ImportCell = XlsxReadCell;

export interface SheetRow {
  /** 1-based row number in the file (CSV: the record number, header = 1). */
  readonly row: number;
  readonly cells: readonly ImportCell[];
}

export interface SourceTable {
  readonly format: 'xlsx' | 'csv';
  readonly sheet: string;
  readonly header: readonly string[];
  readonly rows: readonly SheetRow[];
  /** Plant data hash the export wrote into its hidden `_meta` sheet, null when the file has none. */
  readonly metaHash: string | null;
  readonly sha256: string;
}

export interface SourceInput {
  readonly fileBase64?: string | undefined;
  readonly csv?: string | undefined;
  readonly sheet?: string | undefined;
}

const MAX_BASE64_CHARS = 48_000_000;
const MAX_IMPORT_ROWS = 200_000;
const GUARDED = /^'[=+\-@\t\r]/;

/** `A1` style reference of a zero-based column index and a row. */
export const cellReference = (column: number, row: number): string => `${xlsxColumnLetters(column)}${row}`;

const headerText = (cell: ImportCell | undefined): string =>
  cell === null || cell === undefined || typeof cell === 'object' ? '' : String(cell).normalize('NFC').trim();

function fromSheet(sheet: XlsxReadSheet, sha256: string, metaHash: string | null): Outcome<{ readonly table: SourceTable }> {
  const [first, ...rest] = sheet.rows;
  if (first === undefined)
    return failure('DAT_IMPORT_FORMAT', `sheet "${sheet.name}" is empty: row 1 must hold the column headers`, ['sheet']);
  return { ok: true, table: { format: 'xlsx', sheet: sheet.name, header: first.cells.map(headerText), rows: rest, metaHash, sha256 } };
}

function metaHashOf(sheets: readonly XlsxReadSheet[]): string | null {
  const meta = sheets.find((sheet) => sheet.name === META_SHEET);
  for (const row of meta?.rows ?? []) if (row.cells[0] === 'plantDataHash' && typeof row.cells[1] === 'string') return row.cells[1];
  return null;
}

/**
 * Loads the table of an import file.
 * @failure both or neither of fileBase64 / csv, bad base64, a file over the limits, an unreadable archive or CSV, an unknown sheet, an empty sheet,
 *   duplicate headers -> DAT_IMPORT_FORMAT (DAT_PARAM_INVALID for the parameters)
 */
export function loadSource(input: SourceInput): Outcome<{ readonly table: SourceTable }> {
  if ((input.fileBase64 === undefined) === (input.csv === undefined))
    return failure('DAT_PARAM_INVALID', 'send exactly one of fileBase64 (an .xlsx or .csv file) and csv (the CSV text)', ['fileBase64']);
  let table: Outcome<{ readonly table: SourceTable }>;
  if (input.csv !== undefined) table = fromCsv(input.csv, sha256Hex(input.csv));
  else {
    const encoded = input.fileBase64 as string;
    const bytes = encoded.length > MAX_BASE64_CHARS ? null : base64ToUint8Array(encoded.trim());
    if (bytes === null || bytes.length === 0)
      return failure('DAT_IMPORT_FORMAT', 'fileBase64 is not base64 (or larger than the import limit)', ['fileBase64']);
    const sha = sha256Hex(bytes);
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
      const book = readXlsx(bytes);
      if (!book.ok) return failure('DAT_IMPORT_FORMAT', `the workbook cannot be read: ${book.code}: ${book.message}`, ['fileBase64']);
      const wanted = input.sheet?.toLowerCase();
      const sheet =
        wanted === undefined
          ? book.sheets.find((candidate) => !candidate.hidden)
          : book.sheets.find((c) => c.name.toLowerCase() === wanted);
      if (sheet === undefined)
        return failure(
          'DAT_IMPORT_FORMAT',
          `no sheet${input.sheet === undefined ? '' : ` "${input.sheet}"`} (sheets: ${book.sheets.map((c) => c.name).join(', ')})`,
          ['sheet'],
        );
      table = fromSheet(sheet, sha, metaHashOf(book.sheets));
    } else table = fromCsv(new TextDecoder().decode(bytes), sha);
  }
  if (!table.ok) return table;
  const seen = new Set<string>();
  for (const [index, header] of table.table.header.entries()) {
    if (header === '') continue;
    if (seen.has(header.toLowerCase()))
      return failure('DAT_IMPORT_FORMAT', `the column header "${header}" appears twice (column ${cellReference(index, 1)})`, ['header']);
    seen.add(header.toLowerCase());
  }
  return table;
}

function fromCsv(text: string, sha256: string): Outcome<{ readonly table: SourceTable }> {
  const parsed = readCsv(text, { maxRows: MAX_IMPORT_ROWS });
  if (!parsed.ok) return failure('DAT_IMPORT_FORMAT', `the CSV cannot be read: ${parsed.code}: ${parsed.message}`, ['csv']);
  const [first, ...rest] = parsed.rows;
  return {
    ok: true,
    table: {
      format: 'csv',
      sheet: 'csv',
      header: (first ?? []).map(headerText),
      rows: rest.map((cells, index) => ({ row: index + 2, cells: cells.map((cell) => (GUARDED.test(cell) ? cell.slice(1) : cell)) })),
      metaHash: null,
      sha256,
    },
  };
}

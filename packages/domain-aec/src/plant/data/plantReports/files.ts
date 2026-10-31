/** Report and data files (`data.files[]` of the commands, written by `--save`): RFC 4180 CSV through `toCsv`, XLSX through `xlsxWrite`. */

import { uint8ArrayToBase64 } from '@lib/base64';
import { toCsv } from '@lib/csv';
import { xlsxWrite, type XlsxSheet } from '@lib/xlsxWrite';
import { headerOf, type ReportColumn, type ReportRow } from './types';

export type DataFile = { readonly fileName: string; readonly content: string } | { readonly fileName: string; readonly base64: string };

export interface TableFile {
  readonly columns: readonly ReportColumn[];
  readonly rows: readonly ReportRow[];
}

export const csvFile = (fileName: string, table: TableFile): DataFile => ({
  fileName,
  content: toCsv(
    table.columns.map(headerOf),
    table.rows.map((row) => table.columns.map((column) => row[column.name] ?? null)),
  ),
});

export const xlsxSheetOf = (name: string, table: TableFile, protect: boolean, unlocked: (column: ReportColumn) => boolean): XlsxSheet => ({
  name,
  columns: table.columns.map((column) => ({ header: headerOf(column), locked: !unlocked(column) })),
  rows: table.rows.map((row) => table.columns.map((column) => row[column.name] ?? null)),
  protect,
});

export const xlsxFile = (fileName: string, sheets: readonly XlsxSheet[]): DataFile => ({
  fileName,
  base64: uint8ArrayToBase64(xlsxWrite(sheets)),
});

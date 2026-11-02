/**
 * Spreadsheet formula guard for the CSV exports (spec sheet, catalogue sheet): text from imported files is untrusted, and a cell that starts with
 * `=`, `+`, `-`, `@`, a tab or a carriage return is read as a formula by Excel / LibreOffice (CSV injection). Such a text cell is exported with a
 * leading apostrophe; numbers and booleans are written as they are.
 * @invariant pure; a cell that cannot start a formula is returned unchanged
 */

import type { CsvCell } from '@lib/csv';

/** `cell` made safe to open in a spreadsheet. */
export const guardCell = (cell: CsvCell): CsvCell => (typeof cell === 'string' && /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell);

/** Every cell of `rows` guarded. */
export const guardRows = (rows: ReadonlyArray<ReadonlyArray<CsvCell>>): CsvCell[][] => rows.map((row) => row.map(guardCell));

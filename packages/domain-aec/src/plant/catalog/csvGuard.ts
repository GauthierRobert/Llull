/**
 * Spreadsheet formula guard for the CSV exports (spec sheet, catalogue sheet): text from imported files is untrusted, and a cell that starts with
 * `=`, `+`, `-`, `@`, a tab or a carriage return is read as a formula by Excel / LibreOffice (CSV injection). Such a text cell is exported with a
 * leading apostrophe; numbers and booleans are written as they are. A text that already starts with apostrophes followed by such a character gets one
 * more, so `unguardCell` (one apostrophe off, only in that shape) restores every text verbatim: export then import is lossless.
 * @invariant pure; a cell that cannot start a formula is returned unchanged; unguardCell(guardCell(text)) === text for every text
 */

import type { CsvCell } from '@lib/csv';

const TRIGGER = /^'*[=+\-@\t\r]/;
const GUARDED = /^'+[=+\-@\t\r]/;

/** `cell` made safe to open in a spreadsheet. */
export const guardCell = (cell: CsvCell): CsvCell => (typeof cell === 'string' && TRIGGER.test(cell) ? `'${cell}` : cell);

/** Every cell of `rows` guarded. */
export const guardRows = (rows: ReadonlyArray<ReadonlyArray<CsvCell>>): CsvCell[][] => rows.map((row) => row.map(guardCell));

/** The text a guarded cell stands for: one leading apostrophe removed when the rest starts with a formula character (after more apostrophes). */
export const unguardCell = (cell: string): string => (GUARDED.test(cell) ? cell.slice(1) : cell);

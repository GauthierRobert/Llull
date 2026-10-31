/**
 * RFC 4180 CSV reader for untrusted text (plant data import, tag lists): quoted fields with doubled quotes, CR / LF / CRLF line ends, a byte-order mark,
 * blank lines skipped, the delimiter given or detected on the first line (`,` `;` or tab). Never throws: returns the rows or a coded error with the line.
 * Nothing is evaluated: a field that starts with `=`, `+`, `-` or `@` is plain text.
 * @invariant one pass, linear in the text; text size, row count, column count and field length are bounded before they can grow
 */

type CsvDelimiter = ',' | ';' | '\t';

export interface CsvReadLimits {
  /** Text length in UTF-16 units (default 20 000 000). */
  readonly maxChars?: number;
  /** Records, header included (default 200 000). */
  readonly maxRows?: number;
  /** Fields in one record (default 1 024). */
  readonly maxColumns?: number;
  /** Characters in one field (default 32 767, the spreadsheet cell limit). */
  readonly maxFieldChars?: number;
  /** The delimiter; `auto` (default) picks the most frequent of `,` `;` tab on the first line outside quotes. */
  readonly delimiter?: CsvDelimiter | 'auto';
}

type CsvErrorCode =
  | 'CSV_EMPTY'
  | 'CSV_TOO_LARGE'
  | 'CSV_TOO_MANY_ROWS'
  | 'CSV_TOO_MANY_COLUMNS'
  | 'CSV_FIELD_TOO_LONG'
  | 'CSV_UNTERMINATED_QUOTE';

export type CsvReadResult =
  | { readonly ok: true; readonly rows: string[][]; readonly delimiter: CsvDelimiter }
  | { readonly ok: false; readonly code: CsvErrorCode; readonly message: string; readonly line: number };

const QUOTE = 34;
const LF = 10;
const CR = 13;
const DELIMITER_CODES: Readonly<Record<CsvDelimiter, number>> = { ',': 44, ';': 59, '\t': 9 };

/** The most frequent delimiter on the first line, quotes respected (a tie, or none, gives a comma). */
function detectDelimiter(text: string): CsvDelimiter {
  const counts: Record<CsvDelimiter, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if (code === QUOTE) quoted = !quoted;
    else if (!quoted && (code === LF || code === CR)) break;
    else if (!quoted && code === 44) counts[',']++;
    else if (!quoted && code === 59) counts[';']++;
    else if (!quoted && code === 9) counts['\t']++;
  }
  return counts[';'] > counts[','] && counts[';'] >= counts['\t'] ? ';' : counts['\t'] > counts[','] ? '\t' : ',';
}

/** Reads `text` as CSV. Never throws. */
export function readCsv(source: string, limits: CsvReadLimits = {}): CsvReadResult {
  const maxChars = limits.maxChars ?? 20_000_000;
  const maxRows = limits.maxRows ?? 200_000;
  const maxColumns = limits.maxColumns ?? 1024;
  const maxField = limits.maxFieldChars ?? 32_767;
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  if (text.length > maxChars)
    return { ok: false, code: 'CSV_TOO_LARGE', message: `the CSV has ${text.length} characters, the limit is ${maxChars}`, line: 1 };
  if (text.trim() === '') return { ok: false, code: 'CSV_EMPTY', message: 'the CSV is empty', line: 1 };
  const delimiter = limits.delimiter === undefined || limits.delimiter === 'auto' ? detectDelimiter(text) : limits.delimiter;
  const separator = DELIMITER_CODES[delimiter];
  const rows: string[][] = [];
  let record: string[] = [];
  let line = 1;
  const fail = (code: CsvErrorCode, message: string): CsvReadResult => ({ ok: false, code, message: `line ${line}: ${message}`, line });
  const endRecord = (): CsvReadResult | null => {
    if (record.length > 0 && !(record.length === 1 && record[0] === '')) {
      if (rows.length >= maxRows) return fail('CSV_TOO_MANY_ROWS', `more than ${maxRows} records`);
      rows.push(record);
    }
    record = [];
    return null;
  };
  let at = 0;
  const length = text.length;
  while (at < length) {
    let field: string;
    if (text.charCodeAt(at) === QUOTE) {
      at++;
      let start = at;
      let value = '';
      for (;;) {
        const close = text.indexOf('"', at);
        if (close < 0) return fail('CSV_UNTERMINATED_QUOTE', 'a quoted field is never closed');
        if (text.charCodeAt(close + 1) === QUOTE) {
          value += text.slice(start, close + 1);
          at = start = close + 2;
        } else {
          value += text.slice(start, close);
          at = close + 1;
          break;
        }
        if (value.length > maxField) return fail('CSV_FIELD_TOO_LONG', `a field is longer than ${maxField} characters`);
      }
      let end = at;
      while (end < length) {
        const code = text.charCodeAt(end);
        if (code === separator || code === LF || code === CR) break;
        end++;
      }
      field = value + text.slice(at, end);
      at = end;
    } else {
      let end = at;
      while (end < length) {
        const code = text.charCodeAt(end);
        if (code === separator || code === LF || code === CR) break;
        end++;
      }
      field = text.slice(at, end);
      at = end;
    }
    if (field.length > maxField) return fail('CSV_FIELD_TOO_LONG', `a field is longer than ${maxField} characters`);
    if (record.length >= maxColumns) return fail('CSV_TOO_MANY_COLUMNS', `more than ${maxColumns} fields in one record`);
    record.push(field);
    if (at >= length) break;
    const code = text.charCodeAt(at);
    if (code === separator) {
      at++;
      if (at >= length) record.push('');
      continue;
    }
    at += code === CR && text.charCodeAt(at + 1) === LF ? 2 : 1;
    const ended = endRecord();
    if (ended !== null) return ended;
    line++;
  }
  const last = endRecord();
  if (last !== null) return last;
  return rows.length === 0 ? fail('CSV_EMPTY', 'the CSV has no record') : { ok: true, rows, delimiter };
}

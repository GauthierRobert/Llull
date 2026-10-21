export type CsvCell = string | number | boolean | null;

/** One RFC 4180 field: quoted (with doubled quotes) when it holds `"`, `,`, CR or LF; `null` is the empty field. */
export function csvCell(value: CsvCell): string {
  const text = value === null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 CSV records joined by `\n`, without a trailing newline. */
export function csvLines(columns: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<CsvCell>>): string {
  return [columns, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
}

/** RFC 4180 CSV, newline-terminated. */
export function toCsv(columns: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<CsvCell>>): string {
  return `${csvLines(columns, rows)}\n`;
}

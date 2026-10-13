/**
 * @layer domain-aec
 * @pure
 */

/** RFC 4180 CSV records joined by `\n`, without a trailing newline. */
export function csvLines(columns: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string | number | boolean>>): string {
  const cell = (value: string | number | boolean): string => {
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns, ...rows].map((row) => row.map(cell).join(',')).join('\n');
}

/** RFC 4180 CSV, newline-terminated. */
export function toCsv(columns: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string | number | boolean>>): string {
  return `${csvLines(columns, rows)}\n`;
}

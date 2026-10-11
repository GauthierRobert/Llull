/**
 * @layer domain-aec
 * @pure
 */

/** RFC 4180 CSV. */
export function toCsv(
  columns: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string | number>>,
): string {
  const cell = (value: string | number): string => {
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns, ...rows].map((row) => row.map(cell).join(',')).join('\n') + '\n';
}

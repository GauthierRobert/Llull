/** Parser of an MTest result file (`<script>.res`): `#` comment lines name the columns, the rest are whitespace-separated numbers. */

/** Named guard: rows returned to the caller (the full file stays in the job folder only while LLULL_NATIVE_KEEP=1). */
export const MAX_RESULT_ROWS = 10_000;

export interface MtestResult {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly number[])[];
  /** Rows in the file (> rows.length when truncated). */
  readonly rowCount: number;
  readonly truncated: boolean;
}

const COLUMN_NAME = /^#\s*(?:(first)|(\d+)(?:st|nd|rd|th)?)\s+column\s*:\s*(.+?)\s*$/i;

/**
 * Parse the text of a `.res` file.
 * @failure a non-numeric data line or rows of unequal width -> null
 */
export function parseMtestResult(text: string): MtestResult | null {
  const names = new Map<number, string>();
  const rows: number[][] = [];
  let rowCount = 0;
  let width = -1;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('#')) {
      const match = COLUMN_NAME.exec(line);
      if (match !== null) names.set(match[1] !== undefined ? 1 : Number(match[2]), match[3] ?? '');
      continue;
    }
    const values = line.split(/\s+/).map(Number);
    if (values.some((value) => !Number.isFinite(value))) return null;
    if (width >= 0 && values.length !== width) return null;
    width = values.length;
    rowCount += 1;
    if (rows.length < MAX_RESULT_ROWS) rows.push(values);
  }
  if (rowCount === 0) return null;
  return {
    columns: Array.from({ length: width }, (_, i) => names.get(i + 1) ?? `column${i + 1}`),
    rows,
    rowCount,
    truncated: rowCount > rows.length,
  };
}

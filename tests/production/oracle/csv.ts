/**
 * @layer tests/production/oracle
 *
 * RFC 4180 CSV reader (quoted fields, doubled quotes, CRLF) for issued schedules.
 */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? '';
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell !== ''));
}

/** Numeric column by header name (rows after the header); NaN for non-numbers. */
export function column(table: string[][], name: string): number[] {
  const index = (table[0] ?? []).indexOf(name);
  if (index < 0) return [];
  return table.slice(1).map((row) => {
    const cell = (row[index] ?? '').trim();
    return cell === '' ? NaN : Number(cell);
  });
}

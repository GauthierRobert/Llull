/** Lookup in a design table keyed by its first column, with a stated domain and a stated conservative neighbour. */

export interface TableHit<Row> {
  readonly row: Row;
  /** True when the key matches a row key. */
  readonly exact: boolean;
}

export interface TableRefusal {
  readonly code: string;
  /** Inclusive key range of the table. */
  readonly domain: readonly [number, number];
  readonly message: string;
}

export const isTableRefusal = <T extends object>(outcome: T | TableRefusal): outcome is TableRefusal => 'code' in outcome;

/**
 * Row of `table` for `key`: the exact row, else the conservative neighbour (`up` = the next row with a larger key, `down` = the previous
 * one); a key outside the table's key range, or not a number, is refused with `code`.
 * @invariant rows are ascending by key; the first element of a row is its key
 * @failure `code` — key outside [first key, last key]
 */
export function lookupConservative<Row extends readonly [number, ...number[]]>(
  table: readonly [Row, ...Row[]],
  key: number,
  options: { readonly direction: 'up' | 'down'; readonly code: string; readonly label: string; readonly unit: string },
): TableHit<Row> | TableRefusal {
  const first = table[0];
  const last = table[table.length - 1] as Row;
  const domain: readonly [number, number] = [first[0], last[0]];
  if (!(key >= domain[0] && key <= domain[1])) {
    return {
      code: options.code,
      domain,
      message: `${options.code}: ${options.label} ${key} ${options.unit} is outside the table domain [${domain[0]}, ${domain[1]}] ${options.unit}`,
    };
  }
  const exact = table.find((row) => row[0] === key);
  if (exact) return { row: exact, exact: true };
  const neighbour = options.direction === 'up' ? table.find((row) => row[0] > key) : [...table].reverse().find((row) => row[0] < key);
  return { row: neighbour as Row, exact: false };
}

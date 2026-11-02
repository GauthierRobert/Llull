/** Longest common subsequence of two tag sequences, bounded: the table has (n+1)(m+1) cells, so a pair above `MAX_ORDER_CELLS` is skipped by the caller. */

/** n * m cap of the inline-order comparison: 250 000 cells (500 x 500 tags, far above any line) = at most 251 001 16-bit cells. */
export const MAX_ORDER_CELLS = 250_000;

export const withinOrderBudget = (n: number, m: number): boolean => n * m <= MAX_ORDER_CELLS;

/** The indices into `a` of one LCS of `a` and `b` (O(n*m) time and space; call only when `withinOrderBudget`). Ties resolve toward earlier elements of `a`. */
export function longestCommonSubsequence(a: readonly string[], b: readonly string[]): number[] {
  const width = b.length + 1;
  const table = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
  const out: number[] = [];
  let [i, j] = [0, 0];
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(i);
      i++;
      j++;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) i++;
    else j++;
  }
  return out;
}

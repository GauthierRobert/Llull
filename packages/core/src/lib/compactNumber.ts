/** @pure `v` rounded to 4 decimals without trailing zeros (for summaries). */
export function compactNumber(v: number): string {
  return parseFloat(v.toFixed(4)).toString();
}

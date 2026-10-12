/** @pure `v` rounded to 4 decimals without trailing zeros (for summaries). */
export function compactNumber(v: number): string {
  return parseFloat(v.toFixed(4)).toString();
}

/** @pure `v` rounded to `digits` significant digits without trailing zeros. */
export function significantNumber(v: number, digits: number): string {
  return String(Number(v.toPrecision(digits)));
}

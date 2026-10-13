/** @pure `v` rounded to `decimals` decimals without trailing zeros (for summaries). */
export function fixedNumber(v: number, decimals: number): string {
  return parseFloat(v.toFixed(decimals)).toString();
}

/** @pure `v` rounded to 4 decimals without trailing zeros (for summaries). */
export function compactNumber(v: number): string {
  return fixedNumber(v, 4);
}

/** @pure `v` rounded to `decimals` decimal places, as a number. */
export function roundTo(v: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(v * scale) / scale;
}

/** @pure `v` rounded to `digits` significant digits without trailing zeros. */
export function significantNumber(v: number, digits: number): string {
  return String(Number(v.toPrecision(digits)));
}

/** @pure `[a, b, c]` of the components via `compactNumber` (for summaries). */
export function vecText(v: ReadonlyArray<number>): string {
  return `[${v.map(compactNumber).join(', ')}]`;
}

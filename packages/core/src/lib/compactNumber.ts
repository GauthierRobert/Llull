export function fixedNumber(v: number, decimals: number): string {
  return parseFloat(v.toFixed(decimals)).toString();
}

export function compactNumber(v: number): string {
  return fixedNumber(v, 4);
}

export function roundTo(v: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(v * scale) / scale;
}

export function significantNumber(v: number, digits: number): string {
  return String(Number(v.toPrecision(digits)));
}

export function vecText(v: ReadonlyArray<number>): string {
  return `[${v.map(compactNumber).join(', ')}]`;
}

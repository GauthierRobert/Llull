/** Natural order for tags and numbers ("P-2" before "P-10"): deterministic, locale-free (AF-13). */

const CHUNK = /(\d+)|(\D+)/g;

const isDigits = (text: string): boolean => text.charCodeAt(0) >= 48 && text.charCodeAt(0) <= 57;
const stripZeros = (text: string): string => text.replace(/^0+(?=\d)/, '');

export function naturalCompare(a: string, b: string): number {
  if (a === b) return 0;
  const left = a.match(CHUNK) ?? [];
  const right = b.match(CHUNK) ?? [];
  const common = Math.min(left.length, right.length);
  for (let i = 0; i < common; i++) {
    const x = left[i] ?? '';
    const y = right[i] ?? '';
    if (x === y) continue;
    if (isDigits(x) && isDigits(y)) {
      const px = stripZeros(x);
      const py = stripZeros(y);
      if (px.length !== py.length) return px.length - py.length;
      if (px !== py) return px < py ? -1 : 1;
      continue;
    }
    return x < y ? -1 : 1;
  }
  return left.length - right.length || (a < b ? -1 : a > b ? 1 : 0);
}

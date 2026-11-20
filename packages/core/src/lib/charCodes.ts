/**
 * `String.fromCharCode(...codes)` without the argument-count limit (a spread throws RangeError above ~1.5e5 items, PERF1 row 12):
 * the same string, one UTF-16 code unit (ToUint16) per code, decoded in bounded chunks.
 */
const CHUNK = 4096;

export function stringFromCharCodes(codes: ArrayLike<number>): string {
  const parts: string[] = [];
  for (let start = 0; start < codes.length; start += CHUNK) {
    let part = '';
    const end = Math.min(start + CHUNK, codes.length);
    for (let i = start; i < end; i++) part += String.fromCharCode(codes[i] as number);
    parts.push(part);
  }
  return parts.join('');
}

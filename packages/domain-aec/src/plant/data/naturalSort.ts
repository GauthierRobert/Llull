/** Natural tag order (plant 08 DAT §5.9): digit runs compare as integers, then code points, so `P-2` sorts before `P-10`. */

const CHUNK = /(\d+)|(\D+)/g;

export function naturalCompare(a: string, b: string): number {
  const left = a.match(CHUNK) ?? [];
  const right = b.match(CHUNK) ?? [];
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const x = left[index] as string;
    const y = right[index] as string;
    if (x === y) continue;
    const xDigits = /^\d/.test(x);
    const yDigits = /^\d/.test(y);
    if (xDigits && yDigits) {
      const delta = BigInt(x) - BigInt(y);
      if (delta !== 0n) return delta < 0n ? -1 : 1;
      if (x.length !== y.length) return x.length < y.length ? -1 : 1;
    } else return x < y ? -1 : 1;
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
}

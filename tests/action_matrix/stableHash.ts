/** Stable, seedable 32-bit FNV-1a: sampling and shard assignment must not depend on enumeration order or process. */
export function stableHash(text: string, seed = 0): number {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** True for 1-in-`n` keys (always when n <= 1). */
export const sampled = (key: string, n: number, seed: number): boolean => n <= 1 || stableHash(key, seed) % n === 0;

/** Shadow map resolution and its min / max depth pyramids (`sunShadows.ts` builds the map, `shadowReceivers.ts` queries it). @pure */

/** Texels per side of the shadow map (fixed; the map is fitted to the shadow casters, so a texel is extent / 1024 per axis). */
export const SHADOW_MAP_SIZE = 1024;

/** Min and max depth pyramids of `depth`: entry k is level k + 1, whose texel is 2^(k+1) base texels wide (down to 1 x 1). */
export function buildMips(depth: Float64Array): { maxMips: Float64Array[]; minMips: Float64Array[] } {
  const maxMips: Float64Array[] = [];
  const minMips: Float64Array[] = [];
  let [prevMax, prevMin, size] = [depth, depth, SHADOW_MAP_SIZE];
  while (size > 1) {
    const next = size / 2;
    const [nextMax, nextMin] = [new Float64Array(next * next), new Float64Array(next * next)];
    for (let y = 0; y < next; y += 1)
      for (let x = 0; x < next; x += 1) {
        const [a, b, c, d] = [2 * y * size + 2 * x, 2 * y * size + 2 * x + 1, (2 * y + 1) * size + 2 * x, (2 * y + 1) * size + 2 * x + 1];
        const at = (levels: Float64Array, i: number): number => levels[i] ?? -Infinity;
        nextMax[y * next + x] = Math.max(Math.max(at(prevMax, a), at(prevMax, b)), Math.max(at(prevMax, c), at(prevMax, d)));
        nextMin[y * next + x] = Math.min(Math.min(at(prevMin, a), at(prevMin, b)), Math.min(at(prevMin, c), at(prevMin, d)));
      }
    maxMips.push(nextMax);
    minMips.push(nextMin);
    [prevMax, prevMin, size] = [nextMax, nextMin, next];
  }
  return { maxMips, minMips };
}

/** Smallest and largest depth over the base texels x0..x1, y0..y1 (inclusive, in range); a conservative cover of at most 3 x 3 blocks of one level. */
export function depthRange(
  maps: { depth: Float64Array; maxMips: readonly Float64Array[]; minMips: readonly Float64Array[] },
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): { lo: number; hi: number } {
  const width = Math.max(x1 - x0, y1 - y0) + 1;
  let level = 0;
  while (level < maps.maxMips.length && width >> level > 2) level += 1;
  const size = SHADOW_MAP_SIZE >> level;
  const [maxLevel, minLevel] = level === 0 ? [maps.depth, maps.depth] : [maps.maxMips[level - 1], maps.minMips[level - 1]];
  let [lo, hi] = [Infinity, -Infinity];
  for (let y = y0 >> level; y <= y1 >> level; y += 1)
    for (let x = x0 >> level; x <= x1 >> level; x += 1) {
      lo = Math.min(lo, minLevel?.[y * size + x] ?? -Infinity);
      hi = Math.max(hi, maxLevel?.[y * size + x] ?? -Infinity);
    }
  return { lo, hi };
}

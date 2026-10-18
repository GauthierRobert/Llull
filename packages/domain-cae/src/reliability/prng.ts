/** Seeded deterministic PRNG: xoshiro128** state expanded from the seed by SplitMix32; normals by Box-Muller. */

export interface Prng {
  /** Uniform in the open interval (0, 1). */
  uniform(): number;
  /** Standard normal draw. */
  normal(): number;
}

function splitMix32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

export function createPrng(seed: number): Prng {
  const next = splitMix32(Math.trunc(seed));
  const s = [next(), next(), next(), next()];
  if (!s.some(Boolean)) s[0] = 1;
  const word = (i: number): number => s[i] ?? 0;
  const step = (): number => {
    const result = Math.imul(rotl(Math.imul(word(1), 5) >>> 0, 7), 9) >>> 0;
    const t = (word(1) << 9) >>> 0;
    s[2] = (word(2) ^ word(0)) >>> 0;
    s[3] = (word(3) ^ word(1)) >>> 0;
    s[1] = (word(1) ^ word(2)) >>> 0;
    s[0] = (word(0) ^ word(3)) >>> 0;
    s[2] = (word(2) ^ t) >>> 0;
    s[3] = rotl(word(3), 11);
    return result;
  };
  const uniform = (): number => (step() + 0.5) / 4294967296;
  let spare: number | null = null;
  return {
    uniform,
    normal: () => {
      if (spare !== null) {
        const value = spare;
        spare = null;
        return value;
      }
      const radius = Math.sqrt(-2 * Math.log(uniform()));
      const angle = 2 * Math.PI * uniform();
      spare = radius * Math.sin(angle);
      return radius * Math.cos(angle);
    },
  };
}

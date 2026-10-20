/**
 * Seeded pseudo-random stream for Monte Carlo (03 GDT TR-GDT-11): xoshiro128** seeded by SplitMix32 of `seed`, uniform from the top 24 bits,
 * normal by Box-Muller (cosine branch returned, sine branch kept for the next call). The same seed gives the same sequence; the generator
 * state is local to the returned object.
 */

export interface RandomStream {
  /** Uniform in (0, 1) (never 0 or 1). */
  uniform(): number;
  /** Standard normal. */
  normal(): number;
}

const TWO_POW_24 = 16777216;

/** One SplitMix32 step: the next state and its output word. */
function splitMix32(state: number): { state: number; word: number } {
  const next = (state + 0x9e3779b9) | 0;
  let t = next ^ (next >>> 16);
  t = Math.imul(t, 0x21f0aaad);
  t ^= t >>> 15;
  t = Math.imul(t, 0x735a2d97);
  return { state: next, word: (t ^ (t >>> 15)) >>> 0 };
}

const rotl = (value: number, shift: number): number => (value << shift) | (value >>> (32 - shift));

/** Stream for an integer seed (any finite number is truncated to 32 bits). */
export function createRandomStream(seed: number): RandomStream {
  let mix = splitMix32(Math.trunc(seed) | 0);
  const words: number[] = [];
  for (let i = 0; i < 4; i++) {
    words.push(mix.word);
    mix = splitMix32(mix.state);
  }
  let [s0, s1, s2, s3] = words as [number, number, number, number];
  if ((s0 | s1 | s2 | s3) === 0) s0 = 1;
  const nextWord = (): number => {
    const result = Math.imul(rotl(Math.imul(s1, 5), 7), 9) >>> 0;
    const t = s1 << 9;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = rotl(s3, 11);
    return result;
  };
  const uniform = (): number => (nextWord() >>> 8) / TWO_POW_24 + 1 / (2 * TWO_POW_24);
  let spare: number | null = null;
  const normal = (): number => {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }
    const radius = Math.sqrt(-2 * Math.log(uniform()));
    const angle = 2 * Math.PI * uniform();
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
  return { uniform, normal };
}

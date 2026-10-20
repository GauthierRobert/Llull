/**
 * Counter-based random numbers: Philox4x32-10 (Salmon, Moraes, Dror, Shaw, "Parallel random numbers: as easy as 1, 2, 3", SC'11,
 * doi:10.1145/2063384.2063405; constants and round as in Random123 `philox.h`). A draw is a pure function of (counter, key), so the
 * sample i of a Monte Carlo run does not depend on how many samples ran before it or on which thread: the native `llull-stats` crate
 * draws the same numbers. Normals by Box–Muller (cos branch) with a polynomial cos(2πu) written with + − × only, so it is bit-identical
 * in TypeScript and Rust; the only transcendental call is `Math.log` (V8 fdlibm, twin `llull_jsmath::log`).
 */

const M0 = 0xd2511f53;
const M1 = 0xcd9e8d57;
const W0 = 0x9e3779b9;
const W1 = 0xbb67ae85;
const TWO_32 = 4294967296;

/**
 * High 32 bits of the 64-bit product a·b (a, b < 2^32) given its exact low word: the double a·b − low is within 2^11 of the exact
 * multiple high·2^32, so rounding the quotient recovers `high` exactly.
 */
const mulHigh = (a: number, b: number, low: number): number => Math.round((a * b - low) / TWO_32);

/**
 * Philox4x32-10 of the counter (c0, c1, c2, c3) under the key (k0, k1), written into `out[0..3]`.
 * @invariant matches the Random123 known-answer vectors (kat_vectors, `philox4x32 10`)
 */
export function philox4x32(c0: number, c1: number, c2: number, c3: number, k0: number, k1: number, out: Uint32Array): void {
  let x0 = c0 >>> 0;
  let x1 = c1 >>> 0;
  let x2 = c2 >>> 0;
  let x3 = c3 >>> 0;
  let key0 = k0 >>> 0;
  let key1 = k1 >>> 0;
  for (let round = 0; round < 10; round += 1) {
    if (round > 0) {
      key0 = (key0 + W0) >>> 0;
      key1 = (key1 + W1) >>> 0;
    }
    const lo0 = Math.imul(M0, x0) >>> 0;
    const hi0 = mulHigh(M0, x0, lo0);
    const lo1 = Math.imul(M1, x2) >>> 0;
    const hi1 = mulHigh(M1, x2, lo1);
    x0 = (hi1 ^ x1 ^ key0) >>> 0;
    x1 = lo1;
    x2 = (hi0 ^ x3 ^ key1) >>> 0;
    x3 = lo0;
  }
  out[0] = x0;
  out[1] = x1;
  out[2] = x2;
  out[3] = x3;
}

/** Philox key of a seed (integer 0 ≤ seed < 2^53): its low and high 32-bit words. */
export const philoxKey = (seed: number): readonly [number, number] => [seed >>> 0, Math.floor(seed / TWO_32) >>> 0];

/** A 32-bit word as a uniform number in the open interval (0, 1): (w + ½)·2^-32. */
export const unitUniform = (word: number): number => (word + 0.5) / TWO_32;

const HALF_PI = Math.PI / 2;

/** sin x for |x| ≤ π/4, Taylor series to x^17 (truncation < 1e-19), Horner in x². */
function sinSmall(x: number): number {
  const x2 = x * x;
  return (
    x *
    (1 +
      x2 *
        (-1 / 6 +
          x2 *
            (1 / 120 +
              x2 *
                (-1 / 5040 +
                  x2 * (1 / 362880 + x2 * (-1 / 39916800 + x2 * (1 / 6227020800 + x2 * (-1 / 1307674368000 + x2 / 355687428096000))))))))
  );
}

/** cos x for |x| ≤ π/4, Taylor series to x^18 (truncation < 1e-19), Horner in x². */
function cosSmall(x: number): number {
  const x2 = x * x;
  return (
    1 +
    x2 *
      (-1 / 2 +
        x2 *
          (1 / 24 +
            x2 *
              (-1 / 720 +
                x2 *
                  (1 / 40320 +
                    x2 *
                      (-1 / 3628800 +
                        x2 * (1 / 479001600 + x2 * (-1 / 87178291200 + x2 * (1 / 20922789888000 - x2 / 6402373705728000))))))))
  );
}

/** cos(2πu) for 0 ≤ u < 1: quadrant from 4u (exact), then a series on at most π/4. */
export function cosTwoPi(u: number): number {
  const q = u * 4;
  const quadrant = Math.floor(q);
  const f = q - quadrant;
  const low = f <= 0.5;
  const cos = low ? cosSmall(f * HALF_PI) : sinSmall((1 - f) * HALF_PI);
  const sin = low ? sinSmall(f * HALF_PI) : cosSmall((1 - f) * HALF_PI);
  return quadrant === 0 ? cos : quadrant === 1 ? -sin : quadrant === 2 ? -cos : sin;
}

/** A standard normal from two 32-bit words: √(−2 ln u1)·cos(2π u2) (Box–Muller, cos branch). */
export const boxMuller = (word1: number, word2: number): number =>
  Math.sqrt(-2 * Math.log(unitUniform(word1))) * cosTwoPi(unitUniform(word2));

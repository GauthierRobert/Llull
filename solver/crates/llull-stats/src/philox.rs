//! Philox4x32-10 (Salmon, Moraes, Dror, Shaw, "Parallel random numbers: as easy as 1, 2, 3", SC'11, doi:10.1145/2063384.2063405;
//! constants and round as in Random123 `philox.h`) and the uniform / normal transforms of `packages/core/src/lib/prng.ts`, operation for
//! operation, so both draw the same bits.

const M0: u32 = 0xD251_1F53;
const M1: u32 = 0xCD9E_8D57;
const W0: u32 = 0x9E37_79B9;
const W1: u32 = 0xBB67_AE85;
const TWO_32: f64 = 4_294_967_296.0;

/// Philox4x32-10 of `counter` under `key`.
pub fn philox4x32(counter: [u32; 4], key: [u32; 2]) -> [u32; 4] {
    let [mut x0, mut x1, mut x2, mut x3] = counter;
    let [mut k0, mut k1] = key;
    for round in 0..10 {
        if round > 0 {
            k0 = k0.wrapping_add(W0);
            k1 = k1.wrapping_add(W1);
        }
        let p0 = u64::from(M0) * u64::from(x0);
        let p1 = u64::from(M1) * u64::from(x2);
        let (hi0, lo0) = ((p0 >> 32) as u32, p0 as u32);
        let (hi1, lo1) = ((p1 >> 32) as u32, p1 as u32);
        x0 = hi1 ^ x1 ^ k0;
        x1 = lo1;
        x2 = hi0 ^ x3 ^ k1;
        x3 = lo0;
    }
    [x0, x1, x2, x3]
}

/// Key of a seed (0 ≤ seed < 2^53): its low and high 32-bit words.
pub fn key_of(seed: u64) -> [u32; 2] {
    [seed as u32, (seed >> 32) as u32]
}

/// A 32-bit word as a uniform number in (0, 1): (w + ½)·2^-32.
#[inline]
pub fn unit_uniform(word: u32) -> f64 {
    (f64::from(word) + 0.5) / TWO_32
}

const HALF_PI: f64 = std::f64::consts::PI / 2.0;

#[inline]
fn sin_small(x: f64) -> f64 {
    let x2 = x * x;
    x * (1.0
        + x2 * (-1.0 / 6.0
            + x2 * (1.0 / 120.0
                + x2 * (-1.0 / 5040.0
                    + x2 * (1.0 / 362_880.0
                        + x2 * (-1.0 / 39_916_800.0
                            + x2 * (1.0 / 6_227_020_800.0 + x2 * (-1.0 / 1_307_674_368_000.0 + x2 / 355_687_428_096_000.0))))))))
}

#[inline]
fn cos_small(x: f64) -> f64 {
    let x2 = x * x;
    1.0 + x2
        * (-1.0 / 2.0
            + x2 * (1.0 / 24.0
                + x2 * (-1.0 / 720.0
                    + x2 * (1.0 / 40320.0
                        + x2 * (-1.0 / 3_628_800.0
                            + x2 * (1.0 / 479_001_600.0
                                + x2 * (-1.0 / 87_178_291_200.0 + x2 * (1.0 / 20_922_789_888_000.0 - x2 / 6_402_373_705_728_000.0))))))))
}

/// cos(2πu) for 0 ≤ u < 1 (the TS `cosTwoPi`).
pub fn cos_two_pi(u: f64) -> f64 {
    let q = u * 4.0;
    let quadrant = q.floor();
    let f = q - quadrant;
    let low = f <= 0.5;
    let cos = if low { cos_small(f * HALF_PI) } else { sin_small((1.0 - f) * HALF_PI) };
    let sin = if low { sin_small(f * HALF_PI) } else { cos_small((1.0 - f) * HALF_PI) };
    match quadrant as u32 {
        0 => cos,
        1 => -sin,
        2 => -cos,
        _ => sin,
    }
}

/// √(−2 ln u1)·cos(2π u2) with V8's `Math.log` (`llull_jsmath::log`).
#[inline]
pub fn box_muller(word1: u32, word2: u32) -> f64 {
    (-2.0 * llull_jsmath::log(unit_uniform(word1))).sqrt() * cos_two_pi(unit_uniform(word2))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_random123_known_answer_vectors() {
        // Random123 tests/kat_vectors, lines "philox4x32 10 <ctr0..3> <key0..1> <out0..3>".
        assert_eq!(philox4x32([0, 0, 0, 0], [0, 0]), [0x6627_e8d5, 0xe169_c58d, 0xbc57_ac4c, 0x9b00_dbd8]);
        assert_eq!(philox4x32([u32::MAX; 4], [u32::MAX; 2]), [0x408f_276d, 0x41c8_3b0e, 0xa20b_c7c6, 0x6d54_51fd]);
        assert_eq!(
            philox4x32([0x243f_6a88, 0x85a3_08d3, 0x1319_8a2e, 0x0370_7344], [0xa409_3822, 0x299f_31d0]),
            [0xd16c_fe09, 0x94fd_cceb, 0x5001_e420, 0x2412_6ea1]
        );
    }

    #[test]
    fn cos_two_pi_is_accurate_and_exact_at_quadrants() {
        assert_eq!(cos_two_pi(0.0), 1.0);
        assert_eq!(cos_two_pi(0.5), -1.0);
        for i in 0..10_000 {
            let u = f64::from(i) / 10_001.0;
            assert!((cos_two_pi(u) - (2.0 * std::f64::consts::PI * u).cos()).abs() < 1e-15);
        }
        assert_eq!(key_of((1 << 40) + 5), [5, 256]);
    }
}

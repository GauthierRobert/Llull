//! Philox4x32-10 (Salmon, Moraes, Dror, Shaw, "Parallel random numbers: as easy as 1, 2, 3", SC '11): a counter-based generator.
//! One call maps a 128-bit counter and a 64-bit key to 128 random bits, so the stream of sample `i` is a pure function of `(key, i)`:
//! no shared state, no dependence on thread count or scheduling.

const M0: u32 = 0xD251_1F53;
const M1: u32 = 0xCD9E_8D57;
const W0: u32 = 0x9E37_79B9;
const W1: u32 = 0xBB67_AE85;

fn mulhilo(a: u32, b: u32) -> (u32, u32) {
    let product = u64::from(a) * u64::from(b);
    ((product >> 32) as u32, product as u32)
}

/// The Random123 `philox4x32_10` block function.
pub fn philox4x32_10(counter: [u32; 4], key: [u32; 2]) -> [u32; 4] {
    let (mut ctr, mut key) = (counter, key);
    for round in 0..10 {
        if round > 0 {
            key = [key[0].wrapping_add(W0), key[1].wrapping_add(W1)];
        }
        let (hi0, lo0) = mulhilo(M0, ctr[0]);
        let (hi1, lo1) = mulhilo(M1, ctr[2]);
        ctr = [hi1 ^ ctr[1] ^ key[0], lo1, hi0 ^ ctr[3] ^ key[1], lo0];
    }
    ctr
}

/// Uniform in (0, 1) from the top 24 bits of `word` (same mapping as the TypeScript stream: never 0 or 1).
pub fn uniform(word: u32) -> f64 {
    const TWO_POW_24: f64 = 16_777_216.0;
    f64::from(word >> 8) / TWO_POW_24 + 1.0 / (2.0 * TWO_POW_24)
}

/// Standard normal by Box-Muller (cosine branch) from two words.
pub fn normal(word_a: u32, word_b: u32) -> f64 {
    (-2.0 * uniform(word_a).ln()).sqrt() * (2.0 * std::f64::consts::PI * uniform(word_b)).cos()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Random123 known-answer vectors (`kat_vectors`, philox4x32 10 rounds).
    #[test]
    fn matches_the_random123_known_answers() {
        assert_eq!(philox4x32_10([0; 4], [0; 2]), [0x6627_e8d5, 0xe169_c58d, 0xbc57_ac4c, 0x9b00_dbd8]);
        assert_eq!(philox4x32_10([0xffff_ffff; 4], [0xffff_ffff; 2]), [0x408f_276d, 0x41c8_3b0e, 0xa20b_c7c6, 0x6d54_51fd]);
        assert_eq!(
            philox4x32_10([0x243f_6a88, 0x85a3_08d3, 0x1319_8a2e, 0x0370_7344], [0xa409_3822, 0x299f_31d0]),
            [0xd16c_fe09, 0x94fd_cceb, 0x5001_e420, 0x2412_6ea1]
        );
    }

    #[test]
    fn uniform_stays_strictly_inside_the_unit_interval() {
        assert!(uniform(0) > 0.0);
        assert!(uniform(u32::MAX) < 1.0);
        assert_eq!(uniform(0x8000_0000), 0.5 + 1.0 / 33_554_432.0);
    }

    #[test]
    fn normal_has_the_box_muller_value_at_a_known_point() {
        // u1 = 0.5 + 2^-25, u2 = 0.25 + 2^-25: radius sqrt(-2 ln u1), angle ~ pi / 2 -> cosine ~ 0
        let z = normal(0x8000_0000, 0x4000_0000);
        assert!(z.abs() < 1e-6, "{z}");
    }
}

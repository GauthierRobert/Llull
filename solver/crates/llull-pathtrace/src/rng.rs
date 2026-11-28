//! Counter-based random numbers: every value is a pure hash of (seed, pixel index, sample index, dimension), so an image does not depend on
//! the thread count, the tile order or the scheduling (V2 determinism).

/// SplitMix64 finaliser (Steele, Lea and Flood 2014): a bijective 64-bit mix.
pub fn mix64(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

/// The random stream of one camera sample: dimension `d` of sample `s` of pixel `p` is `hash(seed, p, s, d)`.
#[derive(Debug, Clone)]
pub struct Sampler {
    key: u64,
    dimension: u64,
}

impl Sampler {
    pub fn new(seed: u32, pixel: u64, sample: u64) -> Sampler {
        let key = mix64(mix64(mix64(u64::from(seed) ^ 0x9e37_79b9_7f4a_7c15) ^ pixel) ^ sample.wrapping_mul(0xd1b5_4a32_d192_ed03));
        Sampler { key, dimension: 0 }
    }

    /// Next uniform value in [0, 1) with 24 random bits.
    pub fn uniform(&mut self) -> f32 {
        let value = mix64(self.key ^ self.dimension.wrapping_mul(0x9e37_79b9_7f4a_7c15));
        self.dimension += 1;
        (value >> 40) as f32 * (1.0 / 16_777_216.0)
    }

    pub fn uniform2(&mut self) -> (f32, f32) {
        let a = self.uniform();
        (a, self.uniform())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streams_are_reproducible_and_uniform() {
        let mut a = Sampler::new(7, 3, 9);
        let mut b = Sampler::new(7, 3, 9);
        let mut sum = 0.0f64;
        for _ in 0..100_000 {
            let value = a.uniform();
            assert_eq!(value, b.uniform());
            assert!((0.0..1.0).contains(&value));
            sum += f64::from(value);
        }
        assert!((sum / 100_000.0 - 0.5).abs() < 0.005);
        assert_ne!(Sampler::new(7, 3, 9).uniform(), Sampler::new(7, 3, 10).uniform());
        assert_ne!(Sampler::new(7, 3, 9).uniform(), Sampler::new(8, 3, 9).uniform());
    }
}

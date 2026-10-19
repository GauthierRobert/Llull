//! Fixed-order reductions (CPU): identical bits for any rayon thread count.

use rayon::prelude::*;

/// Chunk length of every fixed-order reduction (also the GPU dot's elements per workgroup).
pub const CHUNK: usize = 4096;

/// Sum of `values`: chunks of [`CHUNK`] summed left to right, then the partials left to right.
pub fn sum(values: &[f64]) -> f64 {
    let partials: Vec<f64> = values.par_chunks(CHUNK).map(|chunk| chunk.iter().fold(0.0, |acc, v| acc + v)).collect();
    partials.iter().fold(0.0, |acc, v| acc + v)
}

/// Dot product `a · b` in the same fixed order as [`sum`]. Panics when the lengths differ.
pub fn dot(a: &[f64], b: &[f64]) -> f64 {
    assert_eq!(a.len(), b.len(), "dot of vectors of different lengths");
    let partials: Vec<f64> =
        a.par_chunks(CHUNK).zip(b.par_chunks(CHUNK)).map(|(x, y)| x.iter().zip(y).fold(0.0, |acc, (p, q)| acc + p * q)).collect();
    partials.iter().fold(0.0, |acc, v| acc + v)
}

/// Largest absolute value (max is order-independent; NaN-free inputs assumed).
pub fn max_abs(values: &[f64]) -> f64 {
    values.par_iter().map(|v| v.abs()).reduce(|| 0.0, f64::max)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values(n: usize) -> Vec<f64> {
        (0..n).map(|i| ((i * 7919) % 1009) as f64 * 1e-3 - 0.4 + 1.0 / (i as f64 + 1.0)).collect()
    }

    #[test]
    fn sum_and_dot_are_identical_for_any_thread_count() {
        let a = values(50_000);
        let b: Vec<f64> = a.iter().map(|v| v * 0.5 + 1.0).collect();
        let run = |threads: usize| {
            rayon::ThreadPoolBuilder::new().num_threads(threads).build().unwrap().install(|| (sum(&a), dot(&a, &b), max_abs(&a)))
        };
        let one = run(1);
        for threads in [2, 3, 4] {
            let other = run(threads);
            assert_eq!(one.0.to_bits(), other.0.to_bits());
            assert_eq!(one.1.to_bits(), other.1.to_bits());
            assert_eq!(one.2.to_bits(), other.2.to_bits());
        }
    }

    #[test]
    fn sum_matches_the_chunked_definition() {
        let a = values(10_000);
        let mut expected = 0.0;
        for chunk in a.chunks(CHUNK) {
            expected += chunk.iter().fold(0.0, |acc, v| acc + v);
        }
        assert_eq!(sum(&a).to_bits(), expected.to_bits());
        assert_eq!(sum(&[]), 0.0);
        assert_eq!(dot(&[1.0, 2.0, 3.0], &[4.0, 5.0, 6.0]), 32.0);
        assert_eq!(max_abs(&[1.0, -3.5, 2.0]), 3.5);
    }
}

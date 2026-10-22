//! Fixed-order reductions of per-cell data (RS1 §2 rule 3): cells are cut into [`CHUNK`]-sized chunks, each chunk is folded left
//! to right in f64, then the chunk partials are folded left to right, so a result does not depend on the rayon thread count.
//! The GPU solver reads its per-cell buffers back and reduces them here, so both paths share one reduction.

use rayon::prelude::*;

pub use llull_gpu::reduce::CHUNK;

/// Per-body sums of per-cell vectors: `body[cell]` names the body (any id ≥ `bodies` is skipped).
pub fn sum_per_body(values: &[[f32; 3]], body: &[u16], bodies: usize) -> Vec<[f64; 3]> {
    assert_eq!(values.len(), body.len(), "one body id per cell");
    let partials: Vec<Vec<[f64; 3]>> = values
        .par_chunks(CHUNK)
        .zip(body.par_chunks(CHUNK))
        .map(|(chunk, owners)| {
            let mut sums = vec![[0.0f64; 3]; bodies];
            for (value, owner) in chunk.iter().zip(owners) {
                if let Some(sum) = sums.get_mut(usize::from(*owner)) {
                    for axis in 0..3 {
                        sum[axis] += f64::from(value[axis]);
                    }
                }
            }
            sums
        })
        .collect();
    let mut total = vec![[0.0f64; 3]; bodies];
    for partial in partials {
        for (sum, value) in total.iter_mut().zip(partial) {
            for axis in 0..3 {
                sum[axis] += value[axis];
            }
        }
    }
    total
}

/// Sum of per-cell vectors in the fixed order.
pub fn sum3(values: &[[f32; 3]]) -> [f64; 3] {
    let partials: Vec<[f64; 3]> = values
        .par_chunks(CHUNK)
        .map(|chunk| {
            chunk.iter().fold([0.0f64; 3], |acc, v| [acc[0] + f64::from(v[0]), acc[1] + f64::from(v[1]), acc[2] + f64::from(v[2])])
        })
        .collect();
    partials.iter().fold([0.0f64; 3], |acc, v| [acc[0] + v[0], acc[1] + v[1], acc[2] + v[2]])
}

/// Smallest and largest value over the cells where `valid` holds, each with the lowest cell index that reaches it; None when no
/// cell is valid. Order independent (min / max, ties broken by index).
pub fn extrema(values: &[f32], valid: &[bool]) -> Option<((f32, usize), (f32, usize))> {
    assert_eq!(values.len(), valid.len(), "one validity flag per cell");
    let better_min = |a: (f32, usize), b: (f32, usize)| if b.0 < a.0 || (b.0 == a.0 && b.1 < a.1) { b } else { a };
    let better_max = |a: (f32, usize), b: (f32, usize)| if b.0 > a.0 || (b.0 == a.0 && b.1 < a.1) { b } else { a };
    values
        .par_iter()
        .zip(valid.par_iter())
        .enumerate()
        .filter_map(|(cell, (value, ok))| (*ok && value.is_finite()).then_some(((*value, cell), (*value, cell))))
        .reduce_with(|a, b| (better_min(a.0, b.0), better_max(a.1, b.1)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cells(n: usize) -> (Vec<[f32; 3]>, Vec<u16>) {
        let values = (0..n).map(|i| [((i * 7919) % 1009) as f32 * 1e-3 - 0.4, (i % 13) as f32 * 0.1, 1.0 / (i as f32 + 1.0)]).collect();
        let body = (0..n)
            .map(|i| {
                if i % 5 == 0 {
                    0
                } else if i % 3 == 0 {
                    1
                } else {
                    u16::MAX
                }
            })
            .collect();
        (values, body)
    }

    #[test]
    fn per_body_sums_are_identical_for_any_thread_count_and_match_the_sequential_sum() {
        let (values, body) = cells(50_000);
        let run = |threads: usize| {
            rayon::ThreadPoolBuilder::new()
                .num_threads(threads)
                .build()
                .unwrap()
                .install(|| (sum_per_body(&values, &body, 2), sum3(&values)))
        };
        let one = run(1);
        for threads in [2, 3, 4] {
            let other = run(threads);
            assert_eq!(one.0, other.0);
            assert_eq!(one.1, other.1);
        }
        let mut expected = 0.0f64;
        for (value, owner) in values.iter().zip(&body) {
            if *owner == 1 {
                expected += f64::from(value[0]);
            }
        }
        assert!((one.0[1][0] - expected).abs() < 1e-9);
        assert_eq!(sum_per_body(&[], &[], 0), Vec::<[f64; 3]>::new());
    }

    #[test]
    fn extrema_report_the_lowest_index_on_ties_and_skip_invalid_cells() {
        let values = [3.0, -1.0, 7.0, 7.0, -1.0, f32::NAN];
        let valid = [true, false, true, true, true, true];
        assert_eq!(extrema(&values, &valid), Some(((-1.0, 4), (7.0, 2))));
        assert_eq!(extrema(&values, &[false; 6]), None);
    }
}

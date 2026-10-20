//! Monte Carlo of a tolerance stack-up over independent contributors (03 GDT TECHNICAL_SPEC §5.7 item 7), counter-based and order-fixed.
//!
//! Sample `i` of contributor `j` draws from the Philox4x32-10 block with counter `[i_lo, i_hi, j, 0]` under key `[seed_lo, seed_hi]`:
//! normal = centre + sigma z (Box-Muller on words 0 and 1), uniform = centre + half (2u - 1) (word 0). The samples are cut into fixed
//! blocks of `BLOCK` indices; every block is reduced on its own (Welford) and the block summaries are merged left to right (Chan). The block
//! boundaries and the merge order do not depend on the thread count, so the result is bit-identical for any number of threads.

use crate::expr::Expr;
use crate::philox::{normal, philox4x32_10, uniform};
use rayon::prelude::*;

/// Samples per reduction block (a constant of the algorithm, part of the result's definition: changing it changes the last bits).
pub const BLOCK: u64 = 8192;

pub struct Contributor {
    pub centre: f64,
    /// Sigma (normal) or half-width (uniform).
    pub spread: f64,
    pub normal: bool,
}

pub enum Model {
    Linear(Vec<f64>),
    Expression(Expr),
}

pub struct Config<'a> {
    pub seed: i64,
    pub samples: u64,
    pub contributors: &'a [Contributor],
    pub model: &'a Model,
    pub lower: Option<f64>,
    pub upper: Option<f64>,
}

/// Summary of a set of samples; mergeable.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Summary {
    pub count: u64,
    pub mean: f64,
    pub m2: f64,
    pub min: f64,
    pub max: f64,
    pub below: u64,
    pub above: u64,
    /// Samples whose stack result was not finite (excluded from the statistics).
    pub non_finite: u64,
}

impl Summary {
    const EMPTY: Summary =
        Summary { count: 0, mean: 0.0, m2: 0.0, min: f64::INFINITY, max: f64::NEG_INFINITY, below: 0, above: 0, non_finite: 0 };

    /// Chan et al. pairwise merge: `self` then `other`.
    pub fn merge(self, other: Summary) -> Summary {
        if other.count == 0 {
            return Summary { non_finite: self.non_finite + other.non_finite, ..self };
        }
        if self.count == 0 {
            return Summary { non_finite: self.non_finite + other.non_finite, ..other };
        }
        let (a, b) = (self.count as f64, other.count as f64);
        let total = a + b;
        let delta = other.mean - self.mean;
        Summary {
            count: self.count + other.count,
            mean: self.mean + delta * b / total,
            m2: self.m2 + other.m2 + delta * delta * a * b / total,
            min: self.min.min(other.min),
            max: self.max.max(other.max),
            below: self.below + other.below,
            above: self.above + other.above,
            non_finite: self.non_finite + other.non_finite,
        }
    }

    /// Unbiased standard deviation (0 below two samples).
    pub fn std(&self) -> f64 {
        if self.count > 1 {
            (self.m2 / (self.count - 1) as f64).sqrt()
        } else {
            0.0
        }
    }
}

fn evaluate(model: &Model, values: &[f64]) -> f64 {
    match model {
        Model::Linear(sensitivities) => sensitivities.iter().zip(values).map(|(a, v)| a * v).sum(),
        Model::Expression(expr) => expr.eval(values),
    }
}

/// The values of every contributor for sample `index`.
fn draw(config: &Config<'_>, index: u64, values: &mut [f64]) {
    let key = [config.seed as u64 as u32, ((config.seed as u64) >> 32) as u32];
    for (j, contributor) in config.contributors.iter().enumerate() {
        let words = philox4x32_10([index as u32, (index >> 32) as u32, j as u32, 0], key);
        let offset = if contributor.normal { normal(words[0], words[1]) } else { 2.0 * uniform(words[0]) - 1.0 };
        values[j] = contributor.centre + contributor.spread * offset;
    }
}

fn reduce_block(config: &Config<'_>, block: u64) -> Summary {
    let first = block * BLOCK;
    let last = (first + BLOCK).min(config.samples);
    let mut values = vec![0.0; config.contributors.len()];
    let mut summary = Summary::EMPTY;
    for index in first..last {
        draw(config, index, &mut values);
        let y = evaluate(config.model, &values);
        if !y.is_finite() {
            summary.non_finite += 1;
            continue;
        }
        summary.count += 1;
        let delta = y - summary.mean;
        summary.mean += delta / summary.count as f64;
        summary.m2 += delta * (y - summary.mean);
        summary.min = summary.min.min(y);
        summary.max = summary.max.max(y);
        if config.lower.is_some_and(|limit| y < limit) {
            summary.below += 1;
        }
        if config.upper.is_some_and(|limit| y > limit) {
            summary.above += 1;
        }
    }
    summary
}

/// Runs the whole simulation on the rayon pool in scope. Deterministic in (seed, samples, inputs) for any thread count.
pub fn simulate(config: &Config<'_>) -> Summary {
    let blocks = config.samples.div_ceil(BLOCK);
    let summaries: Vec<Summary> = (0..blocks).into_par_iter().map(|block| reduce_block(config, block)).collect();
    summaries.into_iter().fold(Summary::EMPTY, Summary::merge)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stack(distribution_normal: bool) -> (Vec<Contributor>, Model) {
        let contributors = (0..4)
            .map(|i| Contributor { centre: 10.0 + f64::from(i), spread: 0.1 * f64::from(i + 1), normal: distribution_normal })
            .collect();
        (contributors, Model::Linear(vec![1.0, -1.0, 1.0, 1.0]))
    }

    fn config<'a>(contributors: &'a [Contributor], model: &'a Model, samples: u64) -> Config<'a> {
        Config { seed: 12345, samples, contributors, model, lower: Some(10.0), upper: Some(14.0) }
    }

    fn with_threads(threads: usize, config: &Config<'_>) -> Summary {
        rayon::ThreadPoolBuilder::new().num_threads(threads).build().unwrap().install(|| simulate(config))
    }

    #[test]
    fn same_seed_gives_identical_bits_on_one_and_many_threads() {
        let (contributors, model) = stack(true);
        let config = config(&contributors, &model, 100_003);
        let one = with_threads(1, &config);
        for threads in [2, 3, 8] {
            let many = with_threads(threads, &config);
            assert_eq!(one.mean.to_bits(), many.mean.to_bits(), "{threads} threads");
            assert_eq!(one.m2.to_bits(), many.m2.to_bits());
            assert_eq!(
                (one.min.to_bits(), one.max.to_bits(), one.below, one.above),
                (many.min.to_bits(), many.max.to_bits(), many.below, many.above)
            );
        }
        assert_eq!(one.count, 100_003);
    }

    #[test]
    fn another_seed_gives_another_stream() {
        let (contributors, model) = stack(true);
        let a = with_threads(1, &config(&contributors, &model, 5_000));
        let b = with_threads(1, &Config { seed: 54321, ..config(&contributors, &model, 5_000) });
        assert_ne!(a.mean.to_bits(), b.mean.to_bits());
    }

    #[test]
    fn normal_stack_matches_the_analytic_mean_and_sigma_within_five_sigma() {
        let (contributors, model) = stack(true);
        let n = 2_000_000u64;
        let summary = with_threads(4, &config(&contributors, &model, n));
        // y = x0 - x1 + x2 + x3: mean 10 - 11 + 12 + 13 = 24, sigma = sqrt(0.1^2 + 0.2^2 + 0.3^2 + 0.4^2)
        let sigma = (0.01f64 + 0.04 + 0.09 + 0.16).sqrt();
        assert!((summary.mean - 24.0).abs() < 5.0 * sigma / (n as f64).sqrt(), "{}", summary.mean);
        assert!((summary.std() - sigma).abs() < 5.0 * sigma / (2.0 * n as f64).sqrt(), "{}", summary.std());
    }

    #[test]
    fn uniform_stack_stays_inside_the_worst_case_and_has_the_uniform_variance() {
        let (contributors, model) = stack(false);
        let n = 1_000_000u64;
        let summary = with_threads(2, &config(&contributors, &model, n));
        let half = 0.1 + 0.2 + 0.3 + 0.4;
        assert!(summary.min >= 24.0 - half && summary.max <= 24.0 + half);
        let sigma = ((0.01f64 + 0.04 + 0.09 + 0.16) / 3.0).sqrt();
        assert!((summary.std() - sigma).abs() < 5.0 * sigma / (2.0 * n as f64).sqrt());
    }

    #[test]
    fn counts_samples_beyond_the_limits_and_merges_blocks_like_one_pass() {
        let contributors = [Contributor { centre: 0.0, spread: 1.0, normal: true }];
        let model = Model::Linear(vec![1.0]);
        let n = BLOCK * 3 + 17;
        let config = Config { seed: -7, samples: n, contributors: &contributors, model: &model, lower: Some(-1.0), upper: Some(1.0) };
        let blocked = with_threads(3, &config);
        // one pass over the same indices (a single Welford run): equal up to rounding of the merge
        let mut values = [0.0];
        let (mut mean, mut m2) = (0.0, 0.0);
        let (mut below, mut above) = (0u64, 0u64);
        for index in 0..n {
            draw(&config, index, &mut values);
            let y = values[0];
            let delta = y - mean;
            mean += delta / (index + 1) as f64;
            m2 += delta * (y - mean);
            below += u64::from(y < -1.0);
            above += u64::from(y > 1.0);
        }
        assert_eq!((blocked.below, blocked.above), (below, above));
        assert!((blocked.mean - mean).abs() < 1e-12 && (blocked.m2 - m2).abs() < 1e-8 * m2);
        // P(|z| > 1) = 0.3173 split in two tails, within 5 sigma of the binomial
        let p = blocked.below as f64 / n as f64;
        assert!((p - 0.158_655).abs() < 5.0 * (p * (1.0 - p) / n as f64).sqrt() + 1e-3);
    }

    #[test]
    fn non_finite_results_are_counted_and_left_out() {
        let contributors = [Contributor { centre: 1.0, spread: 0.0, normal: false }];
        let model = Model::Expression(Expr::Div(Box::new(Expr::Num(1.0)), Box::new(Expr::Num(0.0))));
        let summary =
            with_threads(1, &Config { seed: 1, samples: 10, contributors: &contributors, model: &model, lower: None, upper: None });
        assert_eq!((summary.count, summary.non_finite), (0, 10));
    }
}

//! Optimality-criteria update of TECHNICAL_SPEC §5.2 (top88): bisection on the volume multiplier λ from l1 = 0, l2 = 1e9
//! until (l2 − l1)/(l1 + l2) ≤ `tolerance` (1e-3), with the move limit and the [0, 1] bounds, written exactly as top88's
//! `max(0, max(x − move, min(1, min(x + move, x·sqrt(−dc/dv/λ)))))`. Elements whose design is pinned (keep-in 1, keep-out 0,
//! inactive 0) keep their value. A non-negative `−dc/dv` is assumed; a positive dc is treated as 0 (never NaN).

use llull_gpu::reduce::sum;
use llull_voxfe::MIN_LEN;
use rayon::prelude::*;

/// What the optimiser may do with one element.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Design {
    /// A design variable.
    Free,
    /// Pinned to this value (keep-in 1, keep-out 0, inactive 0).
    Pinned(f64),
}

/// One OC step: the new design and its physical field.
pub struct Step {
    pub x: Vec<f64>,
    pub x_phys: Vec<f64>,
    pub lambda: f64,
}

/// Move limit, bisection tolerance and the volume target `Σ xPhys ≤ target` (volume fraction × active voxels).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Limits {
    pub move_limit: f64,
    pub tolerance: f64,
    pub target: f64,
}

/// Below this multiplier the volume constraint counts as inactive: every element has moved by its own sign (positive
/// sensitivities, e.g. self-weight) and the bisection would otherwise never close on `l1 = 0`.
const LAMBDA_FLOOR: f64 = 1e-40;

/// Bisection for `Σ physical(x_new) ≤ target` (`physical` maps a design to xPhys, including filter and pinned values).
pub fn update(
    x: &[f64],
    dc: &[f64],
    dv: &[f64],
    design: &[Design],
    limits: Limits,
    physical: &(dyn Fn(&[f64]) -> Vec<f64> + Sync),
) -> Step {
    let Limits { move_limit, tolerance, target } = limits;
    let (mut l1, mut l2) = (0.0f64, 1e9f64);
    loop {
        let lmid = 0.5 * (l2 + l1);
        let x_new: Vec<f64> = (0..x.len())
            .into_par_iter()
            .with_min_len(MIN_LEN)
            .map(|e| match design[e] {
                Design::Pinned(value) => value,
                Design::Free => {
                    let ratio = (-dc[e] / dv[e] / lmid).max(0.0);
                    f64::max(0.0, f64::max(x[e] - move_limit, f64::min(1.0, f64::min(x[e] + move_limit, x[e] * ratio.sqrt()))))
                }
            })
            .collect();
        let x_phys = physical(&x_new);
        if sum(&x_phys) > target {
            l1 = lmid;
        } else {
            l2 = lmid;
        }
        if (l2 - l1) / (l1 + l2) <= tolerance || l2 < LAMBDA_FLOOR {
            return Step { x: x_new, x_phys, lambda: lmid };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// VC-TOP-03: minimise Σ a_i / x_i subject to Σ x_i = 2 (p = 1, no filter): x* = V √a_i / Σ √a_j = [0.2, 0.4, 0.6, 0.8].
    fn separable(tolerance: f64) -> (Vec<f64>, f64) {
        let a = [1.0, 4.0, 9.0, 16.0];
        let mut x = vec![0.5; 4];
        let identity = |x: &[f64]| x.to_vec();
        for _ in 0..50 {
            let dc: Vec<f64> = a.iter().zip(&x).map(|(a, x)| -a / (x * x)).collect();
            let step = update(&x, &dc, &[1.0; 4], &[Design::Free; 4], Limits { move_limit: 0.2, tolerance, target: 2.0 }, &identity);
            let change = step.x.iter().zip(&x).map(|(n, o)| (n - o).abs()).fold(0.0, f64::max);
            x = step.x;
            if change < 1e-12 {
                break;
            }
        }
        let objective = a.iter().zip(&x).map(|(a, x)| a / x).sum();
        (x, objective)
    }

    #[test]
    fn separable_problem_reaches_the_lagrange_optimum_of_vc_top_03() {
        let (x, objective) = separable(1e-12);
        for (value, expected) in x.iter().zip([0.2, 0.4, 0.6, 0.8]) {
            assert!((value - expected).abs() < 1e-6, "{x:?}");
        }
        assert!((objective - 50.0).abs() / 50.0 < 1e-6);
        // the production bisection tolerance (1e-3 on λ) lands within √(1e-3) / 2 relative of the optimum
        let (x, _) = separable(1e-3);
        for (value, expected) in x.iter().zip([0.2, 0.4, 0.6, 0.8]) {
            assert!((value - expected).abs() / expected < 6e-4, "{x:?}");
        }
    }

    /// Positive sensitivities everywhere (self-weight): no multiplier reaches the volume target, every element moves down by
    /// `move` and the bisection ends instead of closing on λ = 0 forever.
    #[test]
    fn positive_sensitivities_end_the_bisection_with_an_inactive_constraint() {
        let x = [0.5, 0.6];
        let step = update(
            &x,
            &[1.0, 2.0],
            &[1.0; 2],
            &[Design::Free; 2],
            Limits { move_limit: 0.2, tolerance: 1e-3, target: 1.5 },
            &|x: &[f64]| x.to_vec(),
        );
        assert!((step.x[0] - 0.3).abs() < 1e-15 && (step.x[1] - 0.4).abs() < 1e-15, "{:?}", step.x);
        assert!(step.lambda < 1e-39);
    }

    #[test]
    fn pinned_elements_keep_their_value_and_moves_are_limited() {
        let x = [0.5, 0.5, 0.5];
        let design = [Design::Free, Design::Pinned(1.0), Design::Pinned(0.0)];
        let step = update(
            &x,
            &[-100.0, -1.0, -1.0],
            &[1.0; 3],
            &design,
            Limits { move_limit: 0.2, tolerance: 1e-3, target: 1.5 },
            &|x: &[f64]| x.to_vec(),
        );
        assert_eq!(step.x[1], 1.0);
        assert_eq!(step.x[2], 0.0);
        assert!((step.x[0] - 0.5).abs() <= 0.2 + 1e-15);
    }
}

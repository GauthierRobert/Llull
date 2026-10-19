//! Levenberg–Marquardt on a residual vector with a central-difference Jacobian (Marquardt 1963; damping λ ×/÷ 10), and the parameter
//! covariance σ̂²(JᵀJ)⁻¹ with σ̂² = Σr²/(n − p) at the solution (TECHNICAL_SPEC §5.5). Sequential and deterministic.

use crate::linalg::{inverse, solve};

/// Result of a least-squares run.
#[derive(Debug, Clone)]
pub struct LmResult {
    pub params: Vec<f64>,
    pub residuals: Vec<f64>,
    pub iterations: u32,
    /// Σr² / (n − p).
    pub sigma2: f64,
    /// σ̂²(JᵀJ)⁻¹ (None when JᵀJ is singular or n ≤ p).
    pub covariance: Option<Vec<Vec<f64>>>,
    /// (JᵀJ)⁻¹ (the covariance per unit variance, for a CRLB at a given σ).
    pub normal_inverse: Option<Vec<Vec<f64>>>,
}

fn sum_squares(r: &[f64]) -> f64 {
    r.iter().map(|v| v * v).sum()
}

fn jacobian(f: &dyn Fn(&[f64]) -> Vec<f64>, x: &[f64]) -> Vec<Vec<f64>> {
    let columns: Vec<Vec<f64>> = (0..x.len())
        .map(|j| {
            let h = 1e-7 * x[j].abs().max(1e-3);
            let mut plus = x.to_vec();
            let mut minus = x.to_vec();
            plus[j] += h;
            minus[j] -= h;
            let (a, b) = (f(&plus), f(&minus));
            a.iter().zip(&b).map(|(p, m)| (p - m) / (2.0 * h)).collect()
        })
        .collect();
    let n = columns.first().map_or(0, Vec::len);
    (0..n).map(|i| columns.iter().map(|c| c[i]).collect()).collect()
}

fn normal_equations(j: &[Vec<f64>], r: &[f64], p: usize) -> (Vec<Vec<f64>>, Vec<f64>) {
    let mut jtj = vec![vec![0.0; p]; p];
    let mut jtr = vec![0.0; p];
    for (row, ri) in j.iter().zip(r) {
        for a in 0..p {
            jtr[a] += row[a] * ri;
            for b in 0..p {
                jtj[a][b] += row[a] * row[b];
            }
        }
    }
    (jtj, jtr)
}

/// Minimises Σ f(x)² from `start`; stops on a relative cost change below 1e-15, a step below 1e-14 or `max_iterations`.
pub fn minimise(f: &dyn Fn(&[f64]) -> Vec<f64>, start: &[f64], max_iterations: u32) -> LmResult {
    let p = start.len();
    let mut x = start.to_vec();
    let mut r = f(&x);
    let mut cost = sum_squares(&r);
    let mut lambda = 1e-3;
    let mut iterations = 0;
    for _ in 0..max_iterations {
        iterations += 1;
        let j = jacobian(f, &x);
        let (jtj, jtr) = normal_equations(&j, &r, p);
        let mut improved = false;
        for _ in 0..30 {
            let mut damped = jtj.clone();
            for (a, row) in damped.iter_mut().enumerate() {
                row[a] += lambda * jtj[a][a].max(1e-12);
            }
            let Some(step) = solve(damped, jtr.iter().map(|v| -v).collect()) else {
                lambda *= 10.0;
                continue;
            };
            let candidate: Vec<f64> = x.iter().zip(&step).map(|(a, b)| a + b).collect();
            let r2 = f(&candidate);
            let c2 = sum_squares(&r2);
            if c2.is_finite() && c2 <= cost {
                let step_size = step.iter().map(|s| s * s).sum::<f64>().sqrt();
                let relative = (cost - c2) / cost.max(1e-300);
                x = candidate;
                r = r2;
                cost = c2;
                lambda = (lambda / 10.0).max(1e-12);
                improved = relative > 1e-15 && step_size > 1e-14;
                break;
            }
            lambda *= 10.0;
        }
        if !improved {
            break;
        }
    }
    let n = r.len();
    let sigma2 = if n > p { cost / (n - p) as f64 } else { 0.0 };
    let j = jacobian(f, &x);
    let (jtj, _) = normal_equations(&j, &r, p);
    let normal_inverse = if n > p { inverse(&jtj) } else { None };
    let covariance = normal_inverse.as_ref().map(|m| m.iter().map(|row| row.iter().map(|v| v * sigma2).collect()).collect());
    LmResult { params: x, residuals: r, iterations, sigma2, covariance, normal_inverse }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fits_a_line_exactly_and_reports_its_covariance() {
        let xs: Vec<f64> = (0..20).map(f64::from).collect();
        let ys: Vec<f64> = xs.iter().map(|x| 2.0 * x + 1.0 + if (*x as i32) % 2 == 0 { 0.1 } else { -0.1 }).collect();
        let f = |q: &[f64]| xs.iter().zip(&ys).map(|(x, y)| q[0] * x + q[1] - y).collect::<Vec<f64>>();
        let fit = minimise(&f, &[0.0, 0.0], 50);
        // Exact least squares: slope 2 + cov(x, e) / var(x) = 2 − 0.05 / 33.25, intercept 1 + 9.5 · 0.05 / 33.25.
        assert!((fit.params[0] - (2.0 - 0.05 / 33.25)).abs() < 1e-9, "{:?}", fit.params);
        assert!((fit.params[1] - (1.0 + 9.5 * 0.05 / 33.25)).abs() < 1e-9, "{:?}", fit.params);
        let cov = fit.covariance.unwrap();
        assert!(cov[0][0] > 0.0 && cov[1][1] > cov[0][0]);
    }
}

//! 2D circle fit in a slice (TECHNICAL_SPEC §5.5): RANSAC from 3 points, Kåsa algebraic fit on the inliers, then LM on the geometric
//! residual |x − c| − r with its covariance. `detect` peels circles one after another (inliers removed), largest support first.

use super::{ransac_iterations, rms, std_of};
use crate::kdtree::Rng;
use crate::linalg::solve;
use crate::lm::minimise;
use serde::Serialize;

pub type Vec2 = [f64; 2];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CircleFit {
    pub centre: Vec2,
    pub radius: f64,
    pub inliers: usize,
    pub rms: f64,
    /// Standard deviation of the radius (σ̂²(JᵀJ)⁻¹).
    pub radius_std: Option<f64>,
    pub centre_std: Option<f64>,
}

fn circumcircle(a: &Vec2, b: &Vec2, c: &Vec2) -> Option<(Vec2, f64)> {
    let d = 2.0 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if d.abs() < 1e-15 {
        return None;
    }
    let (a2, b2, c2) = (a[0] * a[0] + a[1] * a[1], b[0] * b[0] + b[1] * b[1], c[0] * c[0] + c[1] * c[1]);
    let x = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
    let y = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
    Some(([x, y], ((a[0] - x).powi(2) + (a[1] - y).powi(2)).sqrt()))
}

fn distance(p: &Vec2, c: &Vec2, r: f64) -> f64 {
    ((p[0] - c[0]).powi(2) + (p[1] - c[1]).powi(2)).sqrt() - r
}

/// Kåsa (1976) algebraic fit x² + y² = 2a x + 2b y + k, then geometric LM.
pub fn least_squares(points: &[Vec2]) -> Option<CircleFit> {
    if points.len() < 3 {
        return None;
    }
    let mut ata = vec![vec![0.0; 3]; 3];
    let mut atb = vec![0.0; 3];
    for p in points {
        let row = [2.0 * p[0], 2.0 * p[1], 1.0];
        let b = p[0] * p[0] + p[1] * p[1];
        for i in 0..3 {
            atb[i] += row[i] * b;
            for j in 0..3 {
                ata[i][j] += row[i] * row[j];
            }
        }
    }
    let x = solve(ata, atb)?;
    let r0 = (x[2] + x[0] * x[0] + x[1] * x[1]).max(0.0).sqrt();
    let f = |q: &[f64]| points.iter().map(|p| distance(p, &[q[0], q[1]], q[2])).collect::<Vec<f64>>();
    let lm = minimise(&f, &[x[0], x[1], r0], 100);
    let centre_std = match (std_of(&lm.covariance, 0), std_of(&lm.covariance, 1)) {
        (Some(a), Some(b)) => Some((a * a + b * b).sqrt()),
        _ => None,
    };
    Some(CircleFit {
        centre: [lm.params[0], lm.params[1]],
        radius: lm.params[2],
        inliers: points.len(),
        rms: rms(&lm.residuals),
        radius_std: std_of(&lm.covariance, 2),
        centre_std,
    })
}

/// Circles in `points` with at least `min_support` inliers within `band`, radius in [min_r, max_r], at most `max_circles`.
pub fn detect(points: &[Vec2], band: f64, min_support: usize, (min_r, max_r): (f64, f64), max_circles: usize, seed: u64) -> Vec<CircleFit> {
    let mut remaining: Vec<Vec2> = points.to_vec();
    let mut found = Vec::new();
    let mut rng = Rng::new(seed);
    while found.len() < max_circles && remaining.len() >= min_support.max(3) {
        let n = remaining.len();
        let mut best: Option<(usize, Vec2, f64)> = None;
        let mut budget = ransac_iterations(0.0, 3);
        let mut iterations = 0;
        while iterations < budget {
            iterations += 1;
            let (a, b, c) = (remaining[rng.below(n)], remaining[rng.below(n)], remaining[rng.below(n)]);
            let Some((centre, r)) = circumcircle(&a, &b, &c) else { continue };
            if !(r >= min_r && r <= max_r) {
                continue;
            }
            let count = remaining.iter().filter(|p| distance(p, &centre, r).abs() < band).count();
            if best.is_none_or(|(k, _, _)| count > k) {
                best = Some((count, centre, r));
                budget = ransac_iterations(count as f64 / n as f64, 3);
            }
        }
        let Some((count, centre, r)) = best.filter(|b| b.0 >= min_support) else { break };
        let _ = count;
        let inliers: Vec<Vec2> = remaining.iter().filter(|p| distance(p, &centre, r).abs() < band).copied().collect();
        let Some(fit) = least_squares(&inliers) else { break };
        remaining.retain(|p| distance(p, &fit.centre, fit.radius).abs() >= band);
        found.push(fit);
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_two_circles() {
        let mut points: Vec<Vec2> =
            (0..60).map(|i| f64::from(i) * 0.1).map(|t| [1.0 + 0.5 * libm::cos(t), 2.0 + 0.5 * libm::sin(t)]).collect();
        points.extend((0..40).map(|i| f64::from(i) * 0.15).map(|t| [5.0 + 0.2 * libm::cos(t), 0.2 * libm::sin(t)]));
        let found = detect(&points, 0.01, 10, (0.05, 2.0), 5, 1);
        assert_eq!(found.len(), 2);
        assert!((found[0].radius - 0.5).abs() < 1e-9 && (found[1].radius - 0.2).abs() < 1e-9);
    }
}

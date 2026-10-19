//! Primitive fits (TECHNICAL_SPEC §5.5, FR-SCN-12): seeded RANSAC (Schnabel, Wahl & Klein 2007) on oriented points, then Levenberg–Marquardt
//! on the orthogonal residual (Lukács, Martin & Marshall 1998) with two passes of inlier re-selection, the covariance σ̂²(JᵀJ)⁻¹ and the
//! CRLB at σ (Kay 1993, ch. 3).

pub mod circle;
pub mod cylinder;
pub mod plane;
pub mod sphere;

use crate::cloud::Vec3;
use crate::error::CloudError;
use crate::kdtree::{median_spacing, KdTree};
use serde::{Deserialize, Serialize};

/// RANSAC success probability of the iteration count N = ⌈log(1 − p) / log(1 − wᵐ)⌉.
pub const RANSAC_CONFIDENCE: f64 = 0.999;
/// Iteration cap of every RANSAC loop.
pub const RANSAC_MAX_ITERATIONS: usize = 10_000;
/// A model needs at least this inlier fraction (SCN_FIT_NO_MODEL below it).
pub const MIN_INLIER_FRACTION: f64 = 0.2;
/// Angular coverage below which a cylinder / sphere radius is ill-conditioned (SCN_FIT_LOW_COVERAGE, unverified).
pub const LOW_COVERAGE_DEG: f64 = 60.0;

/// Thresholds of a fit (named, in metres / degrees).
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FitSettings {
    /// Noise σ of the scanner (when known): inlier band 3σ, RMS gate 3σ.
    pub noise_sigma: Option<f64>,
    /// Explicit inlier band; overrides 3σ / 2.5 × spacing.
    pub distance_threshold: Option<f64>,
    pub normal_threshold_deg: f64,
    pub seed: u64,
    pub min_radius: f64,
    pub max_radius: f64,
}

impl Default for FitSettings {
    fn default() -> FitSettings {
        FitSettings { noise_sigma: None, distance_threshold: None, normal_threshold_deg: 20.0, seed: 1, min_radius: 0.005, max_radius: 2.0 }
    }
}

/// Resolved inlier band and its source.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Threshold {
    pub value: f64,
    pub source: &'static str,
    pub spacing: f64,
}

impl FitSettings {
    pub fn threshold(&self, tree: &KdTree) -> Threshold {
        let spacing = median_spacing(tree, 2000);
        match (self.distance_threshold, self.noise_sigma) {
            (Some(d), _) => Threshold { value: d, source: "distanceThreshold", spacing },
            (None, Some(s)) => Threshold { value: 3.0 * s, source: "3 x noiseSigma", spacing },
            (None, None) => Threshold { value: 2.5 * spacing, source: "2.5 x median spacing (defaulted)", spacing },
        }
    }
}

/// N = ⌈log(1 − p) / log(1 − wᵐ)⌉ capped at RANSAC_MAX_ITERATIONS.
pub fn ransac_iterations(inlier_fraction: f64, sample_size: i32) -> usize {
    let wm = inlier_fraction.clamp(0.0, 1.0).powi(sample_size);
    if wm <= 0.0 {
        return RANSAC_MAX_ITERATIONS;
    }
    if wm >= 1.0 {
        return 1;
    }
    let n = libm::log(1.0 - RANSAC_CONFIDENCE) / libm::log(1.0 - wm);
    (n.ceil() as usize).clamp(1, RANSAC_MAX_ITERATIONS)
}

pub fn too_few(points: usize, needed: usize, what: &str) -> CloudError {
    CloudError::new("SCN_FIT_TOO_FEW_POINTS", format!("{points} point(s) in the region; a {what} fit needs at least {needed}"))
}

pub fn no_model(what: &str) -> CloudError {
    CloudError::new("SCN_FIT_NO_MODEL", format!("RANSAC found no {what} with at least {} % inliers", MIN_INLIER_FRACTION * 100.0))
}

/// Standard deviations from a covariance diagonal.
pub fn std_of(covariance: &Option<Vec<Vec<f64>>>, index: usize) -> Option<f64> {
    covariance.as_ref().map(|c| c[index][index].max(0.0).sqrt())
}

/// A fit warning.
#[derive(Debug, Clone, Serialize)]
pub struct FitWarning {
    pub code: &'static str,
    pub message: String,
}

/// Coverage of angles (radians) on a circle: 360° minus the largest gap, in degrees.
pub fn angular_coverage_deg(angles: &mut [f64]) -> f64 {
    if angles.len() < 2 {
        return 0.0;
    }
    angles.sort_by(f64::total_cmp);
    let mut largest = angles[0] + std::f64::consts::TAU - angles[angles.len() - 1];
    for pair in angles.windows(2) {
        largest = largest.max(pair[1] - pair[0]);
    }
    (std::f64::consts::TAU - largest).to_degrees()
}

/// Root mean square of residuals.
pub fn rms(residuals: &[f64]) -> f64 {
    (residuals.iter().map(|r| r * r).sum::<f64>() / residuals.len().max(1) as f64).sqrt()
}

/// Indices of `points` within `band` of a model.
pub fn inliers_of(points: &[Vec3], band: f64, distance: impl Fn(&Vec3) -> f64) -> Vec<usize> {
    (0..points.len()).filter(|&i| distance(&points[i]).abs() < band).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iteration_count_follows_the_formula() {
        assert_eq!(ransac_iterations(0.0, 2), RANSAC_MAX_ITERATIONS);
        assert_eq!(ransac_iterations(1.0, 2), 1);
        assert_eq!(ransac_iterations(0.5, 2), 25);
        let mut quarter = vec![0.0, 0.5, 1.0, 1.5];
        assert!((angular_coverage_deg(&mut quarter) - 1.5f64.to_degrees()).abs() < 1e-9);
    }
}

//! Sphere fit: RANSAC from two oriented points (centre = closest approach of the two normal lines), then the algebraic + LM fit of
//! `register::fit_sphere` on the inliers (two passes) with its covariance; coverage = twice the largest angle from the mean direction.

use super::{no_model, ransac_iterations, rms, std_of, too_few, FitSettings, FitWarning, Threshold, LOW_COVERAGE_DEG, MIN_INLIER_FRACTION};
use crate::cloud::Vec3;
use crate::error::CloudResult;
use crate::kdtree::{KdTree, Rng};
use crate::linalg::{add, dot, mean, norm, scale, sub, unit};
use crate::lm::minimise;
use crate::normals::pca_normals;
use serde::Serialize;

pub const MIN_POINTS: usize = 10;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SphereFit {
    pub centre: Vec3,
    pub radius: f64,
    pub inliers: usize,
    pub points_in_region: usize,
    pub rms: f64,
    pub coverage_deg: f64,
    /// σ̂²(JᵀJ)⁻¹ over (cx, cy, cz, r).
    pub covariance: Option<Vec<Vec<f64>>>,
    pub std: Option<SphereStd>,
    pub threshold: Threshold,
    pub ransac_iterations: usize,
    pub warnings: Vec<FitWarning>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SphereStd {
    pub centre: f64,
    pub radius: f64,
}

/// Closest approach of the lines p1 + s n1 and p2 + t n2: the midpoint, or None for parallel lines.
fn closest_approach(p1: &Vec3, n1: &Vec3, p2: &Vec3, n2: &Vec3) -> Option<Vec3> {
    let d = sub(p1, p2);
    let (a, b, c) = (dot(n1, n1), dot(n1, n2), dot(n2, n2));
    let (e, f) = (dot(n1, &d), dot(n2, &d));
    let den = a * c - b * b;
    if den.abs() < 1e-9 {
        return None;
    }
    let s = (b * f - c * e) / den;
    let t = (a * f - b * e) / den;
    Some(scale(&add(&add(p1, &scale(n1, s)), &add(p2, &scale(n2, t))), 0.5))
}

/// @failure < 10 points -> SCN_FIT_TOO_FEW_POINTS; no sphere with ≥ 20 % inliers -> SCN_FIT_NO_MODEL
pub fn fit(points: &[Vec3], settings: &FitSettings) -> CloudResult<SphereFit> {
    if points.len() < MIN_POINTS {
        return Err(too_few(points.len(), MIN_POINTS, "sphere"));
    }
    let tree = KdTree::build(points);
    let threshold = settings.threshold(&tree);
    let normals: Vec<Vec3> = pca_normals(&tree, 20, &mean(points)).into_iter().map(|(n, _)| n).collect();
    let cos_alpha = libm::cos(settings.normal_threshold_deg.to_radians());
    let mut rng = Rng::new(settings.seed);
    let n = points.len();
    let mut best: Option<(usize, Vec3, f64)> = None;
    let mut budget = ransac_iterations(0.0, 2);
    let mut iterations = 0;
    while iterations < budget {
        iterations += 1;
        let (i, j) = (rng.below(n), rng.below(n));
        if i == j {
            continue;
        }
        let Some(c) = closest_approach(&points[i], &normals[i], &points[j], &normals[j]) else { continue };
        let r = (norm(&sub(&points[i], &c)) + norm(&sub(&points[j], &c))) / 2.0;
        if !(r > settings.min_radius && r < settings.max_radius) {
            continue;
        }
        let count = (0..n)
            .filter(|&k| {
                let v = sub(&points[k], &c);
                (norm(&v) - r).abs() < threshold.value && unit(&v).is_some_and(|u| dot(&u, &normals[k]).abs() > cos_alpha)
            })
            .count();
        if best.is_none_or(|(k, _, _)| count > k) {
            best = Some((count, c, r));
            budget = ransac_iterations(count as f64 / n as f64, 2);
        }
    }
    let Some((count, mut centre, mut radius)) = best else { return Err(no_model("sphere")) };
    if (count as f64) < MIN_INLIER_FRACTION * n as f64 {
        return Err(no_model("sphere"));
    }
    let mut band = threshold.value;
    let mut last = None;
    let mut previous_count = 0;
    for pass in 0..super::cylinder::MAX_REFINE_PASSES {
        let inliers: Vec<Vec3> = points.iter().filter(|p| (norm(&sub(p, &centre)) - radius).abs() < band).copied().collect();
        if inliers.len() < MIN_POINTS {
            return Err(no_model("sphere"));
        }
        if pass >= 2 && inliers.len() == previous_count {
            break;
        }
        previous_count = inliers.len();
        let f = |q: &[f64]| inliers.iter().map(|p| norm(&sub(p, &[q[0], q[1], q[2]])) - q[3]).collect::<Vec<f64>>();
        let lm = minimise(&f, &[centre[0], centre[1], centre[2], radius], 100);
        centre = [lm.params[0], lm.params[1], lm.params[2]];
        radius = lm.params[3];
        band = settings.noise_sigma.map_or(threshold.value.min(3.0 * lm.sigma2.sqrt()).max(1e-6), |s| 3.0 * s);
        last = Some((inliers, lm));
    }
    let (inliers, lm) = last.ok_or_else(|| no_model("sphere"))?;
    let directions: Vec<Vec3> = inliers.iter().filter_map(|p| unit(&sub(p, &centre))).collect();
    let axis = unit(&mean(&directions));
    let coverage = axis
        .map_or(360.0, |a| 2.0 * directions.iter().map(|d| libm::acos(dot(d, &a).clamp(-1.0, 1.0))).fold(0.0, f64::max).to_degrees())
        .min(360.0);
    let mut warnings = Vec::new();
    if coverage < LOW_COVERAGE_DEG {
        warnings.push(FitWarning {
            code: "SCN_FIT_LOW_COVERAGE",
            message: format!("angular coverage {coverage:.1} deg below {LOW_COVERAGE_DEG} deg"),
        });
    }
    let std = match (std_of(&lm.covariance, 0), std_of(&lm.covariance, 1), std_of(&lm.covariance, 2), std_of(&lm.covariance, 3)) {
        (Some(a), Some(b), Some(c), Some(r)) => Some(SphereStd { centre: (a * a + b * b + c * c).sqrt(), radius: r }),
        _ => None,
    };
    Ok(SphereFit {
        centre,
        radius,
        inliers: inliers.len(),
        points_in_region: n,
        rms: rms(&lm.residuals),
        coverage_deg: coverage,
        covariance: lm.covariance,
        std,
        threshold,
        ransac_iterations: iterations,
        warnings,
    })
}

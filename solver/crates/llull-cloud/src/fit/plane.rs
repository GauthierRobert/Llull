//! Plane fit: RANSAC from 3 points, PCA on the inliers (smallest-eigenvalue normal), then LM on (2 tilts, offset) for the covariance.

use super::{no_model, ransac_iterations, rms, std_of, too_few, FitSettings, FitWarning, Threshold, MIN_INLIER_FRACTION};
use crate::cloud::Vec3;
use crate::error::CloudResult;
use crate::kdtree::{KdTree, Rng};
use crate::linalg::{add, column, cross, dot, frame, jacobi_eigen, mean, scale, scatter, sub, unit};
use crate::lm::minimise;
use serde::Serialize;

pub const MIN_POINTS: usize = 10;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaneFit {
    pub point: Vec3,
    pub normal: Vec3,
    pub inliers: usize,
    pub points_in_region: usize,
    pub rms: f64,
    /// σ̂²(JᵀJ)⁻¹ over (tilt u, tilt w, offset).
    pub covariance: Option<Vec<Vec<f64>>>,
    pub std: Option<PlaneStd>,
    pub threshold: Threshold,
    pub ransac_iterations: usize,
    pub warnings: Vec<FitWarning>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaneStd {
    pub normal_angle_deg: f64,
    pub offset: f64,
}

/// Least-squares plane of `points`: (centroid, unit normal).
pub fn pca_plane(points: &[Vec3]) -> (Vec3, Vec3) {
    let centre = mean(points);
    let (_, vectors) = jacobi_eigen(scatter(points, &centre));
    (centre, column(&vectors, 0))
}

/// @failure < 10 points -> SCN_FIT_TOO_FEW_POINTS; no plane with ≥ 20 % inliers -> SCN_FIT_NO_MODEL
pub fn fit(points: &[Vec3], settings: &FitSettings) -> CloudResult<PlaneFit> {
    if points.len() < MIN_POINTS {
        return Err(too_few(points.len(), MIN_POINTS, "plane"));
    }
    let tree = KdTree::build(points);
    let threshold = settings.threshold(&tree);
    let mut rng = Rng::new(settings.seed);
    let n = points.len();
    let mut best: Option<(usize, Vec3, Vec3)> = None;
    let mut budget = ransac_iterations(0.0, 3);
    let mut iterations = 0;
    while iterations < budget {
        iterations += 1;
        let (a, b, c) = (points[rng.below(n)], points[rng.below(n)], points[rng.below(n)]);
        let Some(normal) = unit(&cross(&sub(&b, &a), &sub(&c, &a))) else { continue };
        let count = points.iter().filter(|p| dot(&sub(p, &a), &normal).abs() < threshold.value).count();
        if best.is_none_or(|(k, _, _)| count > k) {
            best = Some((count, a, normal));
            budget = ransac_iterations(count as f64 / n as f64, 3);
        }
    }
    let Some((count, a, normal)) = best else { return Err(no_model("plane")) };
    if (count as f64) < MIN_INLIER_FRACTION * n as f64 {
        return Err(no_model("plane"));
    }
    let inliers: Vec<Vec3> = points.iter().filter(|p| dot(&sub(p, &a), &normal).abs() < threshold.value).copied().collect();
    let (centre, n0) = pca_plane(&inliers);
    let (u, w) = frame(&n0);
    let build = |q: &[f64]| -> (Vec3, Vec3) {
        let normal = unit(&add(&n0, &add(&scale(&u, q[0]), &scale(&w, q[1])))).unwrap_or(n0);
        (add(&centre, &scale(&n0, q[2])), normal)
    };
    let f = |q: &[f64]| -> Vec<f64> {
        let (c, nrm) = build(q);
        inliers.iter().map(|p| dot(&sub(p, &c), &nrm)).collect()
    };
    let lm = minimise(&f, &[0.0; 3], 50);
    let (point, normal) = build(&lm.params);
    let std = match (std_of(&lm.covariance, 0), std_of(&lm.covariance, 1), std_of(&lm.covariance, 2)) {
        (Some(a), Some(b), Some(c)) => Some(PlaneStd { normal_angle_deg: (a * a + b * b).sqrt().to_degrees(), offset: c }),
        _ => None,
    };
    Ok(PlaneFit {
        point,
        normal,
        inliers: inliers.len(),
        points_in_region: n,
        rms: rms(&lm.residuals),
        covariance: lm.covariance,
        std,
        threshold,
        ransac_iterations: iterations,
        warnings: Vec::new(),
    })
}

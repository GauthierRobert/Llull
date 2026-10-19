//! Cylinder fit (TECHNICAL_SPEC §5.5, §5.6): RANSAC from two oriented points (axis a = n₁ × n₂, centre = intersection of the two normal
//! lines in the plane ⊥ a), inliers |d| < ε with the normal within α of the radial direction, then LM on d = |(x − c) × a| − r with the
//! minimal parameterisation (2 axis-point offsets, 2 axis tilts, r) and two inlier re-selections. Ends from the axial projections of the
//! inliers: 5th / 95th percentile extended by the expected uniform tail (5 / 90 of that span on each side).

use super::{
    angular_coverage_deg, no_model, ransac_iterations, rms, std_of, too_few, FitSettings, FitWarning, Threshold, LOW_COVERAGE_DEG,
    MIN_INLIER_FRACTION,
};
use crate::cloud::Vec3;
use crate::error::CloudResult;
use crate::kdtree::{KdTree, Rng};
use crate::linalg::{add, cross, dot, frame, mean, norm, scale, sub, unit};
use crate::lm::minimise;
use crate::normals::pca_normals;
use serde::Serialize;

/// Minimum points of a cylinder region.
pub const MIN_POINTS: usize = 30;
/// Refit / re-select passes: at least 2 (§5.5), then until the inlier set is stable (local optimisation, Chum, Matas & Kittler 2003).
pub const MAX_REFINE_PASSES: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Cylinder {
    pub point: Vec3,
    pub axis: Vec3,
    pub radius: f64,
}

impl Cylinder {
    pub fn distance(&self, p: &Vec3) -> f64 {
        norm(&cross(&sub(p, &self.point), &self.axis)) - self.radius
    }

    /// Unit radial direction of `p` (from the axis), or None on the axis.
    fn radial(&self, p: &Vec3) -> Option<Vec3> {
        let v = sub(p, &self.point);
        unit(&sub(&v, &scale(&self.axis, dot(&v, &self.axis))))
    }
}

/// The cylinder through two oriented points (reference_check.py `cyl_from_two`), or None when the normals are (nearly) parallel.
pub fn from_two(p1: &Vec3, n1: &Vec3, p2: &Vec3, n2: &Vec3) -> Option<Cylinder> {
    let axis = cross(n1, n2);
    if norm(&axis) < 1e-3 {
        return None;
    }
    let a = unit(&axis)?;
    let proj = |x: &Vec3| sub(x, &scale(&a, dot(x, &a)));
    let (q1, q2) = (proj(p1), proj(p2));
    let (m1, m2) = (unit(&proj(n1))?, unit(&proj(n2))?);
    // q1 + s m1 = q2 + t m2 in the plane ⊥ a (least squares on [m1, -m2] [s t]ᵀ = q2 − q1).
    let d = sub(&q2, &q1);
    let (a11, a12, a22) = (dot(&m1, &m1), -dot(&m1, &m2), dot(&m2, &m2));
    let (b1, b2) = (dot(&m1, &d), -dot(&m2, &d));
    let det = a11 * a22 - a12 * a12;
    if det.abs() < 1e-12 {
        return None;
    }
    let s = (b1 * a22 - a12 * b2) / det;
    let centre = add(&q1, &scale(&m1, s));
    Some(Cylinder { point: centre, axis: a, radius: norm(&sub(&q1, &centre)) })
}

/// Result of a cylinder fit (metres, document frame).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CylinderFit {
    /// Axis point at the middle of the inliers' axial extent.
    pub axis_point: Vec3,
    pub axis_direction: Vec3,
    pub radius: f64,
    /// Ends of the inlier extent on the axis (§5.6).
    pub start: Vec3,
    pub end: Vec3,
    pub length: f64,
    pub inliers: usize,
    pub points_in_region: usize,
    pub rms: f64,
    pub coverage_deg: f64,
    /// σ̂²(JᵀJ)⁻¹ over (offset u, offset w, tilt u, tilt w, radius).
    pub covariance: Option<Vec<Vec<f64>>>,
    pub std: Option<Std>,
    /// CRLB standard deviations at σ (the given noiseSigma, else σ̂).
    pub crlb: Option<Std>,
    pub threshold: Threshold,
    pub ransac_iterations: usize,
    pub warnings: Vec<FitWarning>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Std {
    pub radius: f64,
    pub axis_angle_deg: f64,
    pub axis_position: f64,
}

fn ransac(points: &[Vec3], normals: &[Vec3], band: f64, settings: &FitSettings) -> (Option<Cylinder>, usize, usize) {
    let mut rng = Rng::new(settings.seed);
    let cos_alpha = libm::cos(settings.normal_threshold_deg.to_radians());
    let n = points.len();
    let mut best: Option<(usize, Cylinder)> = None;
    let mut budget = ransac_iterations(0.0, 2);
    let mut iterations = 0;
    while iterations < budget {
        iterations += 1;
        let i = rng.below(n);
        let mut j = rng.below(n - 1);
        if j >= i {
            j += 1;
        }
        let Some(model) = from_two(&points[i], &normals[i], &points[j], &normals[j]) else { continue };
        if !(model.radius > settings.min_radius && model.radius < settings.max_radius) {
            continue;
        }
        let count = (0..n)
            .filter(|&k| {
                model.distance(&points[k]).abs() < band && model.radial(&points[k]).is_some_and(|r| dot(&r, &normals[k]).abs() > cos_alpha)
            })
            .count();
        if best.is_none_or(|(c, _)| count > c) {
            best = Some((count, model));
            budget = ransac_iterations(count as f64 / n as f64, 2);
        }
    }
    (best.map(|b| b.1), best.map_or(0, |b| b.0), iterations)
}

fn refine(points: &[Vec3], model: &Cylinder) -> (Cylinder, crate::lm::LmResult, (Vec3, Vec3)) {
    let (u, w) = frame(&model.axis);
    let build = |q: &[f64]| -> Cylinder {
        let axis = unit(&add(&model.axis, &add(&scale(&u, q[2]), &scale(&w, q[3])))).unwrap_or(model.axis);
        Cylinder { point: add(&model.point, &add(&scale(&u, q[0]), &scale(&w, q[1]))), axis, radius: model.radius + q[4] }
    };
    let f = |q: &[f64]| -> Vec<f64> {
        let c = build(q);
        points.iter().map(|p| c.distance(p)).collect()
    };
    let fit = minimise(&f, &[0.0; 5], 100);
    (build(&fit.params), fit, (u, w))
}

/// LM refinement of `start` on all `points` (no RANSAC, no re-selection): the deviation report's refit of a design pipe (§5.9).
pub fn refine_cylinder(points: &[Vec3], start: &Cylinder) -> Cylinder {
    refine(points, start).0
}

/// Fits one cylinder to `points` (document frame, metres).
/// @failure < 30 points -> SCN_FIT_TOO_FEW_POINTS; no model with ≥ 20 % inliers -> SCN_FIT_NO_MODEL
pub fn fit(points: &[Vec3], settings: &FitSettings) -> CloudResult<CylinderFit> {
    if points.len() < MIN_POINTS {
        return Err(too_few(points.len(), MIN_POINTS, "cylinder"));
    }
    let tree = KdTree::build(points);
    let threshold = settings.threshold(&tree);
    let normals: Vec<Vec3> = pca_normals(&tree, 20, &mean(points)).into_iter().map(|(n, _)| n).collect();
    let (model, count, iterations) = ransac(points, &normals, threshold.value, settings);
    let Some(mut model) = model.filter(|_| count as f64 >= MIN_INLIER_FRACTION * points.len() as f64) else {
        return Err(no_model("cylinder"));
    };
    let mut band = threshold.value;
    let mut last = None;
    let mut previous_count = 0;
    for pass in 0..MAX_REFINE_PASSES {
        let inliers: Vec<Vec3> = points.iter().filter(|p| model.distance(p).abs() < band).copied().collect();
        if inliers.len() < MIN_POINTS {
            return Err(no_model("cylinder"));
        }
        if pass >= 2 && inliers.len() == previous_count {
            break;
        }
        previous_count = inliers.len();
        let (refined, lm, frame_uw) = refine(&inliers, &model);
        let sigma_hat = lm.sigma2.sqrt();
        band = settings.noise_sigma.map_or(threshold.value.min(3.0 * sigma_hat).max(1e-6), |s| 3.0 * s);
        model = refined;
        last = Some((inliers, lm, frame_uw));
    }
    let (inliers, lm, (u, w)) = last.ok_or_else(|| no_model("cylinder"))?;
    let axial: Vec<f64> = inliers.iter().map(|p| dot(&sub(p, &model.point), &model.axis)).collect();
    let mut sorted = axial.clone();
    sorted.sort_by(f64::total_cmp);
    let at = |q: f64| sorted[((sorted.len() - 1) as f64 * q).round() as usize];
    let (t5, t95) = (at(0.05), at(0.95));
    let margin = (t95 - t5) * 5.0 / 90.0;
    let (t0, t1) = (t5 - margin, t95 + margin);
    let start = add(&model.point, &scale(&model.axis, t0));
    let end = add(&model.point, &scale(&model.axis, t1));
    let axis_point = add(&model.point, &scale(&model.axis, (t0 + t1) / 2.0));
    let mut angles: Vec<f64> = inliers.iter().filter_map(|p| model.radial(p)).map(|r| libm::atan2(dot(&r, &w), dot(&r, &u))).collect();
    let coverage = angular_coverage_deg(&mut angles);
    let residual_rms = rms(&lm.residuals);
    let to_std = |c: &Option<Vec<Vec<f64>>>| -> Option<Std> {
        Some(Std {
            radius: std_of(c, 4)?,
            axis_angle_deg: (std_of(c, 2)?.powi(2) + std_of(c, 3)?.powi(2)).sqrt().to_degrees(),
            axis_position: (std_of(c, 0)?.powi(2) + std_of(c, 1)?.powi(2)).sqrt(),
        })
    };
    let sigma_crlb = settings.noise_sigma.unwrap_or(lm.sigma2.sqrt());
    let crlb_cov =
        lm.normal_inverse.as_ref().map(|m| m.iter().map(|row| row.iter().map(|v| v * sigma_crlb * sigma_crlb).collect()).collect());
    let mut warnings = Vec::new();
    if coverage < LOW_COVERAGE_DEG {
        warnings.push(FitWarning {
            code: "SCN_FIT_LOW_COVERAGE",
            message: format!("angular coverage {coverage:.1} deg below {LOW_COVERAGE_DEG} deg: the radius is ill-conditioned"),
        });
    }
    let rms_gate = settings.noise_sigma.map_or(2.0 * threshold.spacing, |s| 3.0 * s);
    if residual_rms > rms_gate {
        warnings.push(FitWarning {
            code: "SCN_FIT_HIGH_RMS",
            message: format!("RMS {residual_rms:.6} m above {rms_gate:.6} m: insulation, clamps or two objects?"),
        });
    }
    Ok(CylinderFit {
        axis_point,
        axis_direction: model.axis,
        radius: model.radius,
        start,
        end,
        length: t1 - t0,
        inliers: inliers.len(),
        points_in_region: points.len(),
        rms: residual_rms,
        coverage_deg: coverage,
        std: to_std(&lm.covariance),
        crlb: to_std(&crlb_cov),
        covariance: lm.covariance,
        threshold,
        ransac_iterations: iterations,
        warnings,
    })
}

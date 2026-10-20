//! Slices (TECHNICAL_SPEC §4.2 `slice_cloud`, FR-SCN-16): the points of a slab |(p − o)·n| ≤ t/2 in plane coordinates (u, v), with fitted
//! circles (RANSAC + Kåsa + LM, peeled one by one) and line segments (RANSAC + total least squares, peeled one by one).

use crate::cloud::Vec3;
use crate::fit::circle::{detect, Vec2};
use crate::fit::{ransac_iterations, rms};
use crate::kdtree::{median_spacing, KdTree, Rng};
use crate::linalg::{add, dot, frame, scale, sub, unit};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SliceFit {
    #[default]
    None,
    Circle,
    Lines,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SliceParams {
    pub origin: Vec3,
    pub normal: Vec3,
    pub thickness: f64,
    #[serde(default)]
    pub fit: SliceFit,
    #[serde(default = "default_max_points")]
    pub max_points: usize,
    #[serde(default)]
    pub noise_sigma: Option<f64>,
    #[serde(default = "default_min_radius")]
    pub min_radius: f64,
    #[serde(default = "default_max_radius")]
    pub max_radius: f64,
    #[serde(default = "one")]
    pub seed: u64,
    /// Bounds the points read (a crop around the section); default the whole cloud.
    #[serde(default)]
    pub region: crate::ops::Region,
}

fn default_max_points() -> usize {
    20_000
}
fn default_min_radius() -> f64 {
    0.005
}
fn default_max_radius() -> f64 {
    2.0
}
fn one() -> u64 {
    1
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceCircle {
    pub centre: Vec3,
    pub centre_uv: Vec2,
    pub radius: f64,
    pub rms: f64,
    pub radius_std: Option<f64>,
    pub inliers: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceLine {
    pub start: Vec3,
    pub end: Vec3,
    pub start_uv: Vec2,
    pub end_uv: Vec2,
    pub rms: f64,
    pub inliers: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceResult {
    pub u_axis: Vec3,
    pub v_axis: Vec3,
    pub count: usize,
    pub truncated: bool,
    pub points: Vec<Vec2>,
    pub circles: Vec<SliceCircle>,
    pub lines: Vec<SliceLine>,
    pub band: f64,
}

fn lines(points: &[Vec2], band: f64, min_support: usize, seed: u64) -> Vec<(Vec2, Vec2, f64, usize)> {
    let mut remaining = points.to_vec();
    let mut found = Vec::new();
    let mut rng = Rng::new(seed);
    while found.len() < 10 && remaining.len() >= min_support.max(2) {
        let n = remaining.len();
        let mut best: Option<(usize, Vec2, Vec2)> = None;
        let mut budget = ransac_iterations(0.0, 2);
        let mut iterations = 0;
        while iterations < budget {
            iterations += 1;
            let (a, b) = (remaining[rng.below(n)], remaining[rng.below(n)]);
            let d = [b[0] - a[0], b[1] - a[1]];
            let length = (d[0] * d[0] + d[1] * d[1]).sqrt();
            if length < 1e-12 {
                continue;
            }
            let normal = [-d[1] / length, d[0] / length];
            let count = remaining.iter().filter(|p| ((p[0] - a[0]) * normal[0] + (p[1] - a[1]) * normal[1]).abs() < band).count();
            if best.is_none_or(|(k, _, _)| count > k) {
                best = Some((count, a, normal));
                budget = ransac_iterations(count as f64 / n as f64, 2);
            }
        }
        let Some((_, a, normal)) = best.filter(|b| b.0 >= min_support) else { break };
        let inliers: Vec<Vec2> =
            remaining.iter().filter(|p| ((p[0] - a[0]) * normal[0] + (p[1] - a[1]) * normal[1]).abs() < band).copied().collect();
        // Total least squares: direction = principal axis of the inliers.
        let m = [
            inliers.iter().map(|p| p[0]).sum::<f64>() / inliers.len() as f64,
            inliers.iter().map(|p| p[1]).sum::<f64>() / inliers.len() as f64,
        ];
        let (mut sxx, mut sxy, mut syy) = (0.0, 0.0, 0.0);
        for p in &inliers {
            let (x, y) = (p[0] - m[0], p[1] - m[1]);
            sxx += x * x;
            sxy += x * y;
            syy += y * y;
        }
        let angle = 0.5 * libm::atan2(2.0 * sxy, sxx - syy);
        let dir = [libm::cos(angle), libm::sin(angle)];
        let along: Vec<f64> = inliers.iter().map(|p| (p[0] - m[0]) * dir[0] + (p[1] - m[1]) * dir[1]).collect();
        let residuals: Vec<f64> = inliers.iter().map(|p| -(p[0] - m[0]) * dir[1] + (p[1] - m[1]) * dir[0]).collect();
        let (lo, hi) = along.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), &t| (a.min(t), b.max(t)));
        remaining.retain(|p| ((p[0] - m[0]) * -dir[1] + (p[1] - m[1]) * dir[0]).abs() >= band);
        found.push(([m[0] + lo * dir[0], m[1] + lo * dir[1]], [m[0] + hi * dir[0], m[1] + hi * dir[1]], rms(&residuals), inliers.len()));
    }
    found
}

/// Slices `points` (document frame, metres).
pub fn slice(points: &[Vec3], params: &SliceParams) -> Option<SliceResult> {
    let n = unit(&params.normal)?;
    let (u, v) = frame(&n);
    let half = params.thickness / 2.0;
    let slab: Vec<Vec2> = points
        .iter()
        .filter(|p| dot(&sub(p, &params.origin), &n).abs() <= half)
        .map(|p| {
            let d = sub(p, &params.origin);
            [dot(&d, &u), dot(&d, &v)]
        })
        .collect();
    let spacing = if slab.len() >= 2 {
        median_spacing(&KdTree::build(&slab.iter().map(|p| [p[0], p[1], 0.0]).collect::<Vec<_>>()), 2000)
    } else {
        0.0
    };
    let band = params.noise_sigma.map_or(2.5 * spacing.max(1e-6), |s| 3.0 * s);
    let min_support = 10.max(slab.len() / 20);
    let to_3d = |q: &Vec2| add(&params.origin, &add(&scale(&u, q[0]), &scale(&v, q[1])));
    let circles = match params.fit {
        SliceFit::Circle => detect(&slab, band, min_support, (params.min_radius, params.max_radius), 10, params.seed)
            .into_iter()
            .map(|c| SliceCircle {
                centre: to_3d(&c.centre),
                centre_uv: c.centre,
                radius: c.radius,
                rms: c.rms,
                radius_std: c.radius_std,
                inliers: c.inliers,
            })
            .collect(),
        _ => Vec::new(),
    };
    let found_lines = match params.fit {
        SliceFit::Lines => lines(&slab, band, min_support, params.seed)
            .into_iter()
            .map(|(a, b, r, k)| SliceLine { start: to_3d(&a), end: to_3d(&b), start_uv: a, end_uv: b, rms: r, inliers: k })
            .collect(),
        _ => Vec::new(),
    };
    let truncated = slab.len() > params.max_points;
    Some(SliceResult {
        u_axis: u,
        v_axis: v,
        count: slab.len(),
        truncated,
        points: slab.into_iter().take(params.max_points).collect(),
        circles,
        lines: found_lines,
        band,
    })
}

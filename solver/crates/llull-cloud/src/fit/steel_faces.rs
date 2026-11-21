//! Steel member refinements on the best catalogue placement (TECHNICAL_SPEC §13.12): the member axis from the fitted face planes, and the web /
//! flange thickness of doubly symmetric I sections. Both read the points in the section frame of the placed outline (x = width, y = depth, origin on
//! the bounding-box centre), so they inherit the roll and the viewing direction of the ranking.

use super::steel::{extents, rotated, segment_distance, Candidate, Outline};
use crate::cloud::Vec3;
use crate::linalg::{column, dot, jacobi_eigen, mean, scale, scatter, unit};
use serde::Serialize;

/// Outline edges shorter than this (metres) are not faces.
pub const MIN_FACE_LENGTH: f64 = 0.02;
/// Points a face needs for its plane.
pub const MIN_FACE_POINTS: usize = 30;
/// A refinement moving the axis further than this (degrees) is rejected: the faces and the principal axis disagree, the fit is not trusted.
pub const MAX_REFINE_DEG: f64 = 5.0;
/// The faces must constrain two directions: second-smallest eigenvalue / trace of the normal scatter at least this.
pub const MIN_NORMAL_SPREAD: f64 = 0.05;
/// Points a thickness sample needs on each face of a plate.
pub const MIN_THICKNESS_POINTS: usize = 20;
/// Two faces closer than this many residuals (RMS scatter of their points) are not separately resolved.
pub const RESOLVE_RATIO: f64 = 5.0;
/// Share of a web's clear height / a flange outstand left out at the root (fillet) side when sampling.
pub const ROOT_MARGIN: f64 = 0.15;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AxisRefinement {
    pub applied: bool,
    /// Angle between the principal (or hinted) axis and the face-plane axis, degrees (0 when not applied).
    pub delta_deg: f64,
    pub faces: usize,
    pub face_points: usize,
    /// RMS distance of the face points to their own fitted planes (metres).
    pub residual: f64,
    pub reason: Option<String>,
}

impl AxisRefinement {
    pub fn not_applied(reason: &str) -> Self {
        AxisRefinement { applied: false, delta_deg: 0.0, faces: 0, face_points: 0, residual: 0.0, reason: Some(reason.to_string()) }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlateEstimate {
    /// Measured thickness (metres).
    pub value: f64,
    /// RMS deviation of the plate's face points from their fitted face positions (metres).
    pub residual: f64,
    pub samples: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Thickness {
    pub tw: Option<PlateEstimate>,
    pub tf: Option<PlateEstimate>,
    pub reason: Option<String>,
}

/// The points in the section frame of the placed best candidate, centred on their 0.5 % / 99.5 % bounding box (as `place` measures h and b).
pub fn placed(section: &[[f64; 2]], best: &Candidate) -> Vec<[f64; 2]> {
    let sign = if best.flipped { -1.0 } else { 1.0 };
    let oriented: Vec<[f64; 2]> = section.iter().map(|p| [p[0], sign * p[1]]).collect();
    let turned = rotated(&oriented, best.roll_deg.to_radians());
    let (low, high) = extents(&turned);
    let centre = [(low[0] + high[0]) / 2.0, (low[1] + high[1]) / 2.0];
    turned.iter().map(|p| [p[0] - centre[0], p[1] - centre[1]]).collect()
}

fn edge_length(outline: &Outline, i: usize) -> f64 {
    let n = outline.loop_xy.len();
    let (a, b) = (outline.loop_xy[i], outline.loop_xy[(i + 1) % n]);
    (b[0] - a[0]).hypot(b[1] - a[1])
}

/// The axis perpendicular to every face plane: each long edge of `outline` gathers the points within `band` of it (nearest edge), a plane is fitted
/// to each (smallest eigenvector of its scatter) and the axis is the direction least aligned with the plane normals (smallest eigenvector of
/// the point-weighted sum of n nᵀ). Err(reason) when fewer than two non-parallel faces have points, or the move exceeds MAX_REFINE_DEG.
pub fn refine_axis(
    points: &[Vec3],
    placed: &[[f64; 2]],
    outline: &Outline,
    axis: &Vec3,
    band: f64,
) -> Result<(Vec3, AxisRefinement), String> {
    let n = outline.loop_xy.len();
    let long: Vec<bool> = (0..n).map(|i| edge_length(outline, i) >= MIN_FACE_LENGTH).collect();
    let mut groups: Vec<Vec<Vec3>> = vec![Vec::new(); n];
    for (point, q) in points.iter().zip(placed) {
        let mut best = (0usize, f64::INFINITY);
        for i in 0..n {
            let d = segment_distance(q, &outline.loop_xy[i], &outline.loop_xy[(i + 1) % n]);
            if d < best.1 {
                best = (i, d);
            }
        }
        if best.1 <= band && long[best.0] {
            groups[best.0].push(*point);
        }
    }
    let mut normals = [[0.0f64; 3]; 3];
    let (mut faces, mut face_points, mut squared) = (0usize, 0usize, 0.0);
    for group in groups.iter().filter(|g| g.len() >= MIN_FACE_POINTS) {
        let (values, vectors) = jacobi_eigen(scatter(group, &mean(group)));
        let normal = column(&vectors, 0);
        for (r, row) in normals.iter_mut().enumerate() {
            for (c, cell) in row.iter_mut().enumerate() {
                *cell += group.len() as f64 * normal[r] * normal[c];
            }
        }
        faces += 1;
        face_points += group.len();
        squared += values[0].max(0.0);
    }
    if faces < 2 {
        return Err(format!(
            "only {faces} face(s) of the best outline have {MIN_FACE_POINTS} points within the band: at least 2 non-parallel faces are needed"
        ));
    }
    let (values, vectors) = jacobi_eigen(normals);
    let trace = values[0] + values[1] + values[2];
    if values[1] < MIN_NORMAL_SPREAD * trace {
        return Err("the fitted faces are parallel: they do not constrain the axis".to_string());
    }
    let mut refined = column(&vectors, 0);
    if dot(&refined, axis) < 0.0 {
        refined = scale(&refined, -1.0);
    }
    let refined = unit(&refined).ok_or("degenerate face normals")?;
    let delta_deg = dot(&refined, axis).clamp(-1.0, 1.0).acos().to_degrees();
    if delta_deg > MAX_REFINE_DEG {
        return Err(format!("the face planes move the axis by {delta_deg:.1} deg (limit {MAX_REFINE_DEG} deg): kept the principal axis"));
    }
    let residual = (squared / face_points as f64).sqrt();
    Ok((refined, AxisRefinement { applied: true, delta_deg, faces, face_points, residual, reason: None }))
}

fn median(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    let mid = values.len() / 2;
    if values.len() % 2 == 1 {
        values[mid]
    } else {
        (values[mid - 1] + values[mid]) / 2.0
    }
}

/// Face position (median) of a cluster and the sum of squared deviations from it; None below MIN_THICKNESS_POINTS.
fn plane_of(values: &mut [f64]) -> Option<(f64, f64)> {
    if values.len() < MIN_THICKNESS_POINTS {
        return None;
    }
    let at = median(values);
    Some((at, values.iter().map(|v| (v - at) * (v - at)).sum()))
}

fn missing_faces(name: &str) -> String {
    format!("{name}: fewer than {MIN_THICKNESS_POINTS} points on both faces of the plate (occluded or one-sided)")
}

/// A plate thickness is resolved only when its two faces are at least RESOLVE_RATIO residuals apart: closer, the two clusters are halves of one
/// face (a one-sided scan) or noise, and the gap is not a thickness.
fn separated(name: &str, gap: f64, squares: f64, samples: usize) -> Result<PlateEstimate, String> {
    let residual = (squares / samples.max(1) as f64).sqrt();
    if gap < RESOLVE_RATIO * residual {
        return Err(format!(
            "{name}: the two faces are {:.2} mm apart, under {RESOLVE_RATIO} x their {:.2} mm scatter (not separately resolved)",
            gap * 1000.0,
            residual * 1000.0
        ));
    }
    Ok(PlateEstimate { value: gap, residual, samples })
}

fn estimate(distances: &[f64], squares: f64, samples: usize) -> Option<PlateEstimate> {
    if distances.is_empty() {
        return None;
    }
    Some(PlateEstimate {
        value: distances.iter().sum::<f64>() / distances.len() as f64,
        residual: (squares / samples.max(1) as f64).sqrt(),
        samples,
    })
}

/// tw / tf of a doubly symmetric I outline (the catalogue tw, tf only place the sampling windows): the web faces are the medians of the points near
/// x = ±tw/2 over the central part of the clear height, the flange faces the medians of the points near the outer and inner y of each flange over
/// the middle of the outstand. None when the outline carries no tw / tf.
pub fn estimate_thickness(points: &[[f64; 2]], outline: &Outline, band: f64) -> Option<Thickness> {
    let (tw, tf) = (outline.tw?, outline.tf?);
    let (mut width, mut depth) = (0.0f64, 0.0f64);
    for p in &outline.loop_xy {
        width = width.max(2.0 * p[0].abs());
        depth = depth.max(2.0 * p[1].abs());
    }
    let web_height = depth - 2.0 * tf;
    let outstand = (width - tw) / 2.0;
    let window = 2.0 * band;
    let (mut right, mut left) = (Vec::new(), Vec::new());
    let (mut outer, mut inner) = ([Vec::new(), Vec::new()], [Vec::new(), Vec::new()]);
    for p in points {
        if p[1].abs() <= (0.5 - ROOT_MARGIN) * web_height && p[0].abs() <= tw / 2.0 + window {
            if p[0] >= 0.0 {
                right.push(p[0]);
            } else {
                left.push(p[0]);
            }
        }
        let across = p[0].abs();
        if across >= tw / 2.0 + ROOT_MARGIN * outstand && across <= width / 2.0 - ROOT_MARGIN * outstand {
            let side = usize::from(p[1] < 0.0);
            let y = p[1].abs();
            if y > depth / 2.0 - tf / 2.0 && y <= depth / 2.0 + window {
                outer[side].push(y);
            } else if y <= depth / 2.0 - tf / 2.0 && y >= depth / 2.0 - tf - window {
                inner[side].push(y);
            }
        }
    }
    let mut reasons = Vec::new();
    let mut web = None;
    match (plane_of(&mut right), plane_of(&mut left)) {
        (Some((r, sr)), Some((l, sl))) => match separated("tw", r - l, sr + sl, right.len() + left.len()) {
            Ok(measure) => web = Some(measure),
            Err(why) => reasons.push(why),
        },
        _ => reasons.push(missing_faces("tw")),
    }
    let (mut gaps, mut squares, mut samples) = (Vec::new(), 0.0, 0usize);
    for side in 0..2 {
        match (plane_of(&mut outer[side]), plane_of(&mut inner[side])) {
            (Some((o, so)), Some((i, si))) => {
                let count = outer[side].len() + inner[side].len();
                match separated("tf", o - i, so + si, count) {
                    Ok(_) => {
                        gaps.push(o - i);
                        squares += so + si;
                        samples += count;
                    }
                    Err(why) => reasons.push(why),
                }
            }
            _ => reasons.push(missing_faces("tf")),
        }
    }
    let flange = estimate(&gaps, squares, samples);
    reasons.dedup();
    let reason = (web.is_none() || flange.is_none()).then(|| reasons.join("; "));
    Some(Thickness { tw: web, tf: flange, reason })
}

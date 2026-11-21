//! Steel member fit (TECHNICAL_SPEC §5.7, FR-SCN-15): the axis is the largest-variance direction of the region (or a caller hint), the points are
//! projected onto the section plane, and each catalogue outline (sent by the plugin, metres, centred on its bounding box) is scored by the one-sided
//! chamfer distance RMS(min distance of a section point to the outline) over a roll search (coarse 5° steps, then golden section ±5°) with the
//! section seen from either end. h and b are measured on the rotated extents (0.5 % / 99.5 % percentiles, robust to stray points).

use super::{too_few, FitSettings, FitWarning, Threshold};
use crate::cloud::Vec3;
use crate::error::{CloudError, CloudResult};
use crate::kdtree::KdTree;
use crate::linalg::{add, column, dot, frame, jacobi_eigen, mean, scale, scatter, sub, unit};
use serde::{Deserialize, Serialize};

pub const MIN_POINTS: usize = 30;
/// Points kept for the roll search (deterministic stride subsample).
pub const MAX_SECTION_POINTS: usize = 1500;
/// Points used by the coarse pass.
const COARSE_POINTS: usize = 300;
const COARSE_STEP_DEG: f64 = 5.0;
/// A profile whose extents differ from the section's by more than this fraction is not scored at that roll.
const EXTENT_GATE: f64 = 0.3;
/// Sections thinner than this in both directions (metres) are not a member.
const MIN_EXTENT: f64 = 0.01;
const GOLDEN: f64 = 0.618_033_988_749_894_9;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Outline {
    pub name: String,
    /// Closed loop (x, y) in metres around the bounding-box centre; x = width b, y = depth h.
    pub loop_xy: Vec<[f64; 2]>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub profile: String,
    /// RMS of the min distance of the section points to the outline (metres).
    pub score: f64,
    /// Section turned by this angle (degrees) in the (u, v) frame of the axis aligns the profile with the points.
    pub roll_deg: f64,
    /// The section is seen from the other end: `axis_direction` is the reverse of the fitted axis.
    pub flipped: bool,
    /// Profile local y (depth h) and x (width b) in the document frame; width x depth = axis_direction.
    pub depth_direction: Vec3,
    pub width_direction: Vec3,
    pub axis_direction: Vec3,
    pub h: f64,
    pub b: f64,
    /// Bounding-box centre of the section on the plane through the region centroid (document frame).
    pub centre: Vec3,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SteelFit {
    pub axis_direction: Vec3,
    pub start: Vec3,
    pub end: Vec3,
    pub length: f64,
    pub points_in_region: usize,
    pub section_points: usize,
    pub candidates: Vec<Candidate>,
    pub rms: f64,
    pub threshold: Threshold,
    pub warnings: Vec<FitWarning>,
}

fn percentile(sorted: &[f64], q: f64) -> f64 {
    let at = ((sorted.len() - 1) as f64 * q).round() as usize;
    sorted[at.min(sorted.len() - 1)]
}

fn extents(points: &[[f64; 2]]) -> ([f64; 2], [f64; 2]) {
    let mut low = [0.0; 2];
    let mut high = [0.0; 2];
    for k in 0..2 {
        let mut axis: Vec<f64> = points.iter().map(|p| p[k]).collect();
        axis.sort_by(f64::total_cmp);
        low[k] = percentile(&axis, 0.005);
        high[k] = percentile(&axis, 0.995);
    }
    (low, high)
}

fn rotated(points: &[[f64; 2]], theta: f64) -> Vec<[f64; 2]> {
    let (s, c) = libm::sincos(theta);
    points.iter().map(|p| [c * p[0] - s * p[1], s * p[0] + c * p[1]]).collect()
}

fn segment_distance(p: &[f64; 2], a: &[f64; 2], b: &[f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let length2 = dx * dx + dy * dy;
    let t = if length2 > 0.0 { (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2).clamp(0.0, 1.0) } else { 0.0 };
    let (ex, ey) = (a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
    (ex * ex + ey * ey).sqrt()
}

/// RMS min-distance of the (already rotated) points to the outline centred on the bounding box of the points.
fn chamfer(points: &[[f64; 2]], outline: &Outline) -> f64 {
    let (low, high) = extents(points);
    let centre = [(low[0] + high[0]) / 2.0, (low[1] + high[1]) / 2.0];
    let n = outline.loop_xy.len();
    let mut sum = 0.0;
    for p in points {
        let q = [p[0] - centre[0], p[1] - centre[1]];
        let mut best = f64::INFINITY;
        for i in 0..n {
            best = best.min(segment_distance(&q, &outline.loop_xy[i], &outline.loop_xy[(i + 1) % n]));
        }
        sum += best * best;
    }
    (sum / points.len().max(1) as f64).sqrt()
}

fn size_of(outline: &Outline) -> [f64; 2] {
    let mut low = [f64::INFINITY; 2];
    let mut high = [f64::NEG_INFINITY; 2];
    for p in &outline.loop_xy {
        for k in 0..2 {
            low[k] = low[k].min(p[k]);
            high[k] = high[k].max(p[k]);
        }
    }
    [high[0] - low[0], high[1] - low[1]]
}

fn extents_fit(points: &[[f64; 2]], size: &[f64; 2]) -> bool {
    let (low, high) = extents(points);
    (0..2).all(|k| ((high[k] - low[k]) - size[k]).abs() <= EXTENT_GATE * size[k])
}

fn subsample(points: &[[f64; 2]], keep: usize) -> Vec<[f64; 2]> {
    if points.len() <= keep {
        return points.to_vec();
    }
    (0..keep).map(|i| points[i * points.len() / keep]).collect()
}

/// Best roll of one outline for one viewing direction: (score, theta).
fn best_roll(coarse: &[[f64; 2]], full: &[[f64; 2]], outline: &Outline) -> Option<(f64, f64)> {
    let size = size_of(outline);
    let steps = (360.0 / COARSE_STEP_DEG) as usize;
    let mut best: Option<(f64, f64)> = None;
    for k in 0..steps {
        let theta = (k as f64 * COARSE_STEP_DEG).to_radians();
        let turned = rotated(coarse, theta);
        if !extents_fit(&turned, &size) {
            continue;
        }
        let score = chamfer(&turned, outline);
        if best.is_none_or(|(s, _)| score < s) {
            best = Some((score, theta));
        }
    }
    let (_, start) = best?;
    let objective = |theta: f64| chamfer(&rotated(full, theta), outline);
    let step = COARSE_STEP_DEG.to_radians();
    let (mut a, mut b) = (start - step, start + step);
    let (mut c, mut d) = (b - GOLDEN * (b - a), a + GOLDEN * (b - a));
    let (mut fc, mut fd) = (objective(c), objective(d));
    for _ in 0..24 {
        if fc < fd {
            b = d;
            d = c;
            fd = fc;
            c = b - GOLDEN * (b - a);
            fc = objective(c);
        } else {
            a = c;
            c = d;
            fc = fd;
            d = a + GOLDEN * (b - a);
            fd = objective(d);
        }
    }
    let theta = (a + b) / 2.0;
    Some((objective(theta), theta))
}

/// Largest-variance direction of the points, sign fixed so its largest component is positive.
pub fn principal_axis(points: &[Vec3]) -> Vec3 {
    let (_, vectors) = jacobi_eigen(scatter(points, &mean(points)));
    let axis = column(&vectors, 2);
    let largest = (0..3).max_by(|&i, &j| axis[i].abs().total_cmp(&axis[j].abs())).unwrap_or(0);
    if axis[largest] < 0.0 {
        scale(&axis, -1.0)
    } else {
        axis
    }
}

/// Best roll and viewing direction of one outline over the section points: the candidate (without its ranking).
fn place(section: &[[f64; 2]], frame_uv: (&Vec3, &Vec3), axis: &Vec3, centroid: &Vec3, outline: &Outline) -> Option<Candidate> {
    let (u, v) = frame_uv;
    let mut best: Option<(f64, f64, bool)> = None;
    for flipped in [false, true] {
        let oriented: Vec<[f64; 2]> = section.iter().map(|p| if flipped { [p[0], -p[1]] } else { *p }).collect();
        if let Some((score, theta)) = best_roll(&subsample(&oriented, COARSE_POINTS), &subsample(&oriented, MAX_SECTION_POINTS), outline) {
            if best.is_none_or(|(s, _, _)| score < s - 1e-12) {
                best = Some((score, theta, flipped));
            }
        }
    }
    let (score, theta, flipped) = best?;
    let sign = if flipped { -1.0 } else { 1.0 };
    let oriented: Vec<[f64; 2]> = section.iter().map(|p| [p[0], sign * p[1]]).collect();
    let (low, high) = extents(&rotated(&oriented, theta));
    let (s, c) = libm::sincos(theta);
    let rotated_centre = [(low[0] + high[0]) / 2.0, (low[1] + high[1]) / 2.0];
    let centre_xy = [c * rotated_centre[0] + s * rotated_centre[1], -s * rotated_centre[0] + c * rotated_centre[1]];
    let v_seen = scale(v, sign);
    Some(Candidate {
        profile: outline.name.clone(),
        score,
        roll_deg: theta.to_degrees(),
        flipped,
        depth_direction: add(&scale(u, s), &scale(&v_seen, c)),
        width_direction: add(&scale(u, c), &scale(&v_seen, -s)),
        axis_direction: scale(axis, sign),
        h: high[1] - low[1],
        b: high[0] - low[0],
        centre: add(centroid, &add(&scale(u, centre_xy[0]), &scale(&v_seen, centre_xy[1]))),
    })
}

/// @failure < 30 points -> SCN_FIT_TOO_FEW_POINTS; no / degenerate outlines or a zero axisHint -> NATIVE_JOB_INPUT; a section thinner than 1 cm
///   -> SCN_FIT_NO_MODEL; no outline within the extent gate -> SCN_STEEL_NO_MATCH
pub fn fit(
    points: &[Vec3],
    outlines: &[Outline],
    axis_hint: Option<Vec3>,
    max_candidates: usize,
    settings: &FitSettings,
) -> CloudResult<SteelFit> {
    if points.len() < MIN_POINTS {
        return Err(too_few(points.len(), MIN_POINTS, "steel member"));
    }
    if outlines.is_empty() || outlines.iter().any(|o| o.loop_xy.len() < 3) {
        return Err(CloudError::input("params.outlines needs closed loops of at least 3 points"));
    }
    let axis = match axis_hint {
        Some(hint) => unit(&hint).ok_or_else(|| CloudError::input("params.axisHint must not be zero"))?,
        None => principal_axis(points),
    };
    let threshold = settings.threshold(&KdTree::build(points));
    let centroid = mean(points);
    let (u, v) = frame(&axis);
    let section: Vec<[f64; 2]> = points
        .iter()
        .map(|p| {
            let r = sub(p, &centroid);
            [dot(&r, &u), dot(&r, &v)]
        })
        .collect();
    let mut axial: Vec<f64> = points.iter().map(|p| dot(&sub(p, &centroid), &axis)).collect();
    axial.sort_by(f64::total_cmp);
    let (t_low, t_high) = (percentile(&axial, 0.005), percentile(&axial, 0.995));
    let (low, high) = extents(&section);
    if (high[0] - low[0]) < MIN_EXTENT && (high[1] - low[1]) < MIN_EXTENT {
        return Err(CloudError::new("SCN_FIT_NO_MODEL", "the section of the region is thinner than 1 cm in both directions; not a member"));
    }
    let mut candidates: Vec<Candidate> = outlines.iter().filter_map(|o| place(&section, (&u, &v), &axis, &centroid, o)).collect();
    if candidates.is_empty() {
        return Err(CloudError::new(
            "SCN_STEEL_NO_MATCH",
            format!(
                "no catalogue outline has extents within {} % of the section ({:.1} x {:.1} mm)",
                EXTENT_GATE * 100.0,
                (high[0] - low[0]) * 1000.0,
                (high[1] - low[1]) * 1000.0
            ),
        ));
    }
    candidates.sort_by(|a, b| a.score.total_cmp(&b.score).then_with(|| a.profile.cmp(&b.profile)));
    candidates.truncate(max_candidates.max(1));
    let best = &candidates[0];
    let mut warnings = Vec::new();
    if best.score > threshold.value {
        warnings.push(FitWarning {
            code: "SCN_STEEL_NO_MATCH",
            message: format!(
                "best score {:.2} mm exceeds the {} band {:.2} mm: non-catalogue or built-up section; model manually",
                best.score * 1000.0,
                threshold.source,
                threshold.value * 1000.0
            ),
        });
    }
    let (from, to) = if best.flipped { (t_high, t_low) } else { (t_low, t_high) };
    Ok(SteelFit {
        axis_direction: best.axis_direction,
        start: add(&best.centre, &scale(&axis, from)),
        end: add(&best.centre, &scale(&axis, to)),
        length: t_high - t_low,
        points_in_region: points.len(),
        section_points: section.len().min(MAX_SECTION_POINTS),
        rms: best.score,
        threshold,
        candidates,
        warnings,
    })
}

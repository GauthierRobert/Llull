//! Bend model of the centreline trace (TECHNICAL_SPEC §5.6): two straight axes (P₁, d₁) → (P₂, d₂) joined by a circular arc of radius R
//! (the torus fit: plane normal d₁ × d₂, tube radius r, centre at distance R from the tangent points). The intersection point PI is the
//! closest approach of the two axes; for a given R the tangent points are PI − d₁·R·tan(θ/2) and PI + d₂·R·tan(θ/2). R is the one free
//! parameter, found on the pipe-surface points near the bend by a log grid then golden section on the truncated cost Σ min(e², (3 band)²)
//! of e = distance to the whole path (ray, arc, ray) − r, so straight points and strays cannot drag it.

use crate::cloud::Vec3;
use crate::kdtree::KdTree;
use crate::linalg::{add, cross, dot, norm, scale, sub, unit};
use serde::Serialize;

/// Grid samples of the radius search.
const GRID: usize = 48;
/// Golden-section iterations inside the best grid cell.
const GOLDEN_ITERATIONS: usize = 40;
/// Tangent length cap, in tube radii (keeps R·tan(θ/2) finite near 180°).
const MAX_TANGENT_FACTOR: f64 = 15.0;
/// Smallest bend radius searched, in tube radii (a mitre bend reports this bound).
const MIN_RADIUS_FACTOR: f64 = 0.5;
/// Arc inliers needed for the radius to count as measured.
const MIN_ARC_INLIERS: usize = 20;

/// Closest approach of two lines: (parameter on a, parameter on b, distance). None when parallel.
pub fn closest_approach(pa: &Vec3, da: &Vec3, pb: &Vec3, db: &Vec3) -> Option<(f64, f64, f64)> {
    let w = sub(pa, pb);
    let (a, b, c) = (dot(da, da), dot(da, db), dot(db, db));
    let (d, e) = (dot(da, &w), dot(db, &w));
    let denominator = a * c - b * b;
    if denominator.abs() < 1e-12 {
        return None;
    }
    let s = (b * e - c * d) / denominator;
    let t = (a * e - b * d) / denominator;
    let gap = norm(&sub(&add(pa, &scale(da, s)), &add(pb, &scale(db, t))));
    Some((s, t, gap))
}

/// The bend between two oriented legs (metres, document frame).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bend {
    pub intersection_point: Vec3,
    pub angle_deg: f64,
    /// Bend (centreline) radius R; the lower search bound for a mitre.
    pub radius: f64,
    pub tube_radius: f64,
    pub centre: Vec3,
    pub plane_normal: Vec3,
    pub tangent_start: Vec3,
    pub tangent_end: Vec3,
    /// Gap between the two axes at their closest approach.
    pub skew: f64,
    pub arc_inliers: usize,
    pub rms: Option<f64>,
    /// false when the radius sits on a search bound or fewer than 20 arc points support it.
    pub radius_measured: bool,
}

struct Path {
    t1: Vec3,
    t2: Vec3,
    d1: Vec3,
    d2: Vec3,
    centre: Vec3,
    normal: Vec3,
    e1: Vec3,
    radius: f64,
    angle: f64,
}

impl Path {
    fn new(pi: &Vec3, d1: &Vec3, d2: &Vec3, angle: f64, radius: f64) -> Option<Path> {
        let t = radius * libm::tan(angle / 2.0);
        let t1 = sub(pi, &scale(d1, t));
        let t2 = add(pi, &scale(d2, t));
        let m = unit(&sub(d2, &scale(d1, dot(d1, d2))))?;
        let centre = add(&t1, &scale(&m, radius));
        Some(Path { t1, t2, d1: *d1, d2: *d2, centre, normal: unit(&cross(d1, d2))?, e1: scale(&m, -1.0), radius, angle })
    }

    /// (distance to the path, whether the arc is the nearest element).
    fn distance(&self, p: &Vec3) -> (f64, bool) {
        let a = dot(&sub(p, &self.t1), &self.d1);
        let on_ray1 = if a <= 0.0 { norm(&sub(&sub(p, &self.t1), &scale(&self.d1, a))) } else { norm(&sub(p, &self.t1)) };
        let b = dot(&sub(p, &self.t2), &self.d2);
        let on_ray2 = if b >= 0.0 { norm(&sub(&sub(p, &self.t2), &scale(&self.d2, b))) } else { norm(&sub(p, &self.t2)) };
        let v = sub(p, &self.centre);
        let h = dot(&v, &self.normal);
        let w = sub(&v, &scale(&self.normal, h));
        let phi = libm::atan2(dot(&w, &self.d1), dot(&w, &self.e1));
        let on_arc = if phi >= 0.0 && phi <= self.angle { (h * h + (norm(&w) - self.radius).powi(2)).sqrt() } else { f64::INFINITY };
        let straight = on_ray1.min(on_ray2);
        if on_arc <= straight {
            (on_arc, true)
        } else {
            (straight, false)
        }
    }
}

/// Fits the bend between leg 1 (P₁, d₁, arriving) and leg 2 (P₂, d₂, leaving), both unit and oriented along the pipe.
/// `tree` holds the cloud points; `tube` is the tube radius, `band` the inlier band. None for parallel axes.
pub fn fit_bend(tree: &KdTree, leg1: (&Vec3, &Vec3), leg2: (&Vec3, &Vec3), tube: f64, band: f64, max_radius_factor: f64) -> Option<Bend> {
    let (d1, d2) = (leg1.1, leg2.1);
    let (s, t, skew) = closest_approach(leg1.0, d1, leg2.0, d2)?;
    let pi = scale(&add(&add(leg1.0, &scale(d1, s)), &add(leg2.0, &scale(d2, t))), 0.5);
    let angle = libm::acos(dot(d1, d2).clamp(-1.0, 1.0));
    let half_tan = libm::tan(angle / 2.0).max(1e-9);
    let low = MIN_RADIUS_FACTOR * tube;
    let high = (max_radius_factor * tube).min(MAX_TANGENT_FACTOR * tube / half_tan).max(low * 1.01);
    let reach = high * half_tan + 3.0 * tube;
    let points: Vec<Vec3> = tree.within(&pi, reach).into_iter().map(|i| *tree.point(i)).collect();
    let cap = 3.0 * band;
    let cost = |radius: f64| -> f64 {
        let Some(path) = Path::new(&pi, d1, d2, angle, radius) else { return f64::INFINITY };
        points.iter().map(|p| (path.distance(p).0 - tube).powi(2).min(cap * cap)).sum()
    };
    let at = |k: usize| low * libm::pow(high / low, k as f64 / (GRID - 1) as f64);
    let costs: Vec<f64> = (0..GRID).map(|k| cost(at(k))).collect();
    let best = (0..GRID).fold(0, |b, k| if costs[k] < costs[b] { k } else { b });
    let (mut lo, mut hi) = (at(best.saturating_sub(1)), at((best + 1).min(GRID - 1)));
    let phi = (5f64.sqrt() - 1.0) / 2.0;
    for _ in 0..GOLDEN_ITERATIONS {
        let (x1, x2) = (hi - phi * (hi - lo), lo + phi * (hi - lo));
        if cost(x1) < cost(x2) {
            hi = x2;
        } else {
            lo = x1;
        }
    }
    let radius = (lo + hi) / 2.0;
    let path = Path::new(&pi, d1, d2, angle, radius)?;
    let residuals: Vec<f64> = points
        .iter()
        .filter_map(|p| Some(path.distance(p)).filter(|&(d, arc)| arc && (d - tube).abs() < band).map(|(d, _)| d - tube))
        .collect();
    let arc_inliers = residuals.len();
    let rms = (arc_inliers > 0).then(|| (residuals.iter().map(|r| r * r).sum::<f64>() / arc_inliers as f64).sqrt());
    let on_bound = best == 0 || best == GRID - 1;
    Some(Bend {
        intersection_point: pi,
        angle_deg: angle.to_degrees(),
        radius,
        tube_radius: tube,
        centre: path.centre,
        plane_normal: path.normal,
        tangent_start: path.t1,
        tangent_end: path.t2,
        skew,
        arc_inliers,
        rms,
        radius_measured: !on_bound && arc_inliers >= MIN_ARC_INLIERS,
    })
}

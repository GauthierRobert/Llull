//! Pipe centreline tracing (TECHNICAL_SPEC §5.6, FR-SCN-14): from a seed on a pipe, a seeded RANSAC cylinder gives the first axis and
//! radius; the trace then marches along the axis in windows of `2 step` (step default 2r), each a fixed-radius least-squares axis fit
//! (4 parameters, Levenberg–Marquardt) on the points on the predicted surface. A leg ends when a window's axis turns by more than
//! `bendDetectionDeg` from the leg's running direction (bend), has too few points (gap / pipe end) or its free-radius fit moves by more
//! than 15 % (reducer candidate). Every leg is then refitted (free radius) on all its surface points. After a bend the next straight is
//! found by a radius-constrained RANSAC on the points around the leg's end that the leg does not explain, accepted only when its axis
//! meets the leg's within `skewTolerance`; the bend is the arc of [`super::bend`] (torus: R from the surface points near the bend). The result
//! (straights, bends, centreline, diameter) is assembled in [`super::trace_result`].

use super::bend::closest_approach;
use super::cylinder::{self, Cylinder};
use super::trace_result::assemble;
pub use super::trace_result::TraceResult;
use super::{angular_coverage_deg, rms, FitSettings, FitWarning};
use crate::cloud::Vec3;
use crate::error::{CloudError, CloudResult};
use crate::kdtree::KdTree;
use crate::linalg::{add, cross, dot, frame, mean, norm, scale, sub, unit};
use crate::lm::minimise;

/// Points a window needs (below it the pipe is not seen there).
pub const MIN_WINDOW_POINTS: usize = 30;
/// A free-radius window fit this far from the leg radius is a reducer candidate (§5.6).
const RADIUS_CHANGE: f64 = 0.15;
/// The radius is only checked where the window sees at least this much of the circumference.
const RADIUS_CHECK_COVERAGE_DEG: f64 = 120.0;
/// Largest turn accepted as a bend.
const MAX_BEND_DEG: f64 = 170.0;
/// Search sphere around a leg end for the next leg, and the farthest PI ahead of it, in tube radii.
const MAX_PI_RADII: f64 = 15.0;
const LOOK_AHEAD_RADII: f64 = MAX_PI_RADII + 10.0;
/// A leg shorter than this many steps is not a straight (the chord of a bend), the trace stops instead.
const MIN_LEG_STEPS: f64 = 2.0;
/// Hard bound on windows per march.
const MAX_WINDOWS: usize = 4000;

/// Named thresholds of a trace (metres / degrees).
#[derive(Debug, Clone, Copy)]
pub struct TraceSettings {
    pub fit: FitSettings,
    /// Window spacing; None = 2r.
    pub step_length: Option<f64>,
    pub bend_detection_deg: f64,
    pub max_length: f64,
    pub seed_radius: f64,
    /// Largest gap between two axes meeting at a PI; None = max(1 mm, r / 10).
    pub skew_tolerance: Option<f64>,
    pub max_legs: usize,
    pub max_bend_radius_factor: f64,
}

impl Default for TraceSettings {
    fn default() -> TraceSettings {
        TraceSettings {
            fit: FitSettings::default(),
            step_length: None,
            bend_detection_deg: 3.0,
            max_length: 50.0,
            seed_radius: 0.5,
            skew_tolerance: None,
            max_legs: 64,
            max_bend_radius_factor: 12.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum Stop {
    Bend,
    NoPoints,
    Radius(f64),
    MaxLength,
    MaxLegs,
}

impl Stop {
    pub(super) fn reason(self) -> &'static str {
        match self {
            Stop::Bend => "bend_not_continued",
            Stop::NoPoints => "no_points",
            Stop::Radius(_) => "radius_change",
            Stop::MaxLength => "max_length",
            Stop::MaxLegs => "max_legs",
        }
    }
}

struct Window {
    pos: Vec3,
    dir: Vec3,
    coverage: f64,
}

#[derive(Clone)]
pub(super) struct Leg {
    pub(super) point: Vec3,
    pub(super) dir: Vec3,
    pub(super) radius: f64,
    /// Axial range (from `point` along `dir`) of the windows.
    pub(super) t_min: f64,
    pub(super) t_max: f64,
    /// Axial range of the inliers after the refit (the ends of a chain).
    pub(super) data_lo: f64,
    pub(super) data_hi: f64,
    pub(super) inliers: usize,
    pub(super) rms: f64,
    pub(super) coverage: f64,
    pub(super) stop_min: Stop,
    pub(super) stop_max: Stop,
}

impl Leg {
    pub(super) fn at(&self, t: f64) -> Vec3 {
        add(&self.point, &scale(&self.dir, t))
    }

    fn flipped(&self) -> Leg {
        Leg {
            dir: scale(&self.dir, -1.0),
            t_min: -self.t_max,
            t_max: -self.t_min,
            data_lo: -self.data_hi,
            data_hi: -self.data_lo,
            stop_min: self.stop_max,
            stop_max: self.stop_min,
            ..self.clone()
        }
    }

    fn distance(&self, p: &Vec3) -> f64 {
        norm(&cross(&sub(p, &self.point), &self.dir)) - self.radius
    }
}

pub(super) struct Tracer<'a> {
    pub(super) tree: &'a KdTree,
    pub(super) settings: &'a TraceSettings,
    pub(super) band: f64,
    pub(super) max_windows: usize,
}

/// Fixed-radius axis fit: 2 offsets ⟂ axis, 2 tilts; returns (point, axis).
fn fit_axis(points: &[Vec3], point: &Vec3, axis: &Vec3, radius: f64) -> (Vec3, Vec3) {
    let (u, w) = frame(axis);
    let build = |q: &[f64]| -> (Vec3, Vec3) {
        let a = unit(&add(axis, &add(&scale(&u, q[2]), &scale(&w, q[3])))).unwrap_or(*axis);
        (add(point, &add(&scale(&u, q[0]), &scale(&w, q[1]))), a)
    };
    let f = |q: &[f64]| -> Vec<f64> {
        let (p0, a) = build(q);
        points.iter().map(|p| norm(&cross(&sub(p, &p0), &a)) - radius).collect()
    };
    build(&minimise(&f, &[0.0; 4], 50).params)
}

fn coverage_of(points: &[Vec3], point: &Vec3, axis: &Vec3) -> f64 {
    let (u, w) = frame(axis);
    let mut angles: Vec<f64> = points
        .iter()
        .filter_map(|p| {
            let v = sub(p, point);
            unit(&sub(&v, &scale(axis, dot(&v, axis))))
        })
        .map(|r| libm::atan2(dot(&r, &w), dot(&r, &u)))
        .collect();
    angular_coverage_deg(&mut angles)
}

fn orient(v: &Vec3, reference: &Vec3) -> Vec3 {
    if dot(v, reference) < 0.0 {
        scale(v, -1.0)
    } else {
        *v
    }
}

impl Tracer<'_> {
    /// Fixed-radius window of half-length `step` around `centre` along `dir`; None below MIN_WINDOW_POINTS surface points.
    fn window(&self, centre: &Vec3, dir: &Vec3, r: f64, step: f64) -> Option<(Window, Vec<Vec3>)> {
        let wide = (0.25 * r).max(2.0 * self.band);
        let candidates: Vec<Vec3> = self
            .tree
            .within(centre, (step * step + (r + wide).powi(2)).sqrt())
            .into_iter()
            .map(|i| *self.tree.point(i))
            .filter(|p| dot(&sub(p, centre), dir).abs() <= step)
            .collect();
        let (mut point, mut axis, mut band) = (*centre, *dir, wide);
        let mut inliers = Vec::new();
        for _ in 0..3 {
            inliers = candidates.iter().filter(|p| (norm(&cross(&sub(p, &point), &axis)) - r).abs() < band).copied().collect();
            if inliers.len() < MIN_WINDOW_POINTS {
                return None;
            }
            (point, axis) = fit_axis(&inliers, &point, &axis, r);
            band = self.band;
        }
        let coverage = coverage_of(&inliers, &point, &axis);
        Some((Window { pos: point, dir: axis, coverage }, inliers))
    }

    /// Marches from `start` along ±`start.dir`; returns the accepted windows and why it stopped.
    fn march(&self, start: &Window, r: f64, step: f64, sign: f64) -> (Vec<Window>, Stop) {
        let (mut reference, mut current) = (scale(&start.dir, sign), start.pos);
        let mut sum = reference;
        let mut windows = Vec::new();
        for _ in 0..self.max_windows {
            let predicted = add(&current, &scale(&reference, step));
            let Some((found, inliers)) = self.window(&predicted, &reference, r, step) else {
                return (windows, self.probe_radius(&current, &reference, r, step).map_or(Stop::NoPoints, Stop::Radius));
            };
            let dir = orient(&found.dir, &reference);
            let shift = sub(&found.pos, &predicted);
            let lateral = norm(&sub(&shift, &scale(&reference, dot(&shift, &reference))));
            let turn = libm::acos(dot(&dir, &reference).clamp(-1.0, 1.0)).to_degrees();
            if turn > self.settings.bend_detection_deg || lateral > 0.5 * r {
                return (windows, Stop::Bend);
            }
            if found.coverage >= RADIUS_CHECK_COVERAGE_DEG {
                let wide: Vec<Vec3> =
                    inliers.iter().filter(|p| (norm(&cross(&sub(p, &found.pos), &dir)) - r).abs() < 0.3 * r).copied().collect();
                let free = cylinder::refine_cylinder(&wide, &Cylinder { point: found.pos, axis: dir, radius: r }).radius;
                if (free - r).abs() > RADIUS_CHANGE * r {
                    return (windows, Stop::Radius(free));
                }
            }
            sum = add(&sum, &dir);
            reference = unit(&sum).unwrap_or(reference);
            current = found.pos;
            windows.push(Window { dir, ..found });
        }
        (windows, Stop::MaxLength)
    }

    /// A coaxial pipe of another radius just past `current` (a reducer): at least 3 windows' worth of points beyond the last window whose
    /// radial distances are tightly concentrated (MAD < 5 %) on a radius more than 15 % away from `r`.
    fn probe_radius(&self, current: &Vec3, dir: &Vec3, r: f64, step: f64) -> Option<f64> {
        let ahead = add(current, &scale(dir, 2.0 * step));
        let mut radial: Vec<f64> = self
            .tree
            .within(&ahead, (step * step + (3.0 * r).powi(2)).sqrt())
            .into_iter()
            .map(|i| sub(self.tree.point(i), current))
            .filter(|v| dot(v, dir) > step && dot(v, dir) < 3.0 * step)
            .map(|v| norm(&sub(&v, &scale(dir, dot(&v, dir)))))
            .filter(|rho| *rho > 0.3 * r && *rho < 2.5 * r)
            .collect();
        if radial.len() < 3 * MIN_WINDOW_POINTS {
            return None;
        }
        radial.sort_by(f64::total_cmp);
        let median = radial[radial.len() / 2];
        let mut spread: Vec<f64> = radial.iter().map(|v| (v - median).abs()).collect();
        spread.sort_by(f64::total_cmp);
        ((median - r).abs() > RADIUS_CHANGE * r && spread[spread.len() / 2] < 0.05 * median).then_some(median)
    }

    /// A leg through `seed`: marches both ways, then refits axis and radius on every surface point of its range.
    fn leg_from(&self, seed: &Window, r: f64, step: f64) -> Leg {
        let (forward, stop_max) = self.march(seed, r, step, 1.0);
        let (backward, stop_min) = self.march(seed, r, step, -1.0);
        let mut dir_sum = seed.dir;
        for w in forward.iter().chain(&backward) {
            dir_sum = add(&dir_sum, &orient(&w.dir, &seed.dir));
        }
        let dir = unit(&dir_sum).unwrap_or(seed.dir);
        let axial = |w: &Window| dot(&sub(&w.pos, &seed.pos), &dir);
        let lo = backward.iter().map(axial).fold(0.0, f64::min) - step / 2.0;
        let hi = forward.iter().map(axial).fold(0.0, f64::max) + step / 2.0;
        let mut leg = Leg {
            point: seed.pos,
            dir,
            radius: r,
            t_min: lo,
            t_max: hi,
            data_lo: lo,
            data_hi: hi,
            inliers: 0,
            rms: 0.0,
            coverage: seed.coverage,
            stop_min,
            stop_max,
        };
        self.refit(&mut leg, step);
        leg
    }

    /// Free-radius refit on the surface points inside the leg's range, re-selected twice on 3 rms.
    fn refit(&self, leg: &mut Leg, step: f64) {
        let mid = leg.at((leg.t_min + leg.t_max) / 2.0);
        let reach = (leg.t_max - leg.t_min) / 2.0 + step + 2.0 * leg.radius;
        let candidates: Vec<Vec3> = self.tree.within(&mid, reach).into_iter().map(|i| *self.tree.point(i)).collect();
        let mut band = self.band;
        let mut inliers: Vec<Vec3> = Vec::new();
        // Where the windows ran out of points (a pipe end) the data may reach 1.5 steps past the last window.
        let reach_min = leg.t_min - if matches!(leg.stop_min, Stop::NoPoints | Stop::Radius(_)) { 1.5 * step } else { 0.0 };
        let reach_max = leg.t_max + if matches!(leg.stop_max, Stop::NoPoints | Stop::Radius(_)) { 1.5 * step } else { 0.0 };
        for _ in 0..3 {
            inliers = candidates
                .iter()
                .filter(|p| {
                    let t = dot(&sub(p, &leg.point), &leg.dir);
                    t >= reach_min && t <= reach_max && leg.distance(p).abs() < band
                })
                .copied()
                .collect();
            if inliers.len() < cylinder::MIN_POINTS {
                return;
            }
            let model = cylinder::refine_cylinder(&inliers, &Cylinder { point: leg.point, axis: leg.dir, radius: leg.radius });
            let shift = dot(&sub(&model.point, &leg.point), &model.axis);
            leg.point = sub(&model.point, &scale(&model.axis, shift));
            (leg.dir, leg.radius) = (model.axis, model.radius);
            let residuals: Vec<f64> = inliers.iter().map(|p| leg.distance(p)).collect();
            leg.rms = rms(&residuals);
            band = self.band.min(3.0 * leg.rms).max(1e-6);
        }
        let mut axial: Vec<f64> = inliers.iter().map(|p| dot(&sub(p, &leg.point), &leg.dir)).collect();
        axial.sort_by(f64::total_cmp);
        let at = |q: f64| axial[((axial.len() - 1) as f64 * q).round() as usize];
        (leg.data_lo, leg.data_hi) = (at(0.002), at(0.998));
        leg.inliers = inliers.len();
        leg.coverage = coverage_of(&inliers, &leg.point, &leg.dir);
    }

    /// The leg after the bend at `from`'s forward end, or None (with a warning when the axes skew).
    fn next_leg(&self, from: &Leg, step: f64, seed: u64, warnings: &mut Vec<FitWarning>) -> Option<Leg> {
        let r = from.radius;
        let end = from.at(from.t_max);
        let candidates: Vec<Vec3> = self
            .tree
            .within(&end, LOOK_AHEAD_RADII * r + step)
            .into_iter()
            .map(|i| *self.tree.point(i))
            .filter(|p| !(dot(&sub(p, &from.point), &from.dir) <= from.t_max + step && from.distance(p).abs() < 3.0 * self.band))
            .collect();
        if candidates.len() < 2 * MIN_WINDOW_POINTS {
            return None;
        }
        let found = self.next_axis(&candidates, r, seed)?;
        let near: Vec<Vec3> = candidates.iter().filter(|p| found.distance(p).abs() < self.band).copied().collect();
        let centroid = mean(&near);
        let dir = orient(&found.axis, &sub(&centroid, &end));
        let turn = libm::acos(dot(&from.dir, &dir).clamp(-1.0, 1.0)).to_degrees();
        if turn <= self.settings.bend_detection_deg || turn > MAX_BEND_DEG {
            return None;
        }
        let pos = add(&found.point, &scale(&found.axis, dot(&sub(&centroid, &found.point), &found.axis)));
        let (window, _) = self.window(&pos, &dir, found.radius, step)?;
        let leg = self.leg_from(&window, found.radius, step);
        if leg.t_max - leg.t_min < MIN_LEG_STEPS * step {
            return None;
        }
        // The refitted axes must meet ahead of the leg's end, within the skew tolerance.
        let (s, _, gap) = closest_approach(&from.point, &from.dir, &leg.point, &leg.dir)?;
        if s < from.t_max - 3.0 * step || s > from.t_max + MAX_PI_RADII * r {
            return None;
        }
        let tolerance = self.settings.skew_tolerance.unwrap_or_else(|| 0.001_f64.max(r / 10.0));
        if gap > tolerance {
            warnings.push(FitWarning {
                code: "SCN_TRACE_SKEW",
                message: format!("the next straight misses the traced axis by {gap:.4} m (tolerance {tolerance:.4} m): trace stopped"),
            });
            return None;
        }
        Some(leg)
    }

    /// Legs after `first` (its forward end first), and why the chain stopped.
    fn grow(&self, first: &Leg, step: f64, warnings: &mut Vec<FitWarning>) -> (Vec<Leg>, Stop) {
        let mut legs: Vec<Leg> = Vec::new();
        let mut current = first.clone();
        let mut length = first.t_max - first.t_min;
        loop {
            if current.stop_max != Stop::Bend {
                return (legs, current.stop_max);
            }
            if legs.len() + 1 >= self.settings.max_legs {
                return (legs, Stop::MaxLegs);
            }
            if length > self.settings.max_length {
                return (legs, Stop::MaxLength);
            }
            let seed = self.settings.fit.seed.wrapping_add(legs.len() as u64 + 1);
            let Some(next) = self.next_leg(&current, step, seed, warnings) else { return (legs, Stop::Bend) };
            length += next.t_max - next.t_min;
            legs.push(next.clone());
            current = next;
        }
    }
}

/// The cylinder under `seed`: RANSAC on the points within `seedRadius`, then within half of it (three times) while the dominant cylinder is
/// not the one the seed lies on (clutter, a neighbouring pipe). The first failure is the one reported.
fn seed_cylinder(tree: &KdTree, seed: &Vec3, settings: &TraceSettings, band: f64) -> CloudResult<cylinder::CylinderFit> {
    let mut first_error: Option<CloudError> = None;
    for halvings in 0..4 {
        let radius = settings.seed_radius / f64::from(1u32 << halvings);
        let near: Vec<Vec3> = tree.within(seed, radius).into_iter().map(|i| *tree.point(i)).collect();
        match cylinder::fit(&near, &settings.fit) {
            Ok(found) if norm(&cross(&sub(seed, &found.axis_point), &found.axis_direction)) <= 1.6 * found.radius + band => {
                return Ok(found)
            }
            Ok(_) => {
                first_error.get_or_insert_with(|| {
                    CloudError::new("SCN_FIT_NO_MODEL", "the seed is not on the dominant cylinder around it: move the seed onto the pipe")
                });
            }
            Err(error) => {
                first_error.get_or_insert(error);
            }
        }
    }
    Err(first_error.unwrap_or_else(|| CloudError::new("SCN_FIT_NO_MODEL", "no cylinder at the seed")))
}

/// Traces the pipe through `seed` in `points` (document frame, metres).
/// @failure < 30 points near the seed -> SCN_FIT_TOO_FEW_POINTS; no cylinder on the seed -> SCN_FIT_NO_MODEL
pub fn trace(points: &[Vec3], seed: &Vec3, settings: &TraceSettings) -> CloudResult<TraceResult> {
    let tree = KdTree::build(points);
    let threshold = settings.fit.threshold(&tree);
    let first = seed_cylinder(&tree, seed, settings, threshold.value)?;
    let r = first.radius;
    let tracer = Tracer {
        tree: &tree,
        settings,
        band: threshold.value,
        max_windows: ((settings.max_length / r.max(1e-6)).ceil() as usize).clamp(8, MAX_WINDOWS),
    };
    let step = settings.step_length.unwrap_or(2.0 * r);
    if step.is_nan() || step <= 0.0 {
        return Err(CloudError::new("SCN_FIT_NO_MODEL", "stepLength must be > 0"));
    }
    let along = dot(&sub(seed, &first.axis_point), &first.axis_direction);
    let start = add(&first.axis_point, &scale(&first.axis_direction, along));
    let (window, _) = tracer
        .window(&start, &first.axis_direction, r, step)
        .ok_or_else(|| CloudError::new("SCN_FIT_NO_MODEL", "too few points on the pipe around the seed"))?;
    let seed_leg = tracer.leg_from(&window, r, step);
    let mut warnings = Vec::new();
    let (ahead, end_stop) = tracer.grow(&seed_leg, step, &mut warnings);
    let (behind, start_stop) = tracer.grow(&seed_leg.flipped(), step, &mut warnings);
    let mut legs: Vec<Leg> = behind.iter().rev().map(Leg::flipped).collect();
    legs.push(seed_leg);
    legs.extend(ahead);
    // Canonical direction: the chain runs from the lexicographically smaller end (x, y, z) to the larger, so a trace does not depend on
    // the orientation RANSAC gave the first axis.
    let (head, tail) = (legs[0].at(legs[0].data_lo), legs[legs.len() - 1].at(legs[legs.len() - 1].data_hi));
    let reverse = head.iter().zip(&tail).find(|(a, b)| (**a - **b).abs() > 1e-9).is_some_and(|(a, b)| a > b);
    let (stops, legs): ((Stop, Stop), Vec<Leg>) =
        if reverse { ((end_stop, start_stop), legs.iter().rev().map(Leg::flipped).collect()) } else { ((start_stop, end_stop), legs) };
    Ok(assemble(&tracer, &legs, points.len(), stops, (step, threshold), warnings))
}

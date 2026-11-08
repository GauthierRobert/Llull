//! Streamlines on a recorded field (TECHNICAL_SPEC §5.5, 12 CFD M3a): classical RK4 on the unit velocity direction
//! (`dp/ds = u / |u|`, fixed arc-length step), trilinear velocity, both directions from each seed. Stop reasons: the line left
//! the fluid box, entered a solid cell, met a speed below `min_speed` (stagnation), reached `max_length` or `max_steps`.
//! Output polylines are decimated to a chordal tolerance (Douglas-Peucker). The CPU path runs in f64, one independent
//! integration per seed: the result is bit-identical for any thread count (deterministic).

use crate::field::{FlowField, Miss};
use rayon::prelude::*;

/// Why one direction of a streamline ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stop {
    /// The direction was not traced (`forward` / `backward` only).
    NotTraced,
    LeftDomain,
    Wall,
    Stagnation,
    MaxLength,
    MaxSteps,
}

impl Stop {
    pub fn name(self) -> &'static str {
        match self {
            Stop::NotTraced => "not_traced",
            Stop::LeftDomain => "left_domain",
            Stop::Wall => "wall",
            Stop::Stagnation => "stagnation",
            Stop::MaxLength => "max_length",
            Stop::MaxSteps => "max_steps",
        }
    }

    /// The code the GPU kernel writes (`streamline.wgsl`).
    pub fn from_code(code: u32) -> Stop {
        match code {
            1 => Stop::LeftDomain,
            2 => Stop::Wall,
            3 => Stop::Stagnation,
            4 => Stop::MaxLength,
            5 => Stop::MaxSteps,
            _ => Stop::NotTraced,
        }
    }
}

impl From<Miss> for Stop {
    fn from(miss: Miss) -> Stop {
        match miss {
            Miss::Outside => Stop::LeftDomain,
            Miss::Solid => Stop::Wall,
        }
    }
}

/// Integration settings (case frame, metres, m/s).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Settings {
    pub step_m: f64,
    pub max_length_m: f64,
    /// Steps per direction.
    pub max_steps: usize,
    pub min_speed_ms: f64,
    pub forward: bool,
    pub backward: bool,
}

/// One traced direction: the points after the seed, the speed at each, why it ended and its length.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Half {
    pub points: Vec<[f64; 3]>,
    pub speeds: Vec<f64>,
    pub stop: Option<Stop>,
    pub length_m: f64,
}

/// Both directions of one seed; `seed_speed` is the miss when the seed itself has no velocity (in a body or outside).
#[derive(Debug, Clone, PartialEq)]
pub struct Traced {
    pub seed_speed: Result<f64, Stop>,
    pub backward: Half,
    pub forward: Half,
}

/// A decimated streamline: backward points reversed, the seed, the forward points.
#[derive(Debug, Clone, PartialEq)]
pub struct Line {
    pub points: Vec<[f64; 3]>,
    pub speeds: Vec<f64>,
    pub stop_backward: Stop,
    pub stop_forward: Stop,
    pub length_m: f64,
}

fn add(a: [f64; 3], b: [f64; 3], scale: f64) -> [f64; 3] {
    [a[0] + scale * b[0], a[1] + scale * b[1], a[2] + scale * b[2]]
}

fn norm(v: [f64; 3]) -> f64 {
    (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()
}

/// The unit direction (times `sign`) and the speed at `point`, or why the line stops there.
fn direction(field: &FlowField, point: [f64; 3], sign: f64, min_speed: f64) -> Result<([f64; 3], f64), Stop> {
    let velocity = field.velocity_strict(point).map_err(Stop::from)?;
    let speed = norm(velocity);
    if speed.is_nan() || speed < min_speed || speed == 0.0 {
        return Err(Stop::Stagnation);
    }
    let scale = sign / speed;
    Ok(([velocity[0] * scale, velocity[1] * scale, velocity[2] * scale], speed))
}

/// The speed at a seed, or why it has none (in a body, outside the fluid box).
pub fn seed_speed(field: &FlowField, seed: [f64; 3]) -> Result<f64, Stop> {
    field.velocity_strict(seed).map(norm).map_err(Stop::from)
}

/// One direction from `seed` (`sign` +1 forward, -1 backward).
pub fn trace_half(field: &FlowField, seed: [f64; 3], sign: f64, settings: &Settings) -> Half {
    let h = settings.step_m;
    let min = settings.min_speed_ms;
    let mut half = Half::default();
    let mut point = seed;
    for _ in 0..settings.max_steps {
        if half.length_m >= settings.max_length_m {
            half.stop = Some(Stop::MaxLength);
            return half;
        }
        let stage = || -> Result<[f64; 3], Stop> {
            let (k1, _) = direction(field, point, sign, min)?;
            let (k2, _) = direction(field, add(point, k1, h / 2.0), sign, min)?;
            let (k3, _) = direction(field, add(point, k2, h / 2.0), sign, min)?;
            let (k4, _) = direction(field, add(point, k3, h), sign, min)?;
            let sum = [
                k1[0] + 2.0 * k2[0] + 2.0 * k3[0] + k4[0],
                k1[1] + 2.0 * k2[1] + 2.0 * k3[1] + k4[1],
                k1[2] + 2.0 * k2[2] + 2.0 * k3[2] + k4[2],
            ];
            Ok(add(point, sum, h / 6.0))
        };
        let next = match stage().and_then(|next| direction(field, next, sign, min).map(|(_, speed)| (next, speed))) {
            Ok(found) => found,
            Err(stop) => {
                half.stop = Some(stop);
                return half;
            }
        };
        half.length_m += norm([next.0[0] - point[0], next.0[1] - point[1], next.0[2] - point[2]]);
        point = next.0;
        half.points.push(point);
        half.speeds.push(next.1);
    }
    half.stop = Some(Stop::MaxSteps);
    half
}

/// Both directions of every seed, seeds in parallel (results in seed order).
pub fn trace_cpu(field: &FlowField, seeds: &[[f64; 3]], settings: &Settings) -> Vec<Traced> {
    seeds
        .par_iter()
        .map(|seed| {
            let seed_speed = seed_speed(field, *seed);
            let untraced = Half { stop: Some(Stop::NotTraced), ..Half::default() };
            if seed_speed.is_err() {
                return Traced { seed_speed, backward: untraced.clone(), forward: untraced };
            }
            let run = |enabled: bool, sign: f64| if enabled { trace_half(field, *seed, sign, settings) } else { untraced.clone() };
            Traced { seed_speed, backward: run(settings.backward, -1.0), forward: run(settings.forward, 1.0) }
        })
        .collect()
}

fn distance_to_segment(p: [f64; 3], a: [f64; 3], b: [f64; 3]) -> f64 {
    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    let length2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
    let t = if length2 > 0.0 { ((ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / length2).clamp(0.0, 1.0) } else { 0.0 };
    norm([ap[0] - t * ab[0], ap[1] - t * ab[1], ap[2] - t * ab[2]])
}

/// Indices of the points Douglas-Peucker keeps at `tolerance` (first and last always kept; ascending).
pub fn decimate(points: &[[f64; 3]], tolerance: f64) -> Vec<usize> {
    if points.len() <= 2 {
        return (0..points.len()).collect();
    }
    let mut keep = vec![false; points.len()];
    keep[0] = true;
    keep[points.len() - 1] = true;
    let mut stack = vec![(0usize, points.len() - 1)];
    while let Some((first, last)) = stack.pop() {
        let mut worst = (0.0, 0usize);
        for index in first + 1..last {
            let distance = distance_to_segment(points[index], points[first], points[last]);
            if distance > worst.0 {
                worst = (distance, index);
            }
        }
        if worst.0 > tolerance {
            keep[worst.1] = true;
            stack.push((first, worst.1));
            stack.push((worst.1, last));
        }
    }
    keep.iter().enumerate().filter(|(_, kept)| **kept).map(|(index, _)| index).collect()
}

/// The decimated polyline of one traced seed (no point when the seed has no velocity).
pub fn polyline(seed: [f64; 3], traced: &Traced, tolerance: f64) -> Line {
    let stop_of = |half: &Half| half.stop.unwrap_or(Stop::NotTraced);
    let Ok(seed_speed) = traced.seed_speed else {
        let stop = traced.seed_speed.err().unwrap_or(Stop::NotTraced);
        return Line { points: vec![], speeds: vec![], stop_backward: stop, stop_forward: stop, length_m: 0.0 };
    };
    let mut points: Vec<[f64; 3]> = traced.backward.points.iter().rev().copied().collect();
    let mut speeds: Vec<f64> = traced.backward.speeds.iter().rev().copied().collect();
    points.push(seed);
    speeds.push(seed_speed);
    points.extend_from_slice(&traced.forward.points);
    speeds.extend_from_slice(&traced.forward.speeds);
    let kept = decimate(&points, tolerance);
    Line {
        points: kept.iter().map(|index| points[*index]).collect(),
        speeds: kept.iter().map(|index| speeds[*index]).collect(),
        stop_backward: stop_of(&traced.backward),
        stop_forward: stop_of(&traced.forward),
        length_m: traced.backward.length_m + traced.forward.length_m,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grid::Grid;

    /// Solid-body rotation about the z axis through (cx, cy) plus a uniform axial speed: helices of known radius and pitch.
    fn swirl(axial: f32) -> FlowField {
        let grid = Grid::covering([0.0; 3], [2.0, 2.0, 4.0], 0.05);
        let n = grid.cells();
        let centre = |cell: usize| {
            let (i, j, k) = grid.coords(cell);
            grid.centre(i, j, k)
        };
        FlowField {
            ux: (0..n).map(|c| -(centre(c)[1] - 1.0) as f32).collect(),
            uy: (0..n).map(|c| (centre(c)[0] - 1.0) as f32).collect(),
            uz: vec![axial; n],
            p: vec![0.0; n],
            valid: vec![true; n],
            grid,
            mirrors: vec![],
        }
    }

    fn settings(max_steps: usize) -> Settings {
        Settings { step_m: 0.01, max_length_m: 100.0, max_steps, min_speed_ms: 1e-6, forward: true, backward: true }
    }

    #[test]
    fn a_rotation_field_gives_circles_of_constant_radius() {
        // Linear field: the trilinear velocity is exact, so RK4 keeps the radius to its O(h^4) truncation.
        let field = swirl(0.0);
        let seed = [1.5, 1.0, 2.0];
        let traced = &trace_cpu(&field, &[seed], &settings(400))[0];
        assert_eq!(traced.forward.stop, Some(Stop::MaxSteps));
        let radius = |p: &[f64; 3]| ((p[0] - 1.0).powi(2) + (p[1] - 1.0).powi(2)).sqrt();
        for point in traced.forward.points.iter().chain(&traced.backward.points) {
            assert!((radius(point) - 0.5).abs() < 1e-8, "radius {}", radius(point));
            assert!((point[2] - 2.0).abs() < 1e-12);
        }
        assert!((traced.forward.length_m - 4.0).abs() < 1e-4, "chord sum {}", traced.forward.length_m);
        let line = polyline(seed, traced, 0.0125);
        assert!(line.points.len() < 801 && line.points.len() > 8, "{}", line.points.len());
        assert_eq!(line.stop_backward, Stop::MaxSteps);
    }

    #[test]
    fn lines_stop_at_the_domain_edge_at_max_length_and_in_stagnation() {
        let field = swirl(1.0);
        let traced = &trace_cpu(&field, &[[1.0, 1.0, 2.0]], &settings(10_000))[0];
        assert_eq!(traced.forward.stop, Some(Stop::LeftDomain), "the axis line runs straight up and out");
        assert_eq!(traced.backward.stop, Some(Stop::LeftDomain));
        let last = traced.forward.points.last().unwrap();
        assert!(last[2] > 3.8 && last[2] < 3.95, "{last:?}");
        let short = Settings { max_length_m: 0.5, ..settings(10_000) };
        let traced = &trace_cpu(&field, &[[1.0, 1.0, 2.0]], &short)[0];
        assert_eq!(traced.forward.stop, Some(Stop::MaxLength));
        assert!((traced.forward.length_m - 0.5).abs() < 0.011);
        let still = swirl(0.0);
        let traced = &trace_cpu(&still, &[[1.0, 1.0, 2.0]], &settings(10))[0];
        assert_eq!(traced.forward.stop, Some(Stop::Stagnation));
        let outside = &trace_cpu(&still, &[[5.0, 1.0, 2.0]], &settings(10))[0];
        assert_eq!(outside.seed_speed, Err(Stop::LeftDomain));
        assert!(polyline([5.0, 1.0, 2.0], outside, 0.01).points.is_empty());
    }

    #[test]
    fn a_solid_cell_stops_the_line_and_results_do_not_depend_on_threads() {
        let mut field = swirl(1.0);
        for (i, j) in [(19, 19), (19, 20), (19, 21), (20, 19), (20, 20), (20, 21), (21, 19), (21, 20), (21, 21)] {
            let blocked = field.grid.index(i, j, 60);
            field.valid[blocked] = false;
        }
        let seeds: Vec<[f64; 3]> = (0..32).map(|s| [1.0 + 0.001 * f64::from(s % 3), 1.0, 2.0]).collect();
        let traced = trace_cpu(&field, &seeds, &settings(1000));
        assert_eq!(traced[0].forward.stop, Some(Stop::Wall));
        let single = rayon::ThreadPoolBuilder::new().num_threads(1).build().unwrap().install(|| trace_cpu(&field, &seeds, &settings(1000)));
        assert_eq!(single, traced);
    }

    #[test]
    fn decimation_keeps_the_ends_and_the_corners() {
        let points = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [2.0, 0.0, 0.0], [2.0, 1.0, 0.0], [2.0, 2.0, 0.0]];
        assert_eq!(decimate(&points, 0.1), vec![0, 2, 4]);
        assert_eq!(decimate(&points[..2], 0.1), vec![0, 1]);
        assert_eq!(decimate(&points, 10.0), vec![0, 4]);
    }
}

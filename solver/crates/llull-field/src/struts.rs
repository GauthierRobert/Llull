//! Distance to a set of 3MF-style beams: twin of `packages/core/src/geometry/field/strutSet.ts` (frustum + cap geometry, periodic cell
//! folding, 4x4x4 bucket prefilter). Same formulas and evaluation order, so every distance is bit-identical.

use crate::jsnum::{hypot2, hypot3, jmax, jmin};
use crate::tape::StrutSet;

const BUCKETS: usize = 4;

#[derive(Clone, Copy)]
pub struct Segment {
    a: [f64; 3],
    d: [f64; 3],
    length: f64,
    ra: f64,
    rb: f64,
    sphere: bool,
}

/// A beam as listed in the set: end points, end radii, cap.
struct Ends {
    a: [f64; 3],
    b: [f64; 3],
    ra: f64,
    rb: f64,
    sphere: bool,
}

fn segment_of(a: [f64; 3], b: [f64; 3], ra: f64, rb: f64, sphere: bool) -> Segment {
    let d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    Segment { a, d, length: hypot3(d[0], d[1], d[2]), ra, rb, sphere }
}

fn plane_segment_distance(s: f64, rho: f64, s1: f64, r1: f64, s2: f64, r2: f64) -> f64 {
    let (ex, ey) = (s2 - s1, r2 - r1);
    let length_sq = ex * ex + ey * ey;
    let t = if length_sq == 0.0 { 0.0 } else { jmin(1.0, jmax(0.0, ((s - s1) * ex + (rho - r1) * ey) / length_sq)) };
    hypot2(s - (s1 + ex * t), rho - (r1 + ey * t))
}

fn frustum_distance(seg: &Segment, s: f64, rho: f64, radius: f64) -> f64 {
    let (ra, rb) = if radius >= 0.0 { (radius, radius) } else { (seg.ra, seg.rb) };
    let along = seg.length;
    let ball = |centre: f64, r: f64| hypot2(s - centre, rho) - r;
    if along == 0.0 {
        return ball(0.0, jmax(ra, rb));
    }
    let sphere_caps = seg.sphere || radius >= 0.0;
    if sphere_caps && radius >= 0.0 {
        let t = jmin(along, jmax(0.0, s));
        return hypot2(s - t, rho) - ra;
    }
    let inside = s >= 0.0 && s <= along && rho <= ra + ((rb - ra) * s) / along;
    let edge = jmin(
        jmin(plane_segment_distance(s, rho, 0.0, ra, along, rb), plane_segment_distance(s, rho, 0.0, 0.0, 0.0, ra)),
        plane_segment_distance(s, rho, along, 0.0, along, rb),
    );
    let butt = if inside { -edge } else { edge };
    if sphere_caps {
        jmin(jmin(butt, ball(0.0, ra)), ball(along, rb))
    } else {
        butt
    }
}

fn distance_to_segments(segments: &[Segment], x: f64, y: f64, z: f64, radius: f64) -> f64 {
    let mut best = f64::INFINITY;
    for seg in segments {
        let (px, py, pz) = (x - seg.a[0], y - seg.a[1], z - seg.a[2]);
        let s = if seg.length == 0.0 { 0.0 } else { (px * seg.d[0] + py * seg.d[1] + pz * seg.d[2]) / seg.length };
        let rho = jmax(px * px + py * py + pz * pz - s * s, 0.0).sqrt();
        let d = frustum_distance(seg, s, rho, radius);
        if d < best {
            best = d;
        }
    }
    best
}

fn point_segment_distance(seg: &Segment, x: f64, y: f64, z: f64) -> f64 {
    let (px, py, pz) = (x - seg.a[0], y - seg.a[1], z - seg.a[2]);
    let t = if seg.length == 0.0 {
        0.0
    } else {
        jmin(1.0, jmax(0.0, (px * seg.d[0] + py * seg.d[1] + pz * seg.d[2]) / (seg.length * seg.length)))
    };
    hypot3(px - t * seg.d[0], py - t * seg.d[1], pz - t * seg.d[2])
}

fn box_gap(seg: &Segment, lo: [f64; 3], hi: [f64; 3]) -> f64 {
    let gap = |axis: usize| {
        let (a, b) = (seg.a[axis], seg.a[axis] + seg.d[axis]);
        jmax(jmax(jmin(a, b) - hi[axis], lo[axis] - jmax(a, b)), 0.0)
    };
    hypot3(gap(0), gap(1), gap(2))
}

fn bucket_lists(segments: &[Segment], cell: [f64; 3]) -> Vec<Vec<Segment>> {
    let size = [cell[0] / BUCKETS as f64, cell[1] / BUCKETS as f64, cell[2] / BUCKETS as f64];
    let radii: Vec<f64> = segments.iter().flat_map(|s| [s.ra, s.rb]).collect();
    let spread = if radii.is_empty() {
        0.0
    } else {
        radii.iter().copied().fold(f64::NEG_INFINITY, jmax) - radii.iter().copied().fold(f64::INFINITY, jmin)
    };
    let mut lists = Vec::with_capacity(BUCKETS * BUCKETS * BUCKETS);
    for k in 0..BUCKETS {
        for j in 0..BUCKETS {
            for i in 0..BUCKETS {
                let lo = [i as f64 * size[0], j as f64 * size[1], k as f64 * size[2]];
                let hi = [lo[0] + size[0], lo[1] + size[1], lo[2] + size[2]];
                let mut corners = Vec::with_capacity(8);
                for &x in &[lo[0], hi[0]] {
                    for &y in &[lo[1], hi[1]] {
                        for &z in &[lo[2], hi[2]] {
                            corners.push([x, y, z]);
                        }
                    }
                }
                let bound = segments
                    .iter()
                    .map(|seg| corners.iter().map(|c| point_segment_distance(seg, c[0], c[1], c[2])).fold(f64::NEG_INFINITY, jmax))
                    .fold(f64::INFINITY, jmin);
                lists.push(segments.iter().filter(|seg| box_gap(seg, lo, hi) <= bound + spread + 1e-9).copied().collect());
            }
        }
    }
    lists
}

fn segment_touches_cell(a: [f64; 3], b: [f64; 3], cell: [f64; 3], reach: f64) -> bool {
    let slack = reach + jmax(jmax(cell[0], cell[1]), cell[2]) * 1e-9;
    (0..3).all(|axis| !(jmax(a[axis], b[axis]) < -slack || jmin(a[axis], b[axis]) > cell[axis] + slack))
}

pub enum StrutEval {
    Explicit(Vec<Segment>),
    Periodic { cell: [f64; 3], origin: [f64; 3], all: Vec<Segment>, buckets: Vec<Vec<Segment>> },
}

impl StrutEval {
    pub fn new(set: &StrutSet) -> StrutEval {
        let node = |index: usize| set.nodes.get(index).copied().unwrap_or([0.0; 3]);
        let own: Vec<Ends> =
            set.beams.iter().map(|beam| Ends { a: node(beam.a), b: node(beam.b), ra: beam.ra, rb: beam.rb, sphere: beam.sphere }).collect();
        let Some((cell, origin)) = set.periodic else {
            return StrutEval::Explicit(own.iter().map(|e| segment_of(e.a, e.b, e.ra, e.rb, e.sphere)).collect());
        };
        let reach = own.iter().flat_map(|e| [e.ra, e.rb]).fold(0.0, jmax);
        let mut all = Vec::new();
        for i in -1..=1 {
            for j in -1..=1 {
                for k in -1..=1 {
                    let shift = [f64::from(i) * cell[0], f64::from(j) * cell[1], f64::from(k) * cell[2]];
                    for beam in &own {
                        let a = [beam.a[0] + shift[0], beam.a[1] + shift[1], beam.a[2] + shift[2]];
                        let b = [beam.b[0] + shift[0], beam.b[1] + shift[1], beam.b[2] + shift[2]];
                        if segment_touches_cell(a, b, cell, reach) {
                            all.push(segment_of(a, b, beam.ra, beam.rb, beam.sphere));
                        }
                    }
                }
            }
        }
        let buckets = bucket_lists(&all, cell);
        StrutEval::Periodic { cell, origin, all, buckets }
    }

    /// Signed distance at (x, y, z); `radius` >= 0 replaces every beam radius (spherical caps), -1 keeps the beam radii.
    pub fn distance(&self, x: f64, y: f64, z: f64, radius: f64) -> f64 {
        match self {
            StrutEval::Explicit(segments) => distance_to_segments(segments, x, y, z, radius),
            StrutEval::Periodic { cell, origin, all, buckets } => {
                let (u, v, w) = (x - origin[0], y - origin[1], z - origin[2]);
                let (qx, qy, qz) =
                    (u - (u / cell[0]).floor() * cell[0], v - (v / cell[1]).floor() * cell[1], w - (w / cell[2]).floor() * cell[2]);
                let at = |q: f64, size: f64| jmin((BUCKETS - 1) as f64, ((q / size) * BUCKETS as f64).floor());
                let b = BUCKETS as f64;
                let index = at(qx, cell[0]) + b * (at(qy, cell[1]) + b * at(qz, cell[2]));
                let list =
                    if index >= 0.0 && index.fract() == 0.0 && (index as usize) < buckets.len() { &buckets[index as usize] } else { all };
                distance_to_segments(list, qx, qy, qz, radius)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tape::Beam;

    fn beam(a: usize, b: usize, ra: f64, rb: f64, sphere: bool) -> Beam {
        Beam { a, b, ra, rb, sphere }
    }

    #[test]
    fn explicit_beam_distances_butt_sphere_and_replaced_radius() {
        let set = StrutSet { periodic: None, nodes: vec![[0.0, 0.0, 0.0], [10.0, 0.0, 0.0]], beams: vec![beam(0, 1, 1.0, 1.0, false)] };
        let eval = StrutEval::new(&set);
        assert!((eval.distance(5.0, 3.0, 0.0, -1.0) - 2.0).abs() < 1e-12, "radial distance minus radius");
        assert!((eval.distance(5.0, 0.0, 0.0, -1.0) + 1.0).abs() < 1e-12, "on the axis: inside by the radius");
        assert!((eval.distance(12.0, 0.0, 0.0, -1.0) - 2.0).abs() < 1e-12, "past a butt end: distance to the end disc");
        let ball = StrutEval::new(&StrutSet { beams: vec![beam(0, 1, 1.0, 1.0, true)], ..set.clone() });
        assert!((ball.distance(12.0, 0.0, 0.0, -1.0) - 1.0).abs() < 1e-12, "past a sphere cap");
        assert!((eval.distance(5.0, 3.0, 0.0, 0.5) - 2.5).abs() < 1e-12, "a radius register replaces the beam radii");
        let degenerate = StrutEval::new(&StrutSet { beams: vec![beam(0, 0, 1.0, 2.0, true)], ..set });
        assert!((degenerate.distance(4.0, 0.0, 0.0, -1.0) - 2.0).abs() < 1e-12, "a zero-length beam is a ball of the larger radius");
    }

    #[test]
    fn a_periodic_cubic_cell_repeats_and_never_exceeds_the_explicit_distance() {
        let set = StrutSet {
            periodic: Some(([2.0, 2.0, 2.0], [0.0, 0.0, 0.0])),
            nodes: vec![[0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [0.0, 2.0, 0.0], [0.0, 0.0, 2.0]],
            beams: vec![beam(0, 1, 0.2, 0.2, true), beam(0, 2, 0.2, 0.2, true), beam(0, 3, 0.2, 0.2, true)],
        };
        let eval = StrutEval::new(&set);
        let on_edge = eval.distance(1.0, 0.0, 0.0, -1.0);
        assert!((on_edge + 0.2).abs() < 1e-12);
        assert_eq!(eval.distance(7.0, 4.0, -6.0, -1.0).to_bits(), eval.distance(1.0, 0.0, 0.0, -1.0).to_bits());
        assert!((eval.distance(1.0, 1.0, 1.0, -1.0) - (2.0_f64.sqrt() - 0.2)).abs() < 1e-12);
        let nan = eval.distance(f64::NAN, 0.0, 0.0, -1.0);
        assert!(nan.is_nan() || nan == f64::INFINITY, "a NaN point falls back to the whole list");
    }
}

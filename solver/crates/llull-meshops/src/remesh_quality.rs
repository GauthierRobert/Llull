//! Triangle quality, the acceptance test of a replaced triangle and the sizing field of an adaptive remesh (twins of the helpers of `remesh.ts`).

use crate::geom::{dot, js_max, js_min, length, normal_of, or_one, Vec3};
use crate::remesh_types::EdgeStats;
use llull_jsmath::{acos, hypot};

/// A replacement triangle below this quality is accepted only when it is no worse than what it replaces.
pub const QUALITY_FLOOR: f64 = 0.15;

/// 4 sqrt(3) area / sum of squared edges: 1 for an equilateral triangle, 0 for a sliver.
pub fn quality(a: Vec3, b: Vec3, c: Vec3) -> f64 {
    let sum = (a[0] - b[0]) * (a[0] - b[0])
        + (a[1] - b[1]) * (a[1] - b[1])
        + (a[2] - b[2]) * (a[2] - b[2])
        + (b[0] - c[0]) * (b[0] - c[0])
        + (b[1] - c[1]) * (b[1] - c[1])
        + (b[2] - c[2]) * (b[2] - c[2])
        + (c[0] - a[0]) * (c[0] - a[0])
        + (c[1] - a[1]) * (c[1] - a[1])
        + (c[2] - a[2]) * (c[2] - a[2]);
    if sum > 0.0 {
        (2.0 * 3f64.sqrt() * length(normal_of(a, b, c))) / sum
    } else {
        0.0
    }
}

/// A replacement triangle is acceptable when it keeps the orientation and is not a sliver (or is no worse than what it replaces).
pub fn acceptable(before: [Vec3; 3], after: [Vec3; 3]) -> bool {
    if dot(normal_of(before[0], before[1], before[2]), normal_of(after[0], after[1], after[2])) <= 0.0 {
        return false;
    }
    let q = quality(after[0], after[1], after[2]);
    q >= QUALITY_FLOOR || q >= quality(before[0], before[1], before[2])
}

/// Sizing parameters of an adaptive remesh.
#[derive(Debug, Clone, Copy)]
pub struct Adaptive {
    pub min_edge: f64,
    pub max_edge: f64,
    pub approx_error: f64,
}

/// Per-vertex target edge length of an adaptive remesh, from the input's curvature (`sizingField`).
pub fn sizing_field(positions: &[f64], indices: &[u32], adaptive: Adaptive) -> Vec<f64> {
    let count = positions.len() / 3;
    let at = |v: u32| {
        let i = v as usize * 3;
        [positions[i], positions[i + 1], positions[i + 2]]
    };
    let mut normals = vec![0.0f64; count * 3];
    for face in indices.chunks_exact(3) {
        let n = normal_of(at(face[0]), at(face[1]), at(face[2]));
        for &v in face {
            for (a, component) in n.iter().enumerate() {
                normals[v as usize * 3 + a] += component;
            }
        }
    }
    let unit = |v: u32| {
        let i = v as usize * 3;
        let l = or_one(hypot(&[normals[i], normals[i + 1], normals[i + 2]]));
        [normals[i] / l, normals[i + 1] / l, normals[i + 2] / l]
    };
    let mut kappa = vec![0.0f64; count];
    for face in indices.chunks_exact(3) {
        for k in 0..3 {
            let (a, b) = (face[k], face[(k + 1) % 3]);
            let (pa, pb) = (at(a), at(b));
            let edge = hypot(&[pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]]);
            if edge == 0.0 {
                continue;
            }
            let angle = acos(js_max(-1.0, js_min(1.0, dot(unit(a), unit(b)))));
            kappa[a as usize] = js_max(kappa[a as usize], angle / edge);
            kappa[b as usize] = js_max(kappa[b as usize], angle / edge);
        }
    }
    let Adaptive { min_edge: lo, max_edge: hi, approx_error: eps } = adaptive;
    kappa
        .into_iter()
        .map(|k| {
            if k <= 1e-12 {
                return hi;
            }
            let square = (6.0 * eps) / k - 3.0 * eps * eps;
            js_min(hi, js_max(lo, if square > 0.0 { square.sqrt() } else { lo }))
        })
        .collect()
}

/// Valence, boundary flag and number of constrained edges of a vertex.
pub type VertexStats = (i64, bool, usize);

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Free,
    Slide,
    Fixed,
}

pub enum Sizing {
    Uniform(f64),
    Field { sizes: Vec<f64>, max_edge: f64 },
}

pub fn edge_key(a: u32, b: u32) -> u64 {
    let (lo, hi) = if a < b { (a, b) } else { (b, a) };
    (u64::from(lo) << 32) | u64::from(hi)
}

pub fn midpoint(a: Vec3, b: Vec3) -> Vec3 {
    [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0, (a[2] + b[2]) / 2.0]
}

/// The statistics of the edge lengths of a remesh result (the lengths are sorted here: the percentiles are the entries at 5 % and 95 %).
pub fn summarize(mut lengths: Vec<f64>) -> EdgeStats {
    lengths.sort_unstable_by(f64::total_cmp);
    let n = lengths.len();
    let at = |q: f64| if n == 0 { 0.0 } else { lengths[(n - 1).min((q * n as f64).floor() as usize)] };
    let mean = if n == 0 { 0.0 } else { lengths.iter().fold(0.0, |s, v| s + v) / n as f64 };
    EdgeStats {
        min: lengths.first().copied().unwrap_or(0.0),
        max: lengths.last().copied().unwrap_or(0.0),
        mean,
        p5: at(0.05),
        p95: at(0.95),
    }
}

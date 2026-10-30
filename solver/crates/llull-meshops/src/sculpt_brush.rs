//! The brushes of `sculpt` (twin of the `Sculptor` class of `sculpt.ts`): the displacement every vertex inside one stamp receives, computed from the positions as
//! they stand at the start of the stamp. Every sum keeps the order of the TypeScript code (faces ascending, the ring of a vertex ascending, the per-vertex normal over
//! its face list in corner order, duplicates included), and the per-vertex work is independent, so the bytes do not depend on the thread count.

use crate::geom::{dot, js_min, length, Sphere, Vec3};
use rayon::prelude::*;
use serde::Deserialize;

/// Taubin pass-band frequency of the smooth brush: the TypeScript oracle's `taubinMu(lambda, 0.1)` in `packages/core/src/geometry/mesh/sculpt.ts` (change both or neither).
const TAUBIN_PASS_BAND: f64 = 0.1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Brush {
    Draw,
    Inflate,
    Grab,
    Smooth,
    Flatten,
    Pinch,
    Crease,
    Layer,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Falloff {
    Constant,
    Linear,
    Smooth,
    Sphere,
}

/// The mirror plane through the origin: yz mirrors x, xz mirrors y, xy mirrors z.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Plane {
    Yz,
    Xz,
    Xy,
}

impl Plane {
    pub fn axis(self) -> usize {
        match self {
            Plane::Yz => 0,
            Plane::Xz => 1,
            Plane::Xy => 2,
        }
    }
}

/// `direction` of the TypeScript op: per-vertex normals, the area-weighted normal of the brush, or a fixed vector.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Direction {
    Normal,
    AreaNormal,
    Vector(Vec3),
}

/// The brush settings one stamp needs.
pub struct Settings {
    pub brush: Brush,
    pub radius: f64,
    pub strength: f64,
    pub falloff: Falloff,
    pub direction: Direction,
    pub taubin: bool,
    pub max_height: Option<f64>,
    pub mask: Option<Sphere>,
    pub plane_point: Option<Vec3>,
}

/// `falloffOf`: the weight at `t` = distance / radius (0 from 1 on).
fn falloff_of(kind: Falloff, t: f64) -> f64 {
    if t >= 1.0 {
        return 0.0;
    }
    match kind {
        Falloff::Constant => 1.0,
        Falloff::Linear => 1.0 - t,
        Falloff::Smooth => (1.0 - t * t) * (1.0 - t * t),
        Falloff::Sphere => (1.0 - t * t).sqrt(),
    }
}

fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/// `unit`: the vector over its length, the zero vector when the length is not above 0 (or NaN).
fn unit(a: Vec3) -> Vec3 {
    let len = length(a);
    if len > 0.0 {
        [a[0] / len, a[1] / len, a[2] / len]
    } else {
        [0.0, 0.0, 0.0]
    }
}

fn along(n: Vec3, amount: f64) -> Vec3 {
    [n[0] * amount, n[1] * amount, n[2] * amount]
}

/// Rows of numbers per vertex in one flat array.
pub struct Rows {
    start: Vec<usize>,
    data: Vec<u32>,
}

impl Rows {
    fn row(&self, v: usize) -> &[u32] {
        &self.data[self.start[v]..self.start[v + 1]]
    }

    /// Rows from (vertex, value) pairs sorted by vertex (and by value within a vertex).
    fn from_sorted(vertices: usize, pairs: impl Iterator<Item = (u32, u32)>) -> Self {
        let mut start = vec![0usize; vertices + 1];
        let mut data = Vec::new();
        for (v, value) in pairs {
            start[v as usize + 1] += 1;
            data.push(value);
        }
        for v in 0..vertices {
            start[v + 1] += start[v];
        }
        Self { start, data }
    }
}

/// `topologyOf().vertexFaces`: the faces of each vertex in face order, once per corner (a face with a repeated corner is listed twice).
pub fn vertex_faces(vertices: usize, indices: &[u32]) -> Rows {
    let mut start = vec![0usize; vertices + 1];
    for &v in indices {
        start[v as usize + 1] += 1;
    }
    for v in 0..vertices {
        start[v + 1] += start[v];
    }
    let mut next = start.clone();
    let mut data = vec![0u32; indices.len()];
    for (corner, &v) in indices.iter().enumerate() {
        data[next[v as usize]] = (corner / 3) as u32;
        next[v as usize] += 1;
    }
    Rows { start, data }
}

/// `topologyOf().neighbours`: the other two corners of every face at each vertex, ascending and without repeats (a repeated corner makes a vertex its own neighbour).
pub fn neighbours(vertices: usize, indices: &[u32]) -> Rows {
    let mut pairs: Vec<u64> = Vec::with_capacity(indices.len() * 2);
    for c in indices.chunks_exact(3) {
        for k in 0..3 {
            for other in [c[(k + 1) % 3], c[(k + 2) % 3]] {
                pairs.push((u64::from(c[k]) << 32) | u64::from(other));
            }
        }
    }
    pairs.par_sort_unstable();
    pairs.dedup();
    Rows::from_sorted(vertices, pairs.into_iter().map(|p| ((p >> 32) as u32, p as u32)))
}

/// What one stamp computes once for all its vertices.
struct Stamp {
    centre: Vec3,
    n_bar: Vec3,
    fixed: Option<Vec3>,
    plane_point: Vec3,
}

pub struct Sculptor<'a> {
    pub position: Vec<Vec3>,
    base: Vec<Vec3>,
    indices: &'a [u32],
    faces_of: Rows,
    ring_of: Option<Rows>,
    settings: &'a Settings,
}

impl<'a> Sculptor<'a> {
    pub fn new(positions: &[f64], indices: &'a [u32], settings: &'a Settings) -> Self {
        let position: Vec<Vec3> = positions.chunks_exact(3).map(|p| [p[0], p[1], p[2]]).collect();
        let vertices = position.len();
        Self {
            base: position.clone(),
            faces_of: vertex_faces(vertices, indices),
            ring_of: (settings.brush == Brush::Smooth).then(|| neighbours(vertices, indices)),
            position,
            indices,
            settings,
        }
    }

    /// Twice the area vector of face `f`.
    fn face_vector(&self, f: u32) -> Vec3 {
        let corner = |k: usize| self.position[self.indices[f as usize * 3 + k] as usize];
        let a = corner(0);
        cross(sub(corner(1), a), sub(corner(2), a))
    }

    fn vertex_normal(&self, v: usize) -> Vec3 {
        let mut sum = [0.0, 0.0, 0.0];
        for &f in self.faces_of.row(v) {
            let n = self.face_vector(f);
            sum = [sum[0] + n[0], sum[1] + n[1], sum[2] + n[2]];
        }
        unit(sum)
    }

    /// One stamp's displacement of every vertex in the brush, ascending by vertex, from the current positions. `hint` is the fixed vector of a vector direction.
    pub fn displacements(&self, centre: Vec3, hint: Option<Vec3>) -> Vec<(u32, Vec3)> {
        let s = self.settings;
        let in_brush: Vec<(u32, f64)> = self
            .position
            .par_iter()
            .enumerate()
            .filter_map(|(v, &p)| {
                let t = length(sub(p, centre)) / s.radius;
                let weight = falloff_of(s.falloff, t);
                (t < 1.0 && s.mask.is_none_or(|region| region.contains(p))).then_some((v as u32, weight))
            })
            .collect();
        let mut faces: Vec<u32> = in_brush.iter().flat_map(|&(v, _)| self.faces_of.row(v as usize).iter().copied()).collect();
        faces.par_sort_unstable();
        faces.dedup();
        let mut area_normal = [0.0, 0.0, 0.0];
        let mut plane_point = [0.0, 0.0, 0.0];
        let mut area_sum = 0.0;
        for &f in &faces {
            let n = self.face_vector(f);
            let area = length(n) / 2.0;
            let corner = |k: usize| self.position[self.indices[f as usize * 3 + k] as usize];
            let (a, b, c) = (corner(0), corner(1), corner(2));
            area_normal = [area_normal[0] + n[0], area_normal[1] + n[1], area_normal[2] + n[2]];
            plane_point = [
                plane_point[0] + (area * (a[0] + b[0] + c[0])) / 3.0,
                plane_point[1] + (area * (a[1] + b[1] + c[1])) / 3.0,
                plane_point[2] + (area * (a[2] + b[2] + c[2])) / 3.0,
            ];
            area_sum += area;
        }
        let n_bar = unit(hint.unwrap_or(area_normal));
        if area_sum > 0.0 {
            plane_point = [plane_point[0] / area_sum, plane_point[1] / area_sum, plane_point[2] / area_sum];
        }
        let stamp = Stamp { centre, n_bar, fixed: hint, plane_point: s.plane_point.unwrap_or(plane_point) };
        in_brush.par_iter().map(|&(v, weight)| (v, self.displacement(v as usize, weight, &stamp))).collect()
    }

    /// The mean of the ring of `v` minus `base`, times `amount` (`step` of the smooth brush).
    fn smooth_step(&self, v: usize, amount: f64, base: Vec3) -> Vec3 {
        let ring = self.ring_of.as_ref().map_or(&[][..], |rows| rows.row(v));
        if ring.is_empty() {
            return [0.0, 0.0, 0.0];
        }
        let mut mean = [0.0, 0.0, 0.0];
        for &n in ring {
            let p = self.position[n as usize];
            mean = [mean[0] + p[0], mean[1] + p[1], mean[2] + p[2]];
        }
        let count = ring.len() as f64;
        along(sub([mean[0] / count, mean[1] / count, mean[2] / count], base), amount)
    }

    fn displacement(&self, v: usize, f: f64, stamp: &Stamp) -> Vec3 {
        let s = self.settings;
        let x = self.position[v];
        let n_bar = stamp.n_bar;
        let tangential = || {
            let to_centre = sub(stamp.centre, x);
            let k = dot(to_centre, n_bar);
            [to_centre[0] - n_bar[0] * k, to_centre[1] - n_bar[1] * k, to_centre[2] - n_bar[2] * k]
        };
        match s.brush {
            Brush::Draw => {
                let normal = if s.direction == Direction::Normal { self.vertex_normal(v) } else { n_bar };
                along(normal, s.strength * f)
            }
            Brush::Inflate => along(self.vertex_normal(v), s.strength * f),
            Brush::Grab => along(stamp.fixed.unwrap_or([0.0, 0.0, 0.0]), f),
            Brush::Smooth => {
                let lambda = js_min(1.0, s.strength * f);
                let first = self.smooth_step(v, lambda, x);
                if s.taubin && lambda > 0.0 {
                    let mu = 1.0 / (TAUBIN_PASS_BAND - 1.0 / lambda);
                    let moved = [x[0] + first[0], x[1] + first[1], x[2] + first[2]];
                    let second = self.smooth_step(v, mu, moved);
                    [first[0] + second[0], first[1] + second[1], first[2] + second[2]]
                } else {
                    first
                }
            }
            Brush::Flatten => along(n_bar, -s.strength * f * dot(sub(x, stamp.plane_point), n_bar)),
            Brush::Pinch => along(tangential(), s.strength * f),
            Brush::Crease => {
                let t = tangential();
                let lift = along(n_bar, -s.strength * f);
                [lift[0] + (t[0] * s.strength * f) / 2.0, lift[1] + (t[1] * s.strength * f) / 2.0, lift[2] + (t[2] * s.strength * f) / 2.0]
            }
            Brush::Layer => {
                let height = js_min(s.strength * f, s.max_height.unwrap_or(f64::INFINITY));
                let base = self.base[v];
                let target = [base[0] + n_bar[0] * height, base[1] + n_bar[1] * height, base[2] + n_bar[2] * height];
                let already = dot(sub(x, base), n_bar);
                if height > already {
                    sub(target, x)
                } else {
                    [0.0, 0.0, 0.0]
                }
            }
        }
    }
}

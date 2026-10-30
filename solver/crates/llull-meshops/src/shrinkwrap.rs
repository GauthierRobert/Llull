//! `shrinkwrap` (DES-7c native twins, 13.20): the projection of every vertex of a mesh onto a target mesh of `wrapDisplace.ts`, bit-identical to the TypeScript engine (the oracle).
//! `nearest` takes the closest point of the target, `normal` and `direction` the first hit of a ray along the angle-weighted vertex normal / a fixed direction, tried both ways
//! (the nearer hit wins, forward on a tie); the result is offset along the target face normal at the hit. The report is `{ moved, missed, maxMove, meanMove, residual }`.

use crate::geom::{js_max, js_min, length, normal_of, Vec3};
use crate::surface::SurfaceIndex;
use llull_jsmath::{acos, hypot};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Nearest,
    Normal,
    Direction,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Keep,
    Outside,
    Inside,
}

pub struct Params {
    pub mode: Mode,
    pub direction: Option<Vec3>,
    pub offset: f64,
    pub side: Side,
    pub max_distance: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub moved: usize,
    pub missed: usize,
    pub max_move: f64,
    pub mean_move: f64,
    pub residual: f64,
}

fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// `unitOf`: the vector over its length, or none for a length that is 0 or not finite.
fn unit_of(a: Vec3) -> Option<Vec3> {
    let l = length(a);
    (l > 0.0 && l.is_finite()).then(|| [a[0] / l, a[1] / l, a[2] / l])
}

fn point(positions: &[f64], v: usize) -> Vec3 {
    [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]]
}

/// Angle-weighted unit vertex normals (twin of `vertexNormalsOf`; a vertex without a non-degenerate triangle gets the zero vector). Sequential in face order: the sums add up in the
/// TypeScript order.
fn vertex_normals(positions: &[f64], triangles: &[u32]) -> Vec<Vec3> {
    let mut sums = vec![[0.0f64; 3]; positions.len() / 3];
    for t in triangles.chunks_exact(3) {
        let ids = [t[0] as usize, t[1] as usize, t[2] as usize];
        let p = [point(positions, ids[0]), point(positions, ids[1]), point(positions, ids[2])];
        let Some(normal) = unit_of(normal_of(p[0], p[1], p[2])) else { continue };
        for k in 0..3 {
            let (Some(e1), Some(e2)) = (unit_of(sub(p[(k + 1) % 3], p[k])), unit_of(sub(p[(k + 2) % 3], p[k]))) else { continue };
            let angle = acos(js_max(-1.0, js_min(1.0, dot(e1, e2))));
            let sum = sums[ids[k]];
            sums[ids[k]] = [sum[0] + angle * normal[0], sum[1] + angle * normal[1], sum[2] + angle * normal[2]];
        }
    }
    sums.into_iter().map(|s| unit_of(s).unwrap_or([0.0; 3])).collect()
}

fn face_normal(positions: &[f64], triangles: &[u32], face: usize) -> Vec3 {
    let p = |k: usize| point(positions, triangles[face * 3 + k] as usize);
    unit_of(normal_of(p(0), p(1), p(2))).unwrap_or([0.0; 3])
}

/// What one vertex became: the new position and its distance moved and its distance to the target, or none when it found nothing.
struct Wrapped {
    q: Vec3,
    mv: f64,
    off: f64,
}

pub struct Wrap {
    pub positions: Vec<f64>,
    pub report: Report,
}

/// Wrap `positions` (triangles `triangles`, used for the vertex normals of the `normal` mode) onto the target.
pub fn shrinkwrap(positions: &[f64], triangles: &[u32], target: (&[f64], &[u32]), params: &Params) -> Wrap {
    let index = SurfaceIndex::new(target.0, target.1);
    let normals = (params.mode == Mode::Normal).then(|| vertex_normals(positions, triangles));
    let axis = if params.mode == Mode::Direction { params.direction.and_then(unit_of) } else { None };
    let reach = params.max_distance.unwrap_or(f64::INFINITY);
    let count = positions.len() / 3;
    let sign = |vertex: Vec3, hit: Vec3, normal: Vec3| -> f64 {
        match params.side {
            Side::Outside => 1.0,
            Side::Inside => -1.0,
            Side::Keep => {
                if dot(sub(vertex, hit), normal) < 0.0 {
                    -1.0
                } else {
                    1.0
                }
            }
        }
    };
    // every vertex is independent of the others: the per-vertex answers are computed in parallel and folded in vertex order, as the TypeScript loop does
    let wrapped: Vec<Option<Wrapped>> = (0..count)
        .into_par_iter()
        .map(|v| {
            let p = point(positions, v);
            let (hit_point, face): (Vec3, i64) = if params.mode == Mode::Nearest {
                let hit = index.closest(p);
                if hit.face >= 0 && hit.distance <= reach {
                    (hit.point, hit.face)
                } else {
                    return None;
                }
            } else {
                let direction = match &normals {
                    Some(normals) => unit_of(normals[v]),
                    None => axis,
                }?;
                let forward = index.ray(p, direction, reach);
                let backward = index.ray(p, [-direction[0], -direction[1], -direction[2]], reach);
                let use_forward = forward.is_some_and(|(f, _)| backward.is_none_or(|(b, _)| f <= b));
                let (distance, face) = if use_forward { forward } else { backward }?;
                let s = if use_forward { 1.0 } else { -1.0 };
                (
                    [p[0] + s * distance * direction[0], p[1] + s * distance * direction[1], p[2] + s * distance * direction[2]],
                    i64::from(face),
                )
            };
            let normal = face_normal(target.0, target.1, face as usize);
            let s = if params.offset == 0.0 { 0.0 } else { sign(p, hit_point, normal) * params.offset };
            let q = [hit_point[0] + s * normal[0], hit_point[1] + s * normal[1], hit_point[2] + s * normal[2]];
            let mv = hypot(&[q[0] - p[0], q[1] - p[1], q[2] - p[2]]);
            let off = (index.closest(q).distance - params.offset.abs()).abs();
            Some(Wrapped { q, mv, off })
        })
        .collect();
    let mut out = positions.to_vec();
    let (mut moved, mut missed, mut total, mut max_move, mut residual) = (0usize, 0usize, 0.0f64, 0.0f64, 0.0f64);
    for (v, item) in wrapped.iter().enumerate() {
        let Some(w) = item else {
            missed += 1;
            continue;
        };
        out[v * 3..v * 3 + 3].copy_from_slice(&w.q);
        if w.mv > 0.0 {
            moved += 1;
        }
        total += w.mv;
        max_move = js_max(max_move, w.mv);
        residual = js_max(residual, w.off);
    }
    let handled = count - missed;
    let mean_move = if handled == 0 { 0.0 } else { total / handled as f64 };
    Wrap { positions: out, report: Report { moved, missed, max_move, mean_move, residual } }
}

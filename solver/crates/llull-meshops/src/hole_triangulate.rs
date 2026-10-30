//! Triangulation of a boundary loop (twin of `holeTriangulate.ts`, Liepa 2003 stage 2): O(n^3) dynamic programming over the loop with the lexicographic weight
//! (largest dihedral angle to the neighbouring faces, then total area) after Barequet and Sharir; loops above `DP_LOOP_LIMIT` edges use a greedy ear clip
//! (smallest corner angle first). Patch triangles come out already oriented against the boundary edge direction. The operation order of every float expression
//! is the TypeScript one, `Math.acos` is the V8 twin, and `Math.min` / `Math.max` keep their NaN rules.

use crate::edit::EditMesh;
use crate::geom::{dot, js_max, js_min, length, normal_of, Vec3};
use llull_jsmath::acos;

/// Largest loop (edges) triangulated by the O(n^3) program.
const DP_LOOP_LIMIT: usize = 120;
const ANGLE_TIE: f64 = 1e-9;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Dp,
    Greedy,
}

pub struct LoopTriangulation {
    pub triangles: Vec<[u32; 3]>,
    pub method: Method,
}

fn unit_or_null(n: Vec3) -> Option<Vec3> {
    let l = length(n);
    (l > 1e-300).then(|| [n[0] / l, n[1] / l, n[2] / l])
}

fn angle_between(a: Vec3, b: Vec3) -> f64 {
    acos(js_max(-1.0, js_min(1.0, dot(a, b))))
}

/// The unit normal of the mesh face across loop edge `i` (v_i to v_i+1), or `None`.
fn outside_normal(mesh: &EditMesh, loop_: &[u32], i: usize) -> Option<Vec3> {
    let (a, b) = (loop_[i], loop_[(i + 1) % loop_.len()]);
    let mut faces = Vec::new();
    mesh.faces_on_edge_into(a, b, &mut faces);
    let n = mesh.face_normal(*faces.first()?);
    let l = length(n);
    (l > 0.0).then(|| [n[0] / l, n[1] / l, n[2] / l])
}

fn dynamic_program(loop_: &[u32], mesh: &EditMesh) -> Option<LoopTriangulation> {
    let n = loop_.len();
    let point: Vec<Vec3> = loop_.iter().map(|&v| mesh.p(v)).collect();
    let outside: Vec<Option<Vec3>> = (0..n).map(|i| outside_normal(mesh, loop_, i)).collect();
    let mut worst = vec![0.0f64; n * n];
    let mut area = vec![0.0f64; n * n];
    let mut apex = vec![-1i32; n * n];
    let mut feasible = vec![false; n * n];
    for i in 0..n - 1 {
        feasible[i * n + i + 1] = true;
    }
    let normal_of_triangle = |i: usize, m: usize, k: usize| unit_or_null(normal_of(point[k], point[m], point[i]));
    for span in 2..n {
        for i in 0..n - span {
            let k = i + span;
            if k - i != n - 1 && mesh.has_edge(loop_[i], loop_[k]) {
                continue;
            }
            let neighbour_normal = |a: usize, b: usize, apex: &[i32]| -> Option<Vec3> {
                if b == a + 1 {
                    outside[a]
                } else {
                    normal_of_triangle(a, apex[a * n + b] as usize, b)
                }
            };
            let mut best: Option<usize> = None;
            let mut best_angle = f64::INFINITY;
            let mut best_area = f64::INFINITY;
            for m in i + 1..k {
                if !feasible[i * n + m] || !feasible[m * n + k] {
                    continue;
                }
                let Some(normal) = normal_of_triangle(i, m, k) else { continue };
                let mut angle = js_max(worst[i * n + m], worst[m * n + k]);
                let closing = if k - i == n - 1 { outside[n - 1] } else { None };
                for neighbour in [neighbour_normal(i, m, &apex), neighbour_normal(m, k, &apex), closing].into_iter().flatten() {
                    angle = js_max(angle, angle_between(normal, neighbour));
                }
                let total = area[i * n + m] + area[m * n + k] + length(normal_of(point[k], point[m], point[i])) / 2.0;
                if angle < best_angle - ANGLE_TIE || (angle <= best_angle + ANGLE_TIE && total < best_area) {
                    best = Some(m);
                    best_angle = angle;
                    best_area = total;
                }
            }
            if let Some(m) = best {
                feasible[i * n + k] = true;
                apex[i * n + k] = m as i32;
                worst[i * n + k] = best_angle;
                area[i * n + k] = best_area;
            }
        }
    }
    if !feasible[n - 1] {
        return None;
    }
    let mut triangles = Vec::with_capacity(n - 2);
    let mut stack = vec![(0usize, n - 1)];
    while let Some((i, k)) = stack.pop() {
        if k - i < 2 {
            continue;
        }
        let m = apex[i * n + k] as usize;
        triangles.push([loop_[k], loop_[m], loop_[i]]);
        stack.push((m, k));
        stack.push((i, m));
    }
    Some(LoopTriangulation { triangles, method: Method::Dp })
}

fn corner_angle(mesh: &EditMesh, a: u32, b: u32, c: u32) -> f64 {
    let (pa, pb, pc) = (mesh.p(a), mesh.p(b), mesh.p(c));
    let u = [pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]];
    let v = [pc[0] - pb[0], pc[1] - pb[1], pc[2] - pb[2]];
    let (lu, lv) = (length(u), length(v));
    if lu * lv > 0.0 {
        angle_between([u[0] / lu, u[1] / lu, u[2] / lu], [v[0] / lv, v[1] / lv, v[2] / lv])
    } else {
        std::f64::consts::PI
    }
}

fn greedy_ears(loop_: &[u32], mesh: &EditMesh) -> Option<LoopTriangulation> {
    let mut ring = loop_.to_vec();
    let mut triangles = Vec::with_capacity(loop_.len() - 2);
    while ring.len() > 3 {
        let n = ring.len();
        let mut best: Option<usize> = None;
        let mut best_angle = f64::INFINITY;
        for i in 0..n {
            let (a, b, c) = (ring[(i + n - 1) % n], ring[i], ring[(i + 1) % n]);
            if mesh.has_edge(a, c) {
                continue;
            }
            if length(normal_of(mesh.p(c), mesh.p(b), mesh.p(a))) < 1e-300 {
                continue;
            }
            let angle = corner_angle(mesh, a, b, c);
            if angle < best_angle {
                best_angle = angle;
                best = Some(i);
            }
        }
        let i = best?;
        triangles.push([ring[(i + 1) % n], ring[i], ring[(i + n - 1) % n]]);
        ring.remove(i);
    }
    let (a, b, c) = (ring[0], ring[1], ring[2]);
    if length(normal_of(mesh.p(c), mesh.p(b), mesh.p(a))) < 1e-300 {
        return None;
    }
    triangles.push([c, b, a]);
    Some(LoopTriangulation { triangles, method: Method::Greedy })
}

/// Triangulate `loop_` (vertices in boundary-edge direction, at least 3, no vertex twice); `None` when no valid triangulation exists.
pub fn triangulate_loop(loop_: &[u32], mesh: &EditMesh) -> Option<LoopTriangulation> {
    if loop_.len() < 3 {
        return None;
    }
    if loop_.len() <= DP_LOOP_LIMIT {
        dynamic_program(loop_, mesh)
    } else {
        greedy_ears(loop_, mesh)
    }
}

//! Diffuse view-factor exchange between planar facets (PHY-03 TR-THM-20, RS1 RS-6), transliterated from
//! `packages/core/src/lib/viewFactorContour.ts` (contour integral, closed-form inner integral, adaptive 8-point Gauss-Legendre outer) and
//! `packages/core/src/geometry/viewFactorExchange.ts` (per-surface sums, centroid-segment obstruction). `Math.log` / `Math.atan` are the
//! V8 twins of `llull-jsmath`, so every exchange area is bit-identical to the TypeScript; facet pairs run in parallel and are summed in
//! the TypeScript order (owner a, then b).
//! The obstruction test walks an AABB tree of the occluders instead of the TypeScript's brute-force loop: it only skips triangles whose
//! inflated box the segment cannot reach, so the boolean per pair is the same.

use crate::tree::MeshTree;
use crate::triangle::{add, cross, dot, js_max, js_min, length, scale, segment_hits_triangle, sub, Vec3};
use llull_jsmath::{atan, log};
use rayon::prelude::*;

const NODES: [f64; 4] = [0.1834346424956498, 0.525532409916329, 0.7966664774136267, 0.9602898564975363];
const WEIGHTS: [f64; 4] = [0.362683783378362, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763];
const TOLERANCE: f64 = 1e-13;
const MAX_DEPTH: i32 = 48;
/// Emitting facets per parallel chunk: contributions of a chunk are buffered, then summed in order.
const CHUNK: usize = 64;

/// A planar triangle with its (emitting-side) unit normal, centroid and area, as the TypeScript `Facet` (values passed, not recomputed).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Facet {
    pub corners: [Vec3; 3],
    pub normal: Vec3,
    pub centroid: Vec3,
    pub area: f64,
}

fn x_log_abs(u: f64) -> f64 {
    if u == 0.0 {
        0.0
    } else {
        u * log(u.abs()) - u
    }
}

/// ∫_0^1 ln|w - t v| dt in closed form.
fn log_integral(w: &Vec3, v: &Vec3) -> f64 {
    let a = dot(v, v);
    if a == 0.0 {
        return log(length(w));
    }
    let wv = dot(w, v);
    let c = cross(w, v);
    let delta = 4.0 * dot(&c, &c);
    if delta == 0.0 {
        return 0.5 * log(a) + x_log_abs(1.0 - wv / a) - x_log_abs(-wv / a);
    }
    let b = -2.0 * wv;
    let root = delta.sqrt();
    let antiderivative = |t: f64| {
        let d = sub(w, &scale(v, t));
        let q = dot(&d, &d);
        let log_term = if q > 0.0 { (t + b / (2.0 * a)) * log(q) } else { 0.0 };
        log_term - 2.0 * t + (root / a) * atan((2.0 * a * t + b) / root)
    };
    0.5 * (antiderivative(1.0) - antiderivative(0.0))
}

fn gauss_legendre(f: &impl Fn(f64) -> f64, lo: f64, hi: f64) -> f64 {
    let half = 0.5 * (hi - lo);
    let mid = 0.5 * (hi + lo);
    let mut sum = 0.0;
    for k in 0..NODES.len() {
        let node = NODES[k] * half;
        sum += WEIGHTS[k] * (f(mid - node) + f(mid + node));
    }
    sum * half
}

fn adaptive(f: &impl Fn(f64) -> f64, lo: f64, hi: f64, whole: f64, tolerance: f64, depth: i32) -> f64 {
    let mid = 0.5 * (lo + hi);
    let left = gauss_legendre(f, lo, mid);
    let right = gauss_legendre(f, mid, hi);
    if depth <= 0 || (left + right - whole).abs() <= tolerance {
        return left + right;
    }
    adaptive(f, lo, mid, left, tolerance / 2.0, depth - 1) + adaptive(f, mid, hi, right, tolerance / 2.0, depth - 1)
}

/// ∫_0^1 ∫_0^1 ln|(a + s u) - (c + t v)| dt ds.
fn edge_pair_integral(a: &Vec3, u: &Vec3, c: &Vec3, v: &Vec3) -> f64 {
    let inner = |s: f64| log_integral(&sub(&add(a, &scale(u, s)), c), v);
    adaptive(&inner, 0.0, 1.0, gauss_legendre(&inner, 0.0, 1.0), TOLERANCE, MAX_DEPTH)
}

/// True when each facet is in front of the other (centroid test).
pub fn facing(from: &Facet, to: &Facet) -> bool {
    dot(&from.normal, &sub(&to.centroid, &from.centroid)) > 0.0 && dot(&to.normal, &sub(&from.centroid, &to.centroid)) > 0.0
}

/// A_i F_ij (0 for facets that do not face each other).
pub fn exchange_area(from: &Facet, to: &Facet) -> f64 {
    if !facing(from, to) {
        return 0.0;
    }
    let mut sum = 0.0;
    for a in 0..3 {
        let start = &from.corners[a];
        let u = sub(&from.corners[(a + 1) % 3], start);
        for b in 0..3 {
            let origin = &to.corners[b];
            let v = sub(&to.corners[(b + 1) % 3], origin);
            let alignment = dot(&u, &v);
            if alignment != 0.0 {
                sum += alignment * edge_pair_integral(start, &u, origin, &v);
            }
        }
    }
    sum / (2.0 * std::f64::consts::PI)
}

/// Occluder triangles in an AABB tree, queried by open segments.
struct Occluders {
    tree: MeshTree,
}

impl Occluders {
    fn new(facets: &[Facet]) -> Occluders {
        Occluders { tree: MeshTree::build(facets.iter().flat_map(|f| f.corners.into_iter().flatten()).collect()) }
    }

    /// Whether the open segment crosses a non-skipped occluder (`skip` = occluder indices).
    fn blocked(&self, start: &Vec3, end: &Vec3, skip: [usize; 2]) -> bool {
        let tree = &self.tree;
        if tree.triangle_count() == 0 {
            return false;
        }
        let mut stack = vec![0usize];
        while let Some(node) = stack.pop() {
            if !segment_reaches_box(&tree.boxes[node * 6..node * 6 + 6], start, end) {
                continue;
            }
            if tree.is_leaf(node) {
                for i in 0..tree.count[node] {
                    let index = tree.order[tree.start[node] + i];
                    if !skip.contains(&index) && segment_hits_triangle(start, end, &tree.triangle_at(index, None)) {
                        return true;
                    }
                }
                continue;
            }
            stack.push(tree.right[node] as usize);
            stack.push(tree.left[node] as usize);
        }
        false
    }
}

/// Conservative segment / box overlap: the box is inflated by a relative margin, so a triangle the segment truly crosses is never skipped.
fn segment_reaches_box(b: &[f64], start: &Vec3, end: &Vec3) -> bool {
    let mut near: f64 = 0.0;
    let mut far: f64 = 1.0;
    for axis in 0..3 {
        let margin = 1e-7 * (1.0 + js_max(b[axis].abs(), b[3 + axis].abs()));
        let (lo, hi) = (b[axis] - margin, b[3 + axis] + margin);
        let d = end[axis] - start[axis];
        if d == 0.0 {
            if start[axis] < lo || start[axis] > hi {
                return false;
            }
            continue;
        }
        let t1 = (lo - start[axis]) / d;
        let t2 = (hi - start[axis]) / d;
        near = js_max(near, js_min(t1, t2));
        far = js_min(far, js_max(t1, t2));
        if near > far {
            return false;
        }
    }
    true
}

/// Exchange matrix A_I F_IJ (row-major, `surfaces` × `surfaces`) of `owners` (facet, surface index; surface-major order). With
/// `blockers = Some(..)` a facet pair is dropped when the open segment between the centroids crosses another occluder (every owner facet,
/// then the blockers; the pair's own two facets are skipped). Same pairs, same order and same sums as the TypeScript reference.
pub fn exchange_matrix(owners: &[(usize, Facet)], blockers: Option<&[Facet]>, surfaces: usize) -> Vec<f64> {
    let occluders = blockers.map(|extra| {
        let all: Vec<Facet> = owners.iter().map(|(_, f)| *f).chain(extra.iter().copied()).collect();
        Occluders::new(&all)
    });
    let mut exchange = vec![0.0; surfaces * surfaces];
    let indices: Vec<usize> = (0..owners.len()).collect();
    for chunk in indices.chunks(CHUNK) {
        let rows: Vec<Vec<(usize, f64)>> = chunk
            .par_iter()
            .map(|&i| {
                let (surface_a, a) = &owners[i];
                owners
                    .iter()
                    .enumerate()
                    .filter(|(j, (surface_b, b))| {
                        surface_a != surface_b
                            && facing(a, b)
                            && occluders.as_ref().is_none_or(|o| !o.blocked(&a.centroid, &b.centroid, [i, *j]))
                    })
                    .map(|(_, (surface_b, b))| (*surface_b, exchange_area(a, b)))
                    .collect()
            })
            .collect();
        for (&i, row) in chunk.iter().zip(&rows) {
            let surface_a = owners[i].0;
            for &(surface_b, value) in row {
                exchange[surface_a * surfaces + surface_b] += value;
            }
        }
    }
    exchange
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facet(a: Vec3, b: Vec3, c: Vec3) -> Facet {
        let n = cross(&sub(&b, &a), &sub(&c, &a));
        let twice = length(&n);
        Facet { corners: [a, b, c], normal: scale(&n, 1.0 / twice), centroid: scale(&add(&add(&a, &b), &c), 1.0 / 3.0), area: twice / 2.0 }
    }

    /// Two unit squares 1 apart facing each other: F = 0.1998 (closed form, Incropera Table 13.2).
    fn plates() -> Vec<(usize, Facet)> {
        vec![
            (0, facet([0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0])),
            (0, facet([0.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0])),
            (1, facet([0.0, 0.0, 1.0], [1.0, 1.0, 1.0], [1.0, 0.0, 1.0])),
            (1, facet([0.0, 0.0, 1.0], [0.0, 1.0, 1.0], [1.0, 1.0, 1.0])),
        ]
    }

    #[test]
    fn parallel_plates_match_the_closed_form() {
        let exchange = exchange_matrix(&plates(), None, 2);
        assert!((exchange[1] - 0.199_825).abs() < 1e-5, "{}", exchange[1]);
        assert_eq!(exchange[0], 0.0);
        assert!((exchange[1] - exchange[2]).abs() < 1e-12);
    }

    #[test]
    fn a_blocker_between_the_plates_shadows_every_pair() {
        let wall =
            [facet([-1.0, -1.0, 0.5], [2.0, -1.0, 0.5], [2.0, 2.5, 0.5]), facet([-1.0, -1.0, 0.5], [2.0, 2.5, 0.5], [-1.0, 2.5, 0.5])];
        assert_eq!(exchange_matrix(&plates(), Some(&wall), 2), vec![0.0; 4]);
        assert_eq!(exchange_matrix(&plates(), Some(&[]), 2), exchange_matrix(&plates(), None, 2));
    }
}

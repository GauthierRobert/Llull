//! Closest-point index of an indexed triangle mesh (twin of `surfaceIndex.ts` and `triangleQueries.closestPointOnTriangle`): a median-split
//! AABB tree, leaf size 6, the same split axis, the same halves, traversal order and tie rule, so the distances equal the TypeScript ones bit for bit.
//! The tree is built with a selection instead of a full sort per level and its two halves build in parallel; the tree is a function of the mesh
//! alone, so the result does not depend on the number of threads.

use crate::geom::{js_max, js_min, Vec3};
use rayon::prelude::*;

const LEAF: usize = 6;
/// Nodes of a range of at least this many triangles build their halves in parallel.
const PARALLEL_FROM: usize = 8192;
const NONE: u32 = u32::MAX;

fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn add(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn scale(a: Vec3, s: f64) -> Vec3 {
    [a[0] * s, a[1] * s, a[2] * s]
}

fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// Closest point of triangle `abc` to `p` (Ericson, Real-Time Collision Detection 5.1.5).
pub fn closest_point_on_triangle(p: Vec3, [a, b, c]: [Vec3; 3]) -> Vec3 {
    let ab = sub(b, a);
    let ac = sub(c, a);
    let ap = sub(p, a);
    let d1 = dot(ab, ap);
    let d2 = dot(ac, ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        return a;
    }
    let bp = sub(p, b);
    let d3 = dot(ab, bp);
    let d4 = dot(ac, bp);
    if d3 >= 0.0 && d4 <= d3 {
        return b;
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        return add(a, scale(ab, d1 / (d1 - d3)));
    }
    let cp = sub(p, c);
    let d5 = dot(ab, cp);
    let d6 = dot(ac, cp);
    if d6 >= 0.0 && d5 <= d6 {
        return c;
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        return add(a, scale(ac, d2 / (d2 - d6)));
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0 {
        return add(b, scale(sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))));
    }
    let denominator = 1.0 / (va + vb + vc);
    add(a, add(scale(ab, vb * denominator), scale(ac, vc * denominator)))
}

fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/// Distance along `direction` to triangle `abc` from `origin` in [t_min, t_max]; twin of `rayTriangleDistance` (Moller-Trumbore, double-sided).
// the comparisons are the TypeScript ones: a NaN barycentric coordinate is not out of range there, which a range test would turn around
#[allow(clippy::manual_range_contains)]
fn ray_triangle_distance(origin: Vec3, direction: Vec3, [a, b, c]: [Vec3; 3], t_min: f64, t_max: f64) -> Option<f64> {
    let (edge1, edge2) = (sub(b, a), sub(c, a));
    let h = cross(direction, edge2);
    let determinant = dot(edge1, h);
    if determinant.abs() < 1e-300 {
        return None;
    }
    let inverse = 1.0 / determinant;
    let s = sub(origin, a);
    let u = inverse * dot(s, h);
    if u < -1e-12 || u > 1.0 + 1e-12 {
        return None;
    }
    let q = cross(s, edge1);
    let v = inverse * dot(direction, q);
    if v < -1e-12 || u + v > 1.0 + 1e-12 {
        return None;
    }
    let t = inverse * dot(edge2, q);
    (t >= t_min && t <= t_max).then_some(t)
}

/// The nearest point of a closest-point query: `face` is -1 (and `distance` infinite) for an empty mesh.
#[derive(Clone, Copy, Debug)]
pub struct Hit {
    pub point: Vec3,
    pub distance: f64,
    pub face: i64,
}

/// A node: its box (min xyz, max xyz), its children (`NONE` for a leaf) and its range of `order`. 64 bytes: one cache line.
#[derive(Clone, Copy, Default)]
struct Node {
    bounds: [f64; 6],
    left: u32,
    right: u32,
    start: u32,
    end: u32,
}

/// Nodes of the tree over `n` triangles (a range splits into `n / 2` and the rest until it holds at most [`LEAF`]).
fn node_count(n: usize) -> usize {
    if n <= LEAF {
        1
    } else {
        1 + node_count(n / 2) + node_count(n - n / 2)
    }
}

/// Builds the subtree of `order` (the triangles `start..start + order.len()` of the final order) into `nodes`, whose first slot is node `base`.
fn build(corners: &[f64], centres: &[Vec3], order: &mut [u32], start: usize, base: usize, nodes: &mut [Node]) {
    let n = order.len();
    let mut bounds = [f64::INFINITY, f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for &t in order.iter() {
        let o = t as usize * 9;
        for k in 0..9 {
            let axis = k % 3;
            bounds[axis] = bounds[axis].min(corners[o + k]);
            bounds[axis + 3] = bounds[axis + 3].max(corners[o + k]);
        }
    }
    let Some((node, rest)) = nodes.split_first_mut() else { return };
    if n <= LEAF {
        *node = Node { bounds, left: NONE, right: NONE, start: start as u32, end: (start + n) as u32 };
        return;
    }
    let [ex, ey, ez] = [bounds[3] - bounds[0], bounds[4] - bounds[1], bounds[5] - bounds[2]];
    let axis = if ex >= ey && ex >= ez {
        0
    } else if ey >= ez {
        1
    } else {
        2
    };
    // the first `mid` of the triangles sorted by centre along the axis (-0 = +0), then by index, go left
    let mid = n / 2;
    order.select_nth_unstable_by(mid, |&x, &y| {
        (centres[x as usize][axis] + 0.0).total_cmp(&(centres[y as usize][axis] + 0.0)).then(x.cmp(&y))
    });
    let left_nodes = node_count(mid);
    *node = Node { bounds, left: (base + 1) as u32, right: (base + 1 + left_nodes) as u32, start: start as u32, end: (start + n) as u32 };
    let (lower, upper) = order.split_at_mut(mid);
    let (lower_nodes, upper_nodes) = rest.split_at_mut(left_nodes);
    let mut build_lower = || build(corners, centres, lower, start, base + 1, lower_nodes);
    let mut build_upper = || build(corners, centres, upper, start + mid, base + 1 + left_nodes, upper_nodes);
    if n >= PARALLEL_FROM {
        rayon::join(build_lower, build_upper);
    } else {
        build_lower();
        build_upper();
    }
}

pub struct SurfaceIndex {
    face_count: usize,
    corners: Vec<f64>,
    order: Vec<u32>,
    nodes: Vec<Node>,
}

impl SurfaceIndex {
    pub fn new(positions: &[f64], triangles: &[u32]) -> Self {
        let face_count = triangles.len() / 3;
        let mut corners = vec![0.0; face_count * 9];
        corners.par_chunks_mut(9).zip(triangles.par_chunks_exact(3)).for_each(|(out, triangle)| {
            for (k, &v) in triangle.iter().enumerate() {
                out[k * 3..k * 3 + 3].copy_from_slice(&positions[v as usize * 3..v as usize * 3 + 3]);
            }
        });
        let centres: Vec<Vec3> =
            corners.par_chunks_exact(9).map(|c| std::array::from_fn(|axis| (c[axis] + c[axis + 3] + c[axis + 6]) / 3.0)).collect();
        let mut order: Vec<u32> = (0..face_count as u32).collect();
        let mut nodes = vec![Node::default(); if face_count > 0 { node_count(face_count) } else { 0 }];
        if face_count > 0 {
            build(&corners, &centres, &mut order, 0, 0, &mut nodes);
        }
        Self { face_count, corners, order, nodes }
    }

    fn box_distance_sq(&self, node: u32, p: Vec3) -> f64 {
        let bounds = &self.nodes[node as usize].bounds;
        let mut sum = 0.0;
        for (a, &x) in p.iter().enumerate() {
            let (lo, hi) = (bounds[a], bounds[a + 3]);
            let d = if x < lo {
                lo - x
            } else if x > hi {
                x - hi
            } else {
                0.0
            };
            sum += d * d;
        }
        sum
    }

    /// Distance from `p` to the nearest triangle (infinity for an empty mesh).
    pub fn closest_distance(&self, p: Vec3) -> f64 {
        self.nearest(p, f64::NEG_INFINITY)
    }

    /// The search of [`Self::closest_distance`], which returns early with the best distance so far when it is at most `stop_at`.
    fn nearest(&self, p: Vec3, stop_at: f64) -> f64 {
        self.search(p, stop_at).distance
    }

    /// Nearest surface point to `p` (twin of `SurfaceIndex.closest`: distance infinity and face -1 for an empty mesh; the lower triangle wins a tie).
    pub fn closest(&self, p: Vec3) -> Hit {
        self.search(p, f64::NEG_INFINITY)
    }

    /// `Some(face)` of a triangle within `bound` of `p` when the surface is not farther than `bound` (`face` is -1 for an empty mesh, where the distance is infinite); `None` when
    /// it is: `closest_distance(p) > bound` negated, without the rest of the search once a triangle within `bound` is known (the answer cannot change after that). Triangle `hint` (a face of the mesh, or [`u32::MAX`]) is tried first: one within the bound proves the answer.
    pub fn within(&self, p: Vec3, bound: f64, hint: u32) -> Option<i64> {
        if (hint as usize) < self.face_count {
            let c = &self.corners[hint as usize * 9..hint as usize * 9 + 9];
            let hit = closest_point_on_triangle(p, [[c[0], c[1], c[2]], [c[3], c[4], c[5]], [c[6], c[7], c[8]]]);
            let d_sq = (hit[0] - p[0]) * (hit[0] - p[0]) + (hit[1] - p[1]) * (hit[1] - p[1]) + (hit[2] - p[2]) * (hit[2] - p[2]);
            if d_sq.sqrt() <= bound {
                return Some(i64::from(hint));
            }
        }
        let found = self.search(p, bound);
        (found.distance.partial_cmp(&bound) != Some(std::cmp::Ordering::Greater)).then_some(found.face)
    }

    fn search(&self, p: Vec3, stop_at: f64) -> Hit {
        let mut best = Hit { point: p, distance: f64::INFINITY, face: -1 };
        if self.face_count == 0 {
            return best;
        }
        let mut best_sq = f64::INFINITY;
        // the tree is at most 32 deep (u32 triangle indices) and a visit leaves one more node on the stack than it took off
        let mut stack = [0u32; 64];
        let mut top = 1;
        while top > 0 {
            top -= 1;
            let node = stack[top];
            if self.box_distance_sq(node, p) > best_sq {
                continue;
            }
            let Node { left, right, start, end, .. } = self.nodes[node as usize];
            if left == NONE {
                for i in start as usize..end as usize {
                    let t = self.order[i];
                    let o = t as usize * 9;
                    let c = &self.corners;
                    let hit = closest_point_on_triangle(
                        p,
                        [[c[o], c[o + 1], c[o + 2]], [c[o + 3], c[o + 4], c[o + 5]], [c[o + 6], c[o + 7], c[o + 8]]],
                    );
                    let d_sq = (hit[0] - p[0]) * (hit[0] - p[0]) + (hit[1] - p[1]) * (hit[1] - p[1]) + (hit[2] - p[2]) * (hit[2] - p[2]);
                    if d_sq < best_sq || (d_sq == best_sq && i64::from(t) < best.face) {
                        best_sq = d_sq;
                        best = Hit { point: hit, distance: best_sq.sqrt(), face: i64::from(t) };
                        if best.distance <= stop_at {
                            return best;
                        }
                    }
                }
            } else if self.box_distance_sq(left, p) <= self.box_distance_sq(right, p) {
                stack[top] = right;
                stack[top + 1] = left;
                top += 2;
            } else {
                stack[top] = left;
                stack[top + 1] = right;
                top += 2;
            }
        }
        best
    }

    fn ray_hits_box(&self, node: u32, origin: Vec3, inverse: Vec3, t_max: f64) -> bool {
        let bounds = &self.nodes[node as usize].bounds;
        let (mut near, mut far) = (0.0_f64, t_max);
        for a in 0..3 {
            let lo = (bounds[a] - origin[a]) * inverse[a];
            let hi = (bounds[a + 3] - origin[a]) * inverse[a];
            if lo.is_nan() || hi.is_nan() {
                continue;
            }
            near = js_max(near, js_min(lo, hi));
            far = js_min(far, js_max(lo, hi));
        }
        near <= far * (1.0 + 1e-12) + 1e-12
    }

    /// The first hit of the ray `origin + t * direction` (`direction` a unit vector) with t in [0, t_max], as `(distance, face)`; twin of `SurfaceIndex.ray` (same traversal: the
    /// left child first, the reach shrinking to each hit, the lower triangle on equal distances).
    pub fn ray(&self, origin: Vec3, direction: Vec3, t_max: f64) -> Option<(f64, u32)> {
        if self.face_count == 0 {
            return None;
        }
        let inverse = [1.0 / direction[0], 1.0 / direction[1], 1.0 / direction[2]];
        let mut best: Option<(f64, u32)> = None;
        let mut reach = t_max;
        let mut stack = [0u32; 64];
        let mut top = 1;
        while top > 0 {
            top -= 1;
            let node = stack[top];
            if !self.ray_hits_box(node, origin, inverse, reach) {
                continue;
            }
            let Node { left, right, start, end, .. } = self.nodes[node as usize];
            if left == NONE {
                for i in start as usize..end as usize {
                    let t = self.order[i];
                    let o = t as usize * 9;
                    let c = &self.corners;
                    let hit = ray_triangle_distance(
                        origin,
                        direction,
                        [[c[o], c[o + 1], c[o + 2]], [c[o + 3], c[o + 4], c[o + 5]], [c[o + 6], c[o + 7], c[o + 8]]],
                        0.0,
                        reach,
                    );
                    if let Some(distance) = hit {
                        if best.is_none_or(|(d, f)| distance < d || (distance == d && t < f)) {
                            best = Some((distance, t));
                            reach = distance;
                        }
                    }
                }
            } else {
                stack[top] = right;
                stack[top + 1] = left;
                top += 2;
            }
        }
        best
    }

    /// Barycentric weights of `point` in triangle `face` (twin of `SurfaceIndex.barycentric`; assumes the point lies on it and `face` is a triangle of the mesh).
    pub fn barycentric(&self, face: usize, point: Vec3) -> [f64; 3] {
        let c = &self.corners[face * 9..face * 9 + 9];
        let (a, b, d) = ([c[0], c[1], c[2]], [c[3], c[4], c[5]], [c[6], c[7], c[8]]);
        let v0 = sub(b, a);
        let v1 = sub(d, a);
        let v2 = sub(point, a);
        let (d00, d01, d11, d20, d21) = (dot(v0, v0), dot(v0, v1), dot(v1, v1), dot(v2, v0), dot(v2, v1));
        let denominator = d00 * d11 - d01 * d01;
        if denominator.abs() < 1e-300 {
            return [1.0, 0.0, 0.0];
        }
        let v = (d11 * d20 - d01 * d21) / denominator;
        let w = (d00 * d21 - d01 * d20) / denominator;
        [1.0 - v - w, v, w]
    }
}

#[cfg(test)]
mod tests {
    use super::{closest_point_on_triangle, node_count, SurfaceIndex, LEAF};

    fn stream(seed: u64) -> impl FnMut() -> f64 {
        let mut state = seed;
        move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 11) as f64 / (1u64 << 53) as f64
        }
    }

    /// `faces` random triangles over a grid of points (many equal coordinates, -0 included: ties on the split axis).
    fn soup(faces: usize, seed: u64) -> (Vec<f64>, Vec<u32>) {
        let mut next = stream(seed);
        let positions: Vec<f64> = (0..600).map(|_| ((next() * 6.0).floor() - 3.0) * 0.5 * if next() < 0.1 { -0.0 } else { 1.0 }).collect();
        let indices = (0..faces * 3).map(|_| (next() * 200.0) as u32).collect();
        (positions, indices)
    }

    fn brute_force(positions: &[f64], indices: &[u32], p: [f64; 3]) -> f64 {
        let corner = |v: u32| [positions[v as usize * 3], positions[v as usize * 3 + 1], positions[v as usize * 3 + 2]];
        indices
            .chunks_exact(3)
            .map(|t| {
                let hit = closest_point_on_triangle(p, [corner(t[0]), corner(t[1]), corner(t[2])]);
                (hit[0] - p[0]) * (hit[0] - p[0]) + (hit[1] - p[1]) * (hit[1] - p[1]) + (hit[2] - p[2]) * (hit[2] - p[2])
            })
            .fold(f64::INFINITY, f64::min)
            .sqrt()
    }

    #[test]
    fn the_distance_is_the_minimum_over_all_triangles_for_small_and_large_trees() {
        let mut next = stream(99);
        for faces in [0, 1, LEAF, LEAF + 1, 50, 9000] {
            let (positions, indices) = soup(faces, 5 + faces as u64);
            let index = SurfaceIndex::new(&positions, &indices);
            for _ in 0..40 {
                let p = [next() * 4.0 - 2.0, next() * 4.0 - 2.0, next() * 4.0 - 2.0];
                let expected = brute_force(&positions, &indices, p);
                assert_eq!(index.closest_distance(p), expected, "{faces} triangles");
                assert_eq!(index.within(p, 0.3, u32::MAX).is_none(), expected > 0.3);
                assert!(index.within(p, f64::NAN, u32::MAX).is_some());
            }
        }
    }

    #[test]
    fn the_early_exit_answers_like_the_full_search_around_the_bound() {
        let (positions, indices) = soup(300, 11);
        let index = SurfaceIndex::new(&positions, &indices);
        let mut next = stream(3);
        for _ in 0..200 {
            let p = [next() * 4.0 - 2.0, next() * 4.0 - 2.0, next() * 4.0 - 2.0];
            let d = index.closest_distance(p);
            for bound in [d, f64::from_bits(d.to_bits().saturating_sub(1)), f64::from_bits(d.to_bits() + 1)] {
                assert_eq!(index.within(p, bound, u32::MAX).is_none(), d > bound);
            }
        }
    }

    #[test]
    fn a_hint_never_changes_the_answer_whichever_face_it_names() {
        let (positions, indices) = soup(300, 21);
        let index = SurfaceIndex::new(&positions, &indices);
        let mut next = stream(8);
        for _ in 0..300 {
            let p = [next() * 4.0 - 2.0, next() * 4.0 - 2.0, next() * 4.0 - 2.0];
            let d = index.closest_distance(p);
            for bound in [d * 0.5, d, d * 1.5 + 0.01] {
                let expected = index.within(p, bound, u32::MAX).is_some();
                for hint in [0u32, 7, 299, 300, 100_000] {
                    let answer = index.within(p, bound, hint);
                    assert_eq!(answer.is_some(), expected, "hint {hint}");
                    // a face it names is within the bound
                    if let Some(face) = answer.filter(|&f| f >= 0) {
                        let corner = |v: u32| [positions[v as usize * 3], positions[v as usize * 3 + 1], positions[v as usize * 3 + 2]];
                        let t = &indices[face as usize * 3..face as usize * 3 + 3];
                        let hit = closest_point_on_triangle(p, [corner(t[0]), corner(t[1]), corner(t[2])]);
                        let dist = ((hit[0] - p[0]).powi(2) + (hit[1] - p[1]).powi(2) + (hit[2] - p[2]).powi(2)).sqrt();
                        assert!(dist <= bound, "the face {face} is {dist} away, bound {bound}");
                    }
                }
            }
        }
    }

    #[test]
    fn the_tree_has_the_node_count_it_is_laid_out_for() {
        assert_eq!(node_count(LEAF), 1);
        assert_eq!(node_count(LEAF + 1), 3);
        assert_eq!(node_count(100), 1 + node_count(50) * 2);
    }
}

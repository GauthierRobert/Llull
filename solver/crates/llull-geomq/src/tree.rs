//! Deterministic AABB tree over a triangle soup, transliterated from `packages/core/src/geometry/meshBvh.ts` (PHY-21 TR-FPR-04): median
//! split on the longest centroid axis, leaf size 8, ties by the lower triangle index; the same traversal order and the same pruning, so
//! distances, witness points and ray hits are bit-identical to the TypeScript `bvhMinDistance` / `bvhRayCast`.

use crate::triangle::{js_max, js_min, ray_triangle_distance, triangle_distance, ClosestPair, Triangle, Vec3};
use std::cmp::Ordering;

const LEAF_SIZE: usize = 8;

type Box6 = [f64; 6];

/// Rigid motion of the OTHER mesh into this tree's frame: row-major `rotation` applied before `translation`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placement {
    pub rotation: [f64; 9],
    pub translation: Vec3,
}

/// First hit of a ray: parameter, original triangle index, point.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RayHit {
    pub t: f64,
    pub triangle: usize,
    pub point: Vec3,
}

#[derive(Debug, Clone)]
pub struct MeshTree {
    pub(crate) corners: Vec<f64>,
    pub(crate) order: Vec<usize>,
    pub(crate) boxes: Vec<f64>,
    pub(crate) left: Vec<i64>,
    pub(crate) right: Vec<i64>,
    pub(crate) start: Vec<usize>,
    pub(crate) count: Vec<usize>,
}

impl MeshTree {
    /// Tree of a triangle soup, 9 numbers per triangle (the TS `trianglesOf` layout).
    pub fn build(corners: Vec<f64>) -> MeshTree {
        let triangle_count = corners.len() / 9;
        let mut tree = MeshTree {
            corners,
            order: (0..triangle_count).collect(),
            boxes: Vec::new(),
            left: Vec::new(),
            right: Vec::new(),
            start: Vec::new(),
            count: Vec::new(),
        };
        if triangle_count > 0 {
            tree.split(0, triangle_count);
        }
        tree
    }

    pub fn triangle_count(&self) -> usize {
        self.corners.len() / 9
    }

    /// Number of nodes (0 for an empty mesh); node 0 is the root.
    pub fn node_count(&self) -> usize {
        self.left.len()
    }

    /// The two children of an inner node, or None for a leaf.
    pub fn children(&self, node: usize) -> Option<(usize, usize)> {
        (self.left[node] >= 0).then(|| (self.left[node] as usize, self.right[node] as usize))
    }

    /// Bounding box of a node: min x, y, z then max x, y, z.
    pub fn node_bounds(&self, node: usize) -> &[f64] {
        &self.boxes[node * 6..node * 6 + 6]
    }

    /// Triangle indices held by a leaf.
    pub fn leaf_triangles(&self, node: usize) -> &[usize] {
        &self.order[self.start[node]..self.start[node] + self.count[node]]
    }

    /// The nine corner coordinates of triangle `t`.
    pub fn triangle_corners(&self, t: usize) -> &[f64] {
        &self.corners[t * 9..t * 9 + 9]
    }

    fn centroid(&self, t: usize, axis: usize) -> f64 {
        let c = &self.corners;
        (c[t * 9 + axis] + c[t * 9 + 3 + axis] + c[t * 9 + 6 + axis]) / 3.0
    }

    fn split(&mut self, from: usize, to: usize) -> usize {
        let node = self.left.len();
        self.left.push(-1);
        self.right.push(-1);
        self.start.push(from);
        self.count.push(to - from);
        let mut bounds = [f64::INFINITY, f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
        let mut centroids = bounds;
        for slot in from..to {
            let t = self.order[slot];
            for axis in 0..3 {
                for k in 0..3 {
                    let value = self.corners[t * 9 + k * 3 + axis];
                    bounds[axis] = js_min(bounds[axis], value);
                    bounds[3 + axis] = js_max(bounds[3 + axis], value);
                }
                let c = self.centroid(t, axis);
                centroids[axis] = js_min(centroids[axis], c);
                centroids[3 + axis] = js_max(centroids[3 + axis], c);
            }
        }
        self.boxes.extend_from_slice(&bounds);
        if to - from <= LEAF_SIZE {
            return node;
        }
        let mut axis = 0;
        let mut longest = -1.0;
        for a in 0..3 {
            let extent = centroids[3 + a] - centroids[a];
            if extent > longest {
                longest = extent;
                axis = a;
            }
        }
        let mut slice = self.order[from..to].to_vec();
        slice.sort_by(|&p, &q| self.centroid(p, axis).partial_cmp(&self.centroid(q, axis)).unwrap_or(Ordering::Equal).then(p.cmp(&q)));
        self.order[from..to].copy_from_slice(&slice);
        let middle = from + (to - from) / 2;
        let l = self.split(from, middle);
        let r = self.split(middle, to);
        self.left[node] = l as i64;
        self.right[node] = r as i64;
        self.count[node] = 0;
        node
    }

    pub(crate) fn is_leaf(&self, node: usize) -> bool {
        self.left[node] < 0
    }

    pub(crate) fn triangle_at(&self, index: usize, placement: Option<&Placement>) -> Triangle {
        let base = index * 9;
        let corner = |k: usize| {
            let c = &self.corners;
            let (x, y, z) = (c[base + k * 3], c[base + k * 3 + 1], c[base + k * 3 + 2]);
            placement.map_or([x, y, z], |p| apply(p, x, y, z))
        };
        [corner(0), corner(1), corner(2)]
    }

    fn node_box(&self, node: usize, placement: Option<&Placement>) -> Box6 {
        let b = &self.boxes[node * 6..node * 6 + 6];
        let Some(p) = placement else { return [b[0], b[1], b[2], b[3], b[4], b[5]] };
        let mut out = [f64::INFINITY, f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
        for corner in 0..8 {
            let pick = |bit: usize, axis: usize| if corner & bit != 0 { b[3 + axis] } else { b[axis] };
            let q = apply(p, pick(1, 0), pick(2, 1), pick(4, 2));
            for axis in 0..3 {
                out[axis] = js_min(out[axis], q[axis]);
                out[3 + axis] = js_max(out[3 + axis], q[axis]);
            }
        }
        out
    }
}

fn apply(p: &Placement, x: f64, y: f64, z: f64) -> Vec3 {
    let r = &p.rotation;
    let t = &p.translation;
    [r[0] * x + r[1] * y + r[2] * z + t[0], r[3] * x + r[4] * y + r[5] * z + t[1], r[6] * x + r[7] * y + r[8] * z + t[2]]
}

fn triangle_box([p, q, r]: &Triangle) -> Box6 {
    [
        js_min(js_min(p[0], q[0]), r[0]),
        js_min(js_min(p[1], q[1]), r[1]),
        js_min(js_min(p[2], q[2]), r[2]),
        js_max(js_max(p[0], q[0]), r[0]),
        js_max(js_max(p[1], q[1]), r[1]),
        js_max(js_max(p[2], q[2]), r[2]),
    ]
}

fn box_gap(a: &Box6, b: &Box6) -> f64 {
    let mut sum = 0.0;
    for axis in 0..3 {
        let gap = js_max(js_max(a[axis] - b[3 + axis], b[axis] - a[3 + axis]), 0.0);
        sum += gap * gap;
    }
    sum.sqrt()
}

fn size_sq(b: &Box6) -> f64 {
    (b[3] - b[0]) * (b[3] - b[0]) + (b[4] - b[1]) * (b[4] - b[1]) + (b[5] - b[2]) * (b[5] - b[2])
}

struct DualQuery<'a> {
    a: &'a MeshTree,
    b: &'a MeshTree,
    placement: Option<&'a Placement>,
    stop_at: f64,
    bound: f64,
    best: Option<ClosestPair>,
    done: bool,
}

impl DualQuery<'_> {
    fn visit(&mut self, node_a: usize, node_b: usize) {
        if self.done {
            return;
        }
        let box_a = self.a.node_box(node_a, None);
        let box_b = self.b.node_box(node_b, self.placement);
        if box_gap(&box_a, &box_b) > self.bound {
            return;
        }
        let (leaf_a, leaf_b) = (self.a.is_leaf(node_a), self.b.is_leaf(node_b));
        if leaf_a && leaf_b {
            self.leaves(node_a, node_b);
            return;
        }
        let split_a = !leaf_a && (leaf_b || size_sq(&box_a) >= size_sq(&box_b));
        let (parent, node) = if split_a { (self.a, node_a) } else { (self.b, node_b) };
        let children = [parent.left[node] as usize, parent.right[node] as usize];
        let mut pairs = children.map(|child| if split_a { (child, node_b) } else { (node_a, child) });
        let gap_of = |(x, y): (usize, usize)| box_gap(&self.a.node_box(x, None), &self.b.node_box(y, self.placement));
        if gap_of(pairs[1]) < gap_of(pairs[0]) {
            pairs.reverse();
        }
        for (x, y) in pairs {
            self.visit(x, y);
        }
    }

    fn leaves(&mut self, node_a: usize, node_b: usize) {
        let (a, b) = (self.a, self.b);
        let triangles_b: Vec<Triangle> =
            (0..b.count[node_b]).map(|j| b.triangle_at(b.order[b.start[node_b] + j], self.placement)).collect();
        let boxes_b: Vec<Box6> = triangles_b.iter().map(triangle_box).collect();
        for i in 0..a.count[node_a] {
            if self.done {
                break;
            }
            let triangle_a = a.triangle_at(a.order[a.start[node_a] + i], None);
            let box_of_a = triangle_box(&triangle_a);
            for (triangle_b, box_b) in triangles_b.iter().zip(&boxes_b) {
                if self.done {
                    break;
                }
                if box_gap(&box_of_a, box_b) > self.bound + 1e-12 * js_max(1.0, self.bound) {
                    continue;
                }
                let pair = triangle_distance(&triangle_a, triangle_b);
                if pair.distance <= self.bound && self.best.is_none_or(|best| pair.distance < best.distance) {
                    self.best = Some(pair);
                    self.bound = pair.distance;
                    if pair.distance <= self.stop_at {
                        self.done = true;
                    }
                }
            }
        }
    }
}

/// Closest surface points of the two meshes within `max_distance` (TS `bvhMinDistance`), witnesses in `a`'s frame; `placement` moves `b`.
pub fn min_distance(a: &MeshTree, b: &MeshTree, max_distance: f64, placement: Option<&Placement>) -> Option<ClosestPair> {
    if a.triangle_count() == 0 || b.triangle_count() == 0 {
        return None;
    }
    let mut query = DualQuery { a, b, placement, stop_at: 0.0, bound: max_distance, best: None, done: false };
    query.visit(0, 0);
    query.best
}

/// First double-sided hit of `origin + t direction`, t in [t_min, max_t]; ties go to the lower triangle index (TS `bvhRayCast`).
pub fn ray_cast(tree: &MeshTree, origin: &Vec3, direction: &Vec3, max_t: f64, t_min: f64) -> Option<RayHit> {
    if tree.triangle_count() == 0 {
        return None;
    }
    let mut best: Option<RayHit> = None;
    let mut limit = max_t;
    let mut stack = vec![0usize];
    // depth-first, left before right: the order of the TS recursion (`limit` shrinks the same way)
    while let Some(node) = stack.pop() {
        if !slab(tree, node, origin, direction, t_min, limit) {
            continue;
        }
        if tree.is_leaf(node) {
            for i in 0..tree.count[node] {
                let triangle = tree.order[tree.start[node] + i];
                let Some(t) = ray_triangle_distance(origin, direction, &tree.triangle_at(triangle, None), t_min, limit) else { continue };
                if best.is_none_or(|b| t < b.t || (t == b.t && triangle < b.triangle)) {
                    let point = [origin[0] + direction[0] * t, origin[1] + direction[1] * t, origin[2] + direction[2] * t];
                    best = Some(RayHit { t, triangle, point });
                    limit = t;
                }
            }
            continue;
        }
        stack.push(tree.right[node] as usize);
        stack.push(tree.left[node] as usize);
    }
    best
}

fn slab(tree: &MeshTree, node: usize, origin: &Vec3, direction: &Vec3, t_min: f64, limit: f64) -> bool {
    let b = &tree.boxes[node * 6..node * 6 + 6];
    let mut near = t_min;
    let mut far = limit;
    for axis in 0..3 {
        let (lo, hi) = (b[axis], b[3 + axis]);
        if direction[axis] == 0.0 {
            if origin[axis] < lo || origin[axis] > hi {
                return false;
            }
            continue;
        }
        let t1 = (lo - origin[axis]) / direction[axis];
        let t2 = (hi - origin[axis]) / direction[axis];
        near = js_max(near, js_min(t1, t2));
        far = js_min(far, js_max(t1, t2));
        if near > far * (1.0 + 1e-12) + 1e-12 {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Axis-aligned cube [lo, lo + size]^3 as 12 outward triangles.
    pub(crate) fn cube(lo: Vec3, size: f64) -> Vec<f64> {
        let v = |x: usize, y: usize, z: usize| [lo[0] + size * x as f64, lo[1] + size * y as f64, lo[2] + size * z as f64];
        let quads = [
            [v(0, 0, 0), v(0, 1, 0), v(1, 1, 0), v(1, 0, 0)],
            [v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)],
            [v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)],
            [v(0, 1, 0), v(0, 1, 1), v(1, 1, 1), v(1, 1, 0)],
            [v(0, 0, 0), v(0, 0, 1), v(0, 1, 1), v(0, 1, 0)],
            [v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1)],
        ];
        quads.iter().flat_map(|[a, b, c, d]| [a, b, c, a, c, d].into_iter().flatten().copied().collect::<Vec<f64>>()).collect()
    }

    #[test]
    fn cube_gap_and_witnesses() {
        let a = MeshTree::build(cube([0.0, 0.0, 0.0], 1.0));
        let b = MeshTree::build(cube([3.0, 0.0, 0.0], 1.0));
        let hit = min_distance(&a, &b, 10.0, None).unwrap();
        assert_eq!(hit.distance, 2.0);
        assert_eq!(hit.point_a[0], 1.0);
        assert_eq!(hit.point_b[0], 3.0);
        assert!(min_distance(&a, &b, 1.5, None).is_none());
        let back = Placement { rotation: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0], translation: [-2.5, 0.0, 0.0] };
        assert_eq!(min_distance(&a, &b, 10.0, Some(&back)).unwrap().distance, 0.0);
    }

    #[test]
    fn ray_hits_the_far_wall_and_misses_outside() {
        let tree = MeshTree::build(cube([0.0, 0.0, 0.0], 2.0));
        let hit = ray_cast(&tree, &[0.5, 0.7, 0.0], &[0.0, 0.0, 1.0], f64::INFINITY, 1e-9).unwrap();
        assert_eq!(hit.t, 2.0);
        assert_eq!(hit.point, [0.5, 0.7, 2.0]);
        assert!(ray_cast(&tree, &[5.0, 5.0, 0.0], &[0.0, 0.0, 1.0], f64::INFINITY, 0.0).is_none());
        assert!(ray_cast(&MeshTree::build(Vec::new()), &[0.0; 3], &[1.0, 0.0, 0.0], 1.0, 0.0).is_none());
    }
}

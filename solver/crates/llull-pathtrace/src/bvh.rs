//! Binned SAH bounding-volume hierarchy, used twice: one BLAS per mesh over its triangles and one TLAS over the instances (two-level, so
//! instances are never expanded). `llull-bvh` is the closest-point tree of the solvers (median split, f64, query results as vectors); a ray
//! tracer needs a surface-area split and an allocation-free nearest-first traversal, so the tracer carries its own.
//!
//! Build is single-threaded and depends only on the input order: the same scene always gives the same tree.

use crate::math::{v3, Vec3};

const BINS: usize = 16;
const LEAF_SIZE: usize = 4;
const MAX_LEAF: usize = 16;
/// Traversal stack depth; the build keeps the tree shallower by falling back to median splits.
pub const STACK: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Aabb {
    pub min: Vec3,
    pub max: Vec3,
}

impl Aabb {
    pub const EMPTY: Aabb =
        Aabb { min: v3(f32::INFINITY, f32::INFINITY, f32::INFINITY), max: v3(f32::NEG_INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY) };

    pub fn grow(&mut self, p: Vec3) {
        self.min = self.min.min(p);
        self.max = self.max.max(p);
    }

    pub fn union(&mut self, other: &Aabb) {
        self.min = self.min.min(other.min);
        self.max = self.max.max(other.max);
    }

    pub fn area(&self) -> f32 {
        let d = self.max - self.min;
        if d.x < 0.0 {
            return 0.0;
        }
        2.0 * (d.x * d.y + d.y * d.z + d.z * d.x)
    }

    pub fn centre(&self) -> Vec3 {
        (self.min + self.max) * 0.5
    }

    /// Slab test: entry distance when the ray meets the box within (0, t_max).
    pub fn hit(&self, origin: Vec3, inverse: Vec3, t_max: f32) -> Option<f32> {
        let t1 = (self.min - origin).times(inverse);
        let t2 = (self.max - origin).times(inverse);
        let near = t1.min(t2).max_component().max(0.0);
        let far = t1.max(t2);
        let far = far.x.min(far.y).min(far.z).min(t_max);
        (near <= far).then_some(near)
    }
}

/// A node: inner when `count == 0` (children `first` and `first + 1`), else a leaf over `order[first..first + count]`.
#[derive(Debug, Clone, Copy)]
pub struct Node {
    pub bounds: Aabb,
    pub first: u32,
    pub count: u32,
}

#[derive(Debug, Clone)]
pub struct Bvh {
    pub nodes: Vec<Node>,
    /// Primitive indices in leaf order.
    pub order: Vec<u32>,
}

struct Builder<'a> {
    boxes: &'a [Aabb],
    centres: Vec<Vec3>,
    nodes: Vec<Node>,
    order: Vec<u32>,
}

impl Bvh {
    /// Builds over primitive boxes (primitive `i` = `boxes[i]`); an empty input gives one empty leaf.
    pub fn build(boxes: &[Aabb]) -> Bvh {
        let centres = boxes.iter().map(Aabb::centre).collect();
        let mut builder =
            Builder { boxes, centres, nodes: Vec::with_capacity(boxes.len().max(1) * 2), order: (0..boxes.len() as u32).collect() };
        builder.nodes.push(Node { bounds: Aabb::EMPTY, first: 0, count: 0 });
        builder.split(0, 0, boxes.len(), 0);
        Bvh { nodes: builder.nodes, order: builder.order }
    }

    pub fn bounds(&self) -> Aabb {
        self.nodes[0].bounds
    }

    /// Visits leaves nearest box first; `leaf(primitive, t_max) -> Option<t>` tests one primitive and returns a closer hit, which then
    /// shortens the ray. With `any`, the first hit ends the walk (shadow rays). Returns the last accepted distance.
    pub fn traverse(
        &self,
        origin: Vec3,
        direction: Vec3,
        mut t_max: f32,
        any: bool,
        mut leaf: impl FnMut(u32, f32) -> Option<f32>,
    ) -> Option<f32> {
        if self.order.is_empty() {
            return None;
        }
        let inverse = v3(1.0 / direction.x, 1.0 / direction.y, 1.0 / direction.z);
        let root = &self.nodes[0];
        root.bounds.hit(origin, inverse, t_max)?;
        let mut stack = [0u32; STACK];
        let mut top = 1usize;
        let mut best = None;
        while top > 0 {
            top -= 1;
            let node = &self.nodes[stack[top] as usize];
            if node.count > 0 {
                let start = node.first as usize;
                for &primitive in &self.order[start..start + node.count as usize] {
                    if let Some(t) = leaf(primitive, t_max) {
                        t_max = t;
                        best = Some(t);
                        if any {
                            return best;
                        }
                    }
                }
                continue;
            }
            let (left, right) = (node.first, node.first + 1);
            let hit_left = self.nodes[left as usize].bounds.hit(origin, inverse, t_max);
            let hit_right = self.nodes[right as usize].bounds.hit(origin, inverse, t_max);
            match (hit_left, hit_right) {
                (Some(a), Some(b)) => {
                    let (near, far) = if b < a { (right, left) } else { (left, right) };
                    stack[top] = far;
                    stack[top + 1] = near;
                    top += 2;
                }
                (Some(_), None) => {
                    stack[top] = left;
                    top += 1;
                }
                (None, Some(_)) => {
                    stack[top] = right;
                    top += 1;
                }
                (None, None) => {}
            }
        }
        best
    }
}

impl Builder<'_> {
    fn split(&mut self, node: usize, start: usize, end: usize, depth: usize) {
        let mut bounds = Aabb::EMPTY;
        let mut centre_bounds = Aabb::EMPTY;
        for &primitive in &self.order[start..end] {
            bounds.union(&self.boxes[primitive as usize]);
            centre_bounds.grow(self.centres[primitive as usize]);
        }
        let count = end - start;
        self.nodes[node] = Node { bounds, first: start as u32, count: count as u32 };
        if count <= LEAF_SIZE {
            return;
        }
        let mid = match self.sah_split(start, end, &bounds, &centre_bounds, depth) {
            Some(mid) => mid,
            None => return,
        };
        let left = self.nodes.len();
        self.nodes.push(Node { bounds: Aabb::EMPTY, first: 0, count: 0 });
        self.nodes.push(Node { bounds: Aabb::EMPTY, first: 0, count: 0 });
        self.nodes[node] = Node { bounds, first: left as u32, count: 0 };
        self.split(left, start, mid, depth + 1);
        self.split(left + 1, mid, end, depth + 1);
    }

    /// Partition point of the best binned SAH split, or `None` to keep a leaf. Deep or degenerate ranges split at the median.
    fn sah_split(&mut self, start: usize, end: usize, bounds: &Aabb, centres: &Aabb, depth: usize) -> Option<usize> {
        let count = end - start;
        let extent = centres.max - centres.min;
        let axis = if extent.x >= extent.y && extent.x >= extent.z {
            0
        } else if extent.y >= extent.z {
            1
        } else {
            2
        };
        if extent[axis] <= 0.0 || depth > 48 {
            if count <= MAX_LEAF {
                return None;
            }
            return Some(self.median(start, end, axis));
        }
        let scale = BINS as f32 / extent[axis];
        let low = centres.min[axis];
        let bin_of = |c: Vec3| (((c[axis] - low) * scale) as usize).min(BINS - 1);
        let mut bin_bounds = [Aabb::EMPTY; BINS];
        let mut bin_counts = [0usize; BINS];
        for &primitive in &self.order[start..end] {
            let bin = bin_of(self.centres[primitive as usize]);
            bin_counts[bin] += 1;
            bin_bounds[bin].union(&self.boxes[primitive as usize]);
        }
        let mut right_area = [0.0f32; BINS];
        let mut right_count = [0usize; BINS];
        let (mut acc, mut n) = (Aabb::EMPTY, 0usize);
        for bin in (1..BINS).rev() {
            acc.union(&bin_bounds[bin]);
            n += bin_counts[bin];
            right_area[bin] = acc.area();
            right_count[bin] = n;
        }
        let (mut acc, mut n) = (Aabb::EMPTY, 0usize);
        let mut best = (f32::INFINITY, 0usize);
        for bin in 0..BINS - 1 {
            acc.union(&bin_bounds[bin]);
            n += bin_counts[bin];
            let cost = acc.area() * n as f32 + right_area[bin + 1] * right_count[bin + 1] as f32;
            if n > 0 && right_count[bin + 1] > 0 && cost < best.0 {
                best = (cost, bin + 1);
            }
        }
        let leaf_cost = bounds.area() * count as f32;
        if best.0.is_infinite() || (best.0 + bounds.area() >= leaf_cost && count <= MAX_LEAF) {
            if count <= MAX_LEAF {
                return None;
            }
            return Some(self.median(start, end, axis));
        }
        let split_bin = best.1;
        let slice = &mut self.order[start..end];
        let centres_of = &self.centres;
        let mut left = 0usize;
        for i in 0..slice.len() {
            if bin_of(centres_of[slice[i] as usize]) < split_bin {
                slice.swap(i, left);
                left += 1;
            }
        }
        Some(start + left)
    }

    fn median(&mut self, start: usize, end: usize, axis: usize) -> usize {
        let centres = &self.centres;
        self.order[start..end].sort_by(|a, b| centres[*a as usize][axis].total_cmp(&centres[*b as usize][axis]).then(a.cmp(b)));
        start + (end - start) / 2
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit_box(x: f32) -> Aabb {
        Aabb { min: v3(x, 0.0, 0.0), max: v3(x + 0.5, 0.5, 0.5) }
    }

    #[test]
    fn finds_the_nearest_box_along_a_ray() {
        let boxes: Vec<Aabb> = (0..200).map(|i| unit_box(i as f32)).collect();
        let bvh = Bvh::build(&boxes);
        let origin = v3(-1.0, 0.25, 0.25);
        let hit = bvh.traverse(origin, v3(1.0, 0.0, 0.0), f32::INFINITY, false, |primitive, t_max| {
            boxes[primitive as usize].hit(origin, v3(1.0, f32::INFINITY, f32::INFINITY), t_max).filter(|t| *t < t_max)
        });
        assert_eq!(hit, Some(1.0));
        let any = bvh.traverse(origin, v3(1.0, 0.0, 0.0), f32::INFINITY, true, |_, _| Some(5.0));
        assert_eq!(any, Some(5.0));
    }

    #[test]
    fn an_empty_tree_rejects_every_ray() {
        let bvh = Bvh::build(&[]);
        assert!(bvh.traverse(Vec3::ZERO, v3(0.0, 0.0, 1.0), f32::INFINITY, false, |_, _| Some(1.0)).is_none());
    }

    #[test]
    fn identical_centres_still_build() {
        let boxes = vec![unit_box(0.0); 100];
        let bvh = Bvh::build(&boxes);
        let mut seen: Vec<u32> = bvh.order.clone();
        seen.sort_unstable();
        assert_eq!(seen, (0..100).collect::<Vec<u32>>());
    }
}

//! Obstruction test of the view-factor exchange (PHY-03 TR-THM-20): does the open segment between two facet centroids cross another
//! occluder? The answer is the TypeScript brute-force loop's (`segment_hits_triangle` on every occluder but the pair's own two); the tree
//! only skips triangles whose inflated box the segment cannot reach, so the boolean per pair is the same whatever the tree.
//! The tree is built for segments that cross the inside of a cavity (PERF1 §5 row 4): a surface-area split keeps each planar wall in
//! its own flat boxes, which a segment only reaches at its two ends (the median split of `MeshTree` gives volume-filling boxes that
//! almost every segment of a closed cavity enters).

use crate::triangle::{js_max, js_min, segment_hits_triangle, sub, Triangle, Vec3};

/// An inflated box: min x, y, z then max x, y, z.
type Reach = [f64; 6];

const LEAF_SIZE: usize = 4;
const EMPTY: Reach = [f64::INFINITY, f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];

struct Node {
    reach: Reach,
    /// Inner node: the two children. Leaf: `left == right`, triangles `order[start..start + count]`.
    left: u32,
    right: u32,
    start: u32,
    count: u32,
}

/// Occluder triangles in a bounding-box tree, queried by open segments.
pub(crate) struct Occluders {
    nodes: Vec<Node>,
    order: Vec<u32>,
    triangles: Vec<Triangle>,
    /// Per triangle, its own inflated box: most triangles of a reached leaf are not reached themselves.
    reach: Vec<Reach>,
}

fn grow(bounds: &mut Reach, [p, q, r]: &Triangle) {
    for axis in 0..3 {
        bounds[axis] = js_min(bounds[axis], js_min(js_min(p[axis], q[axis]), r[axis]));
        bounds[3 + axis] = js_max(bounds[3 + axis], js_max(js_max(p[axis], q[axis]), r[axis]));
    }
}

/// `bounds` grown by 1e-7 (1 + the largest coordinate magnitude) per axis: nine orders above the rounding of the overlap test, so a
/// triangle the segment truly crosses is never skipped.
fn inflated(bounds: &Reach) -> Reach {
    let mut out = [0.0; 6];
    for axis in 0..3 {
        let margin = 1e-7 * (1.0 + js_max(bounds[axis].abs(), bounds[3 + axis].abs()));
        out[axis] = bounds[axis] - margin;
        out[3 + axis] = bounds[3 + axis] + margin;
    }
    out
}

fn half_area(b: &Reach) -> f64 {
    let (x, y, z) = (b[3] - b[0], b[4] - b[1], b[5] - b[2]);
    x * y + y * z + z * x
}

/// A segment prepared for the box tests: per axis the reciprocal of its extent (unused when the extent is 0).
struct Slabs {
    start: Vec3,
    parallel: [bool; 3],
    inverse: Vec3,
}

impl Slabs {
    fn new(start: &Vec3, end: &Vec3) -> Slabs {
        let d = sub(end, start);
        Slabs { start: *start, parallel: [d[0] == 0.0, d[1] == 0.0, d[2] == 0.0], inverse: [1.0 / d[0], 1.0 / d[1], 1.0 / d[2]] }
    }

    /// Conservative segment / inflated box overlap (slab test over the segment's own parameter range). The products round a few
    /// units in the last place away from the exact quotients; the inflation of `reach` is nine orders above that.
    #[inline]
    fn reaches(&self, reach: &Reach) -> bool {
        let mut near: f64 = 0.0;
        let mut far: f64 = 1.0;
        for axis in 0..3 {
            let (lo, hi) = (reach[axis], reach[3 + axis]);
            if self.parallel[axis] {
                if self.start[axis] < lo || self.start[axis] > hi {
                    return false;
                }
                continue;
            }
            let t1 = (lo - self.start[axis]) * self.inverse[axis];
            let t2 = (hi - self.start[axis]) * self.inverse[axis];
            near = near.max(t1.min(t2));
            far = far.min(t1.max(t2));
        }
        near <= far
    }
}

impl Occluders {
    pub(crate) fn new(triangles: Vec<Triangle>) -> Occluders {
        let reach = triangles
            .iter()
            .map(|triangle| {
                let mut bounds = EMPTY;
                grow(&mut bounds, triangle);
                inflated(&bounds)
            })
            .collect();
        let mut order: Vec<u32> = (0..triangles.len() as u32).collect();
        let mut occluders = Occluders { nodes: Vec::new(), order: Vec::new(), triangles, reach };
        if !order.is_empty() {
            occluders.split(&mut order, 0);
        }
        occluders.order = order;
        occluders
    }

    fn centroid(&self, triangle: u32, axis: usize) -> f64 {
        let [p, q, r] = &self.triangles[triangle as usize];
        p[axis] + q[axis] + r[axis]
    }

    fn bounds(&self, items: &[u32]) -> Reach {
        let mut bounds = EMPTY;
        for &t in items {
            grow(&mut bounds, &self.triangles[t as usize]);
        }
        bounds
    }

    fn sort(&self, items: &mut [u32], axis: usize) {
        items.sort_unstable_by(|&p, &q| self.centroid(p, axis).total_cmp(&self.centroid(q, axis)).then(p.cmp(&q)));
    }

    /// The node of `items` (their slice starts at `offset` of the final order). The split is the cheapest of the three axes under the
    /// surface-area cost, among cuts that leave each side at least one eighth of the triangles (so the depth stays logarithmic).
    fn split(&mut self, items: &mut [u32], offset: usize) -> u32 {
        let node = self.nodes.len();
        let count = items.len();
        self.nodes.push(Node { reach: inflated(&self.bounds(items)), left: 0, right: 0, start: offset as u32, count: count as u32 });
        if count <= LEAF_SIZE {
            return node as u32;
        }
        let (first, last) = ((count / 8).max(1), count - (count / 8).max(1));
        let mut best: Option<(f64, usize, usize)> = None;
        let mut right_area = vec![0.0; count + 1];
        for axis in 0..3 {
            self.sort(items, axis);
            let mut bounds = EMPTY;
            for k in (first..count).rev() {
                grow(&mut bounds, &self.triangles[items[k] as usize]);
                right_area[k] = half_area(&bounds);
            }
            bounds = EMPTY;
            for k in 1..=last {
                grow(&mut bounds, &self.triangles[items[k - 1] as usize]);
                if k >= first {
                    let cost = half_area(&bounds) * k as f64 + right_area[k] * (count - k) as f64;
                    if best.is_none_or(|(least, ..)| cost < least) {
                        best = Some((cost, axis, k));
                    }
                }
            }
        }
        let (_, axis, cut) = best.unwrap_or((0.0, 0, count / 2));
        self.sort(items, axis);
        let (low, high) = items.split_at_mut(cut);
        let left = self.split(low, offset);
        let right = self.split(high, offset + cut);
        self.nodes[node].left = left;
        self.nodes[node].right = right;
        node as u32
    }

    /// Whether the open segment crosses a non-skipped occluder (`skip` = occluder indices).
    pub(crate) fn blocked(&self, start: &Vec3, end: &Vec3, skip: [usize; 2]) -> bool {
        !self.nodes.is_empty() && self.visit(0, &Slabs::new(start, end), start, end, skip)
    }

    fn visit(&self, index: u32, slabs: &Slabs, start: &Vec3, end: &Vec3, skip: [usize; 2]) -> bool {
        let node = &self.nodes[index as usize];
        if !slabs.reaches(&node.reach) {
            return false;
        }
        if node.left != node.right {
            return self.visit(node.left, slabs, start, end, skip) || self.visit(node.right, slabs, start, end, skip);
        }
        self.order[node.start as usize..(node.start + node.count) as usize].iter().any(|&t| {
            let t = t as usize;
            !skip.contains(&t) && slabs.reaches(&self.reach[t]) && segment_hits_triangle(start, end, &self.triangles[t])
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// xorshift64* in [0, 1).
    fn uniform(seed: u64) -> impl FnMut() -> f64 {
        let mut state = seed;
        move || {
            state ^= state >> 12;
            state ^= state << 25;
            state ^= state >> 27;
            (state.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64 / 9_007_199_254_740_992.0
        }
    }

    /// The walls of the unit cube, `n` x `n` cells of two triangles each.
    fn cube_walls(n: usize) -> Vec<Triangle> {
        let mut out = Vec::new();
        for axis in 0..3 {
            for side in [0.0, 1.0] {
                let point = |a: usize, b: usize| {
                    let mut p = [side; 3];
                    p[(axis + 1) % 3] = a as f64 / n as f64;
                    p[(axis + 2) % 3] = b as f64 / n as f64;
                    p
                };
                for a in 0..n {
                    for b in 0..n {
                        out.push([point(a, b), point(a + 1, b), point(a + 1, b + 1)]);
                        out.push([point(a, b), point(a + 1, b + 1), point(a, b + 1)]);
                    }
                }
            }
        }
        out
    }

    fn brute(triangles: &[Triangle], start: &Vec3, end: &Vec3, skip: [usize; 2]) -> bool {
        triangles.iter().enumerate().any(|(k, t)| !skip.contains(&k) && segment_hits_triangle(start, end, t))
    }

    fn centroid(t: &Triangle) -> Vec3 {
        [(t[0][0] + t[1][0] + t[2][0]) / 3.0, (t[0][1] + t[1][1] + t[2][1]) / 3.0, (t[0][2] + t[1][2] + t[2][2]) / 3.0]
    }

    #[test]
    fn every_centroid_pair_of_a_baffled_cavity_answers_as_the_brute_force_loop() {
        let mut triangles = cube_walls(4);
        triangles.push([[0.3, 0.3, 0.5], [0.7, 0.3, 0.5], [0.7, 0.7, 0.5]]);
        triangles.push([[0.3, 0.3, 0.5], [0.7, 0.7, 0.5], [0.3, 0.7, 0.5]]);
        let occluders = Occluders::new(triangles.clone());
        let mut blocked = 0;
        for i in 0..triangles.len() {
            for j in 0..triangles.len() {
                let (start, end) = (centroid(&triangles[i]), centroid(&triangles[j]));
                let expected = brute(&triangles, &start, &end, [i, j]);
                assert_eq!(occluders.blocked(&start, &end, [i, j]), expected, "{i} -> {j}");
                blocked += usize::from(expected);
            }
        }
        assert!(blocked > 500, "{blocked}");
    }

    #[test]
    fn random_soups_and_segments_answer_as_the_brute_force_loop() {
        let mut next = uniform(0x1234_5678_9ABC_DEF1);
        for count in [0usize, 1, 3, 4, 5, 17, 200] {
            let mut point = |spread: f64| [next() * spread, next() * spread, next() * spread];
            let triangles: Vec<Triangle> = (0..count)
                .map(|_| {
                    let a = point(10.0);
                    let (u, v) = (point(2.0), point(2.0));
                    [a, [a[0] + u[0], a[1] + u[1], a[2] + u[2]], [a[0] + v[0] - 1.0, a[1] + v[1] - 1.0, a[2] + v[2]]]
                })
                .collect();
            let occluders = Occluders::new(triangles.clone());
            let mut hits = 0;
            for k in 0..4000 {
                // every eighth segment is parallel to an axis (the zero-extent branch of the slab test)
                let start = point(12.0);
                let mut end = point(12.0);
                if k % 8 == 0 {
                    end[k / 8 % 3] = start[k / 8 % 3];
                }
                let skip = [k % count.max(1), usize::MAX];
                let expected = brute(&triangles, &start, &end, skip);
                assert_eq!(occluders.blocked(&start, &end, skip), expected, "{count} triangles, segment {k}");
                hits += usize::from(expected);
            }
            assert!(count < 17 || hits > 100, "{count}: {hits}");
        }
    }

    #[test]
    fn identical_triangles_still_split() {
        let triangles = vec![[[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]; 40];
        let occluders = Occluders::new(triangles);
        assert!(occluders.blocked(&[0.2, 0.2, -1.0], &[0.2, 0.2, 1.0], [0, 1]));
        assert!(!occluders.blocked(&[0.2, 0.2, 0.5], &[0.2, 0.2, 1.0], [0, 1]));
    }
}

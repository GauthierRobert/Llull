//! Bounding-volume hierarchy over the axis segments of an explicit strut set (05 IMP §14.9): twin of `strutBvh.ts`. It only decides which
//! beams are NOT evaluated; every evaluated beam uses the unchanged brute arithmetic, so the minimum is bit-identical to the loop over all
//! beams. A node is skipped only when a conservative lower bound of the signed distance of every beam under it is strictly greater than
//! the best so far; ties (including 0 against -0) go to the lowest beam index, as in the brute loop.

use crate::jsnum::{jmax, jmin};
use crate::struts::Segment;

/// Below this many beams the plain loop is as fast.
pub const BVH_MIN_SEGMENTS: usize = 32;
const LEAF_SIZE: usize = 4;
const STACK_SIZE: usize = 128;
/// Relative slack on the bound, times (|p| + set scale + beam radius): `rho = sqrt(|p|^2 - s^2)` errs by about 3e-8 |p| near an axis, a butt edge by about eps r.
const SLACK: f64 = 1e-6;
const OVERFLOW: f64 = 1e300;

struct Node {
    lo: [f64; 3],
    hi: [f64; 3],
    reach: f64,
    unbounded: bool,
    first: usize,
    /// Beams in the leaf (0 for an inner node, whose left child is the next node).
    count: usize,
    right: usize,
}

pub struct Bvh {
    nodes: Vec<Node>,
    order: Vec<usize>,
    scale: f64,
}

/// Beams the bound proof does not cover (non finite data, a length so small that `s = dot / length` loses its precision): never skipped.
fn is_unbounded(seg: &Segment) -> bool {
    let all = [seg.a[0], seg.a[1], seg.a[2], seg.d[0], seg.d[1], seg.d[2], seg.length];
    !all.iter().all(|v| v.is_finite()) || (seg.length > 0.0 && seg.length < 1e-100)
}

/// Total order of sort keys: numbers ascending, NaN after every number and equal to itself (`sort_by` panics on a broken total order).
fn compare_keys(a: f64, b: f64) -> std::cmp::Ordering {
    match (a.is_nan(), b.is_nan()) {
        (true, true) => std::cmp::Ordering::Equal,
        (true, false) => std::cmp::Ordering::Greater,
        (false, true) => std::cmp::Ordering::Less,
        (false, false) => a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal),
    }
}

fn end_of(seg: &Segment) -> [f64; 3] {
    [seg.a[0] + seg.d[0], seg.a[1] + seg.d[1], seg.a[2] + seg.d[2]]
}

impl Bvh {
    pub fn new(segments: &[Segment]) -> Bvh {
        let centroid: Vec<[f64; 3]> =
            segments.iter().map(|s| [s.a[0] + s.d[0] / 2.0, s.a[1] + s.d[1] / 2.0, s.a[2] + s.d[2] / 2.0]).collect();
        let mut bvh = Bvh { nodes: Vec::new(), order: (0..segments.len()).collect(), scale: 0.0 };
        if !segments.is_empty() {
            bvh.build(segments, &centroid, 0, segments.len());
        }
        for seg in segments {
            let b = end_of(seg);
            for (a, e) in seg.a.iter().zip(b.iter()) {
                bvh.scale = jmax(jmax(bvh.scale, a.abs()), e.abs());
            }
        }
        bvh
    }

    fn build(&mut self, segments: &[Segment], centroid: &[[f64; 3]], start: usize, end: usize) -> usize {
        let node = self.nodes.len();
        let mut lo = [f64::INFINITY; 3];
        let mut hi = [f64::NEG_INFINITY; 3];
        let (mut reach, mut unbounded) = (0.0, false);
        for k in start..end {
            let seg = &segments[self.order[k]];
            let b = end_of(seg);
            for axis in 0..3 {
                lo[axis] = jmin(jmin(lo[axis], seg.a[axis]), b[axis]);
                hi[axis] = jmax(jmax(hi[axis], seg.a[axis]), b[axis]);
            }
            reach = jmax(jmax(reach, seg.ra.abs()), seg.rb.abs());
            unbounded |= is_unbounded(seg);
        }
        self.nodes.push(Node { lo, hi, reach, unbounded, first: start, count: 0, right: 0 });
        if end - start <= LEAF_SIZE {
            self.nodes[node].count = end - start;
            return node;
        }
        let (mut low, mut high) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
        for &index in &self.order[start..end] {
            for (candidate, c) in centroid[index].iter().enumerate() {
                low[candidate] = jmin(low[candidate], *c);
                high[candidate] = jmax(high[candidate], *c);
            }
        }
        let (mut axis, mut widest) = (0, -1.0);
        for (candidate, (l, h)) in low.iter().zip(high.iter()).enumerate() {
            if h - l > widest {
                (widest, axis) = (h - l, candidate);
            }
        }
        self.order[start..end].sort_by(|&p, &q| compare_keys(centroid[p][axis], centroid[q][axis]).then(p.cmp(&q)));
        let middle = (start + end) >> 1;
        self.build(segments, centroid, start, middle);
        let right = self.build(segments, centroid, middle, end);
        self.nodes[node].right = right;
        node
    }

    fn point_scale(x: f64, y: f64, z: f64) -> f64 {
        jmax(jmax(x.abs(), y.abs()), z.abs())
    }

    fn bound(&self, node: usize, p: [f64; 3], radius: f64, point_scale: f64) -> f64 {
        let n = &self.nodes[node];
        if n.unbounded {
            return f64::NEG_INFINITY;
        }
        let gap = |axis: usize| jmax(jmax(n.lo[axis] - p[axis], p[axis] - n.hi[axis]), 0.0);
        let (gx, gy, gz) = (gap(0), gap(1), gap(2));
        let sum = gx * gx + gy * gy + gz * gz;
        if sum.is_nan() || sum >= OVERFLOW {
            return f64::NEG_INFINITY;
        }
        let r = if radius >= 0.0 { radius } else { n.reach };
        sum.sqrt() - r - SLACK * (point_scale + self.scale + r)
    }

    /// Lower bound of the distance to every beam (-inf when not provable).
    #[cfg(test)]
    pub fn root_bound(&self, x: f64, y: f64, z: f64, radius: f64) -> f64 {
        if self.nodes.is_empty() {
            return f64::INFINITY;
        }
        self.bound(0, [x, y, z], radius, Self::point_scale(x, y, z))
    }

    /// Minimum of `distance_of(i)` over every beam, skipping the beams that provably cannot beat the best (NaN is never taken, as `d < best`).
    pub fn nearest(&self, x: f64, y: f64, z: f64, radius: f64, distance_of: impl Fn(usize) -> f64) -> f64 {
        let mut best = f64::INFINITY;
        if self.nodes.is_empty() {
            return best;
        }
        let mut best_index: Option<usize> = None;
        let (p, scale) = ([x, y, z], Self::point_scale(x, y, z));
        let mut stack = [0usize; STACK_SIZE];
        let mut top = 1;
        while top > 0 {
            top -= 1;
            let node = stack[top];
            if self.bound(node, p, radius, scale) > best {
                continue;
            }
            let n = &self.nodes[node];
            if n.count > 0 {
                for &index in &self.order[n.first..n.first + n.count] {
                    let d = distance_of(index);
                    if d < best || (d == best && best_index.is_some_and(|b| index < b)) {
                        best = d;
                        best_index = Some(index);
                    }
                }
                continue;
            }
            let (left, far) = (node + 1, n.right);
            if self.bound(left, p, radius, scale) <= self.bound(far, p, radius, scale) {
                stack[top] = far;
                stack[top + 1] = left;
            } else {
                stack[top] = left;
                stack[top + 1] = far;
            }
            top += 2;
        }
        best
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::struts::{distance_to_segments, segment_of};

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> f64 {
            self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = self.0;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            ((z ^ (z >> 31)) >> 11) as f64 / (1u64 << 53) as f64
        }
        fn point(&mut self, extent: f64) -> [f64; 3] {
            [self.next() * extent, self.next() * extent, self.next() * extent]
        }
    }

    fn random_segments(rng: &mut Rng, count: usize, extent: f64) -> Vec<Segment> {
        (0..count)
            .map(|i| {
                let a = rng.point(extent);
                let b = if i % 11 == 0 { a } else { rng.point(extent) };
                let (ra, rb) = (rng.next() * 0.6, if i % 5 == 0 { rng.next() * 0.6 } else { 0.3 });
                segment_of(a, b, ra, rb, i % 3 != 0)
            })
            .collect()
    }

    fn same_bits(a: f64, b: f64) -> bool {
        a.to_bits() == b.to_bits() || (a.is_nan() && b.is_nan())
    }

    fn check(segments: &[Segment], points: &[[f64; 3]]) {
        let bvh = Bvh::new(segments);
        for radius in [-1.0, 0.0, 0.25, 2.0] {
            for p in points {
                let brute = distance_to_segments(segments, p[0], p[1], p[2], radius);
                let fast = bvh
                    .nearest(p[0], p[1], p[2], radius, |i| crate::struts::distance_to_segments(&segments[i..=i], p[0], p[1], p[2], radius));
                assert!(same_bits(brute, fast), "{p:?} radius {radius}: brute {brute} bvh {fast}");
                assert!(bvh.root_bound(p[0], p[1], p[2], radius) <= brute || brute.is_nan(), "bound above the true value at {p:?}");
            }
        }
    }

    #[test]
    fn the_bvh_minimum_is_bit_identical_to_the_brute_loop() {
        let mut rng = Rng(7);
        let segments = random_segments(&mut rng, 300, 40.0);
        let mut points: Vec<[f64; 3]> = (0..1500).map(|_| rng.point(44.0)).collect();
        points.extend(segments.iter().take(100).flat_map(|s| [s.a, [s.a[0] + s.d[0], s.a[1] + s.d[1], s.a[2] + s.d[2]]]));
        points.extend(segments.iter().take(100).map(|s| [s.a[0] + s.d[0] / 2.0, s.a[1] + s.d[1] / 2.0, s.a[2] + s.d[2] / 2.0 + 0.1]));
        points.extend([[1e3, -1e3, 5e2], [-1e6, 0.0, 0.0], [20.0, 20.0, 20.0]]);
        check(&segments, &points);
    }

    #[test]
    fn nan_points_and_non_finite_beams_never_change_the_result() {
        let mut rng = Rng(11);
        let mut segments = random_segments(&mut rng, 80, 10.0);
        let bvh_plain = Bvh::new(&segments);
        let nan = bvh_plain.nearest(f64::NAN, 1.0, 1.0, -1.0, |i| distance_to_segments(&segments[i..=i], f64::NAN, 1.0, 1.0, -1.0));
        assert!(same_bits(nan, distance_to_segments(&segments, f64::NAN, 1.0, 1.0, -1.0)));
        segments[5] = segment_of([f64::NAN, 0.0, 0.0], [1.0, 1.0, 1.0], 0.2, 0.2, true);
        segments[9] = segment_of([0.0, 0.0, 0.0], [1e-120, 0.0, 0.0], 0.2, 0.2, false);
        segments[13] = segment_of([f64::INFINITY, 0.0, 0.0], [1.0, 1.0, 1.0], 0.2, 0.2, true);
        let points: Vec<[f64; 3]> = (0..300).map(|_| rng.point(12.0)).collect();
        check(&segments, &points);
    }

    #[test]
    fn a_zero_and_a_negative_zero_keep_the_brute_choice() {
        for swap in [false, true] {
            let mut segments: Vec<Segment> =
                (0..60).map(|i| segment_of([100.0 + i as f64, 50.0, 0.0], [100.0 + i as f64, 60.0, 0.0], 0.1, 0.1, true)).collect();
            let negative = segment_of([19.0, 0.0, 0.0], [29.0, 0.0, 0.0], 1.0, 1.0, false);
            let positive = segment_of([20.0, 0.0, 0.0], [30.0, 0.0, 0.0], 1.0, 1.0, true);
            let (first, second) = if swap { (positive, negative) } else { (negative, positive) };
            segments[10] = first;
            segments[50] = second;
            let brute = distance_to_segments(&segments, 19.0, 0.0, 0.0, -1.0);
            let bvh = Bvh::new(&segments);
            let fast = bvh.nearest(19.0, 0.0, 0.0, -1.0, |i| distance_to_segments(&segments[i..=i], 19.0, 0.0, 0.0, -1.0));
            assert_eq!(brute, 0.0);
            assert_eq!(brute.to_bits(), fast.to_bits(), "swap {swap}: brute {brute:?} bvh {fast:?}");
        }
    }

    #[test]
    fn a_nan_node_in_a_fifth_of_the_beams_never_panics_the_sort_and_never_changes_the_result() {
        for seed in 0..20 {
            let mut rng = Rng(100 + seed);
            let mut segments = random_segments(&mut rng, 240, 20.0);
            for (i, seg) in segments.iter_mut().enumerate() {
                if i % 5 == 0 {
                    *seg = segment_of([f64::NAN; 3], [rng.next() * 20.0, 1.0, 2.0], 0.2, 0.2, true);
                }
            }
            let points: Vec<[f64; 3]> = (0..60).map(|_| rng.point(22.0)).collect();
            check(&segments, &points);
        }
    }

    #[test]
    fn every_beam_bound_stays_below_its_distance_including_the_corner_octant_and_wide_radii() {
        let mut rng = Rng(3);
        for seg in random_segments(&mut rng, 150, 30.0) {
            let single = [seg];
            let bvh = Bvh::new(&single);
            for _ in 0..40 {
                let p = rng.point(40.0);
                for radius in [-1.0, 0.4] {
                    let d = distance_to_segments(&single, p[0] - 5.0, p[1] - 5.0, p[2] - 5.0, radius);
                    assert!(bvh.root_bound(p[0] - 5.0, p[1] - 5.0, p[2] - 5.0, radius) <= d);
                }
            }
        }
        for (reach, offset) in [(0.3, 0.0), (50.0, 0.0), (1e4, 3e3), (0.3, 1e5)] {
            for sphere in [true, false] {
                let a = [offset, offset, offset];
                let b = [offset + 10.0, offset + 10.0, offset + 10.0];
                let single = [segment_of(a, b, reach, reach, sphere)];
                let bvh = Bvh::new(&single);
                for step in 0..400 {
                    let t = 0.01 + step as f64 * 0.37;
                    let (x, y, z) = (b[0] + t / 3f64.sqrt(), b[1] + t / 3f64.sqrt(), b[2] + t / 3f64.sqrt());
                    for radius in [-1.0, 0.5 * reach] {
                        let d = distance_to_segments(&single, x, y, z, radius);
                        assert!(bvh.root_bound(x, y, z, radius) <= d, "reach {reach} offset {offset} t {t} radius {radius}");
                    }
                }
            }
        }
    }

    #[test]
    fn an_empty_set_is_infinitely_far() {
        let bvh = Bvh::new(&[]);
        assert_eq!(bvh.nearest(0.0, 0.0, 0.0, -1.0, |_| 0.0), f64::INFINITY);
        assert_eq!(bvh.root_bound(0.0, 0.0, 0.0, -1.0), f64::INFINITY);
    }
}

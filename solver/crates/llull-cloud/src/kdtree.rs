//! Static kd-tree (TECHNICAL_SPEC §5.4): median split on the axis of largest extent (ties: lower axis), points ordered by coordinate then
//! index, so the tree and every answer are deterministic; equal distances are broken by the lower point index.

use crate::cloud::Vec3;

#[derive(Debug, Clone)]
pub struct KdTree {
    points: Vec<Vec3>,
    /// Point indices in tree order; node [lo, hi) splits at mid = (lo + hi) / 2.
    order: Vec<u32>,
    axes: Vec<u8>,
}

/// Seeded xorshift128+ (TR-SCN-08): the RANSAC / subsampling generator; the 128-bit state comes from splitmix64 of the seed.
#[derive(Debug, Clone)]
pub struct Rng {
    s0: u64,
    s1: u64,
}

impl Rng {
    pub fn new(seed: u64) -> Rng {
        let mut z = seed;
        let mut split = || {
            z = z.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut x = z;
            x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            x ^ (x >> 31)
        };
        let (s0, s1) = (split(), split());
        Rng { s0, s1: if s0 == 0 && s1 == 0 { 1 } else { s1 } }
    }

    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.s0;
        let y = self.s1;
        self.s0 = y;
        x ^= x << 23;
        self.s1 = x ^ y ^ (x >> 17) ^ (y >> 26);
        self.s1.wrapping_add(y)
    }

    /// Uniform in [0, n).
    pub fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n.max(1) as u64) as usize
    }

    /// Uniform in [0, 1).
    pub fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
}

fn squared(a: &Vec3, b: &Vec3) -> f64 {
    (a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)
}

impl KdTree {
    pub fn build(points: &[Vec3]) -> KdTree {
        let mut order: Vec<u32> = (0..points.len() as u32).collect();
        let mut axes = vec![0u8; points.len()];
        build_range(points, &mut order, &mut axes, 0, points.len());
        KdTree { points: points.to_vec(), order, axes }
    }

    pub fn len(&self) -> usize {
        self.points.len()
    }

    pub fn is_empty(&self) -> bool {
        self.points.is_empty()
    }

    pub fn point(&self, i: usize) -> &Vec3 {
        &self.points[i]
    }

    /// Nearest point to `p` other than `skip`: (index, distance).
    pub fn nearest(&self, p: &Vec3, skip: Option<usize>) -> Option<(usize, f64)> {
        let mut best: Option<(usize, f64)> = None;
        self.visit_nearest(p, skip, 0, self.order.len(), &mut best);
        best.map(|(i, d2)| (i, d2.sqrt()))
    }

    fn visit_nearest(&self, p: &Vec3, skip: Option<usize>, lo: usize, hi: usize, best: &mut Option<(usize, f64)>) {
        if lo >= hi {
            return;
        }
        let mid = (lo + hi) / 2;
        let index = self.order[mid] as usize;
        let q = &self.points[index];
        if Some(index) != skip {
            let d2 = squared(p, q);
            let better = match best {
                None => true,
                Some((bi, bd)) => d2 < *bd || (d2 == *bd && index < *bi),
            };
            if better {
                *best = Some((index, d2));
            }
        }
        let axis = self.axes[mid] as usize;
        let delta = p[axis] - q[axis];
        let (near, far) = if delta <= 0.0 { ((lo, mid), (mid + 1, hi)) } else { ((mid + 1, hi), (lo, mid)) };
        self.visit_nearest(p, skip, near.0, near.1, best);
        if best.is_none_or(|(_, bd)| delta * delta <= bd) {
            self.visit_nearest(p, skip, far.0, far.1, best);
        }
    }

    /// The k nearest points to `p` (including a point equal to p), sorted by (distance, index).
    pub fn knn(&self, p: &Vec3, k: usize) -> Vec<(usize, f64)> {
        let mut heap: Vec<(f64, usize)> = Vec::with_capacity(k + 1);
        self.visit_knn(p, k, 0, self.order.len(), &mut heap);
        heap.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        heap.into_iter().map(|(d2, i)| (i, d2.sqrt())).collect()
    }

    fn worst(heap: &[(f64, usize)]) -> Option<(f64, usize)> {
        heap.iter().copied().max_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)))
    }

    fn visit_knn(&self, p: &Vec3, k: usize, lo: usize, hi: usize, heap: &mut Vec<(f64, usize)>) {
        if lo >= hi || k == 0 {
            return;
        }
        let mid = (lo + hi) / 2;
        let index = self.order[mid] as usize;
        let q = &self.points[index];
        let d2 = squared(p, q);
        if heap.len() < k {
            heap.push((d2, index));
        } else if let Some(w) = Self::worst(heap) {
            if d2 < w.0 || (d2 == w.0 && index < w.1) {
                let at = heap.iter().position(|e| *e == w).unwrap_or(0);
                heap[at] = (d2, index);
            }
        }
        let axis = self.axes[mid] as usize;
        let delta = p[axis] - q[axis];
        let (near, far) = if delta <= 0.0 { ((lo, mid), (mid + 1, hi)) } else { ((mid + 1, hi), (lo, mid)) };
        self.visit_knn(p, k, near.0, near.1, heap);
        if heap.len() < k || Self::worst(heap).is_some_and(|w| delta * delta <= w.0) {
            self.visit_knn(p, k, far.0, far.1, heap);
        }
    }

    /// Indices of the points within `radius` of `p`, ascending.
    pub fn within(&self, p: &Vec3, radius: f64) -> Vec<usize> {
        let mut out = Vec::new();
        self.visit_within(p, radius * radius, 0, self.order.len(), &mut out);
        out.sort_unstable();
        out
    }

    fn visit_within(&self, p: &Vec3, r2: f64, lo: usize, hi: usize, out: &mut Vec<usize>) {
        if lo >= hi {
            return;
        }
        let mid = (lo + hi) / 2;
        let index = self.order[mid] as usize;
        let q = &self.points[index];
        if squared(p, q) <= r2 {
            out.push(index);
        }
        let axis = self.axes[mid] as usize;
        let delta = p[axis] - q[axis];
        if delta <= 0.0 || delta * delta <= r2 {
            self.visit_within(p, r2, lo, mid, out);
        }
        if delta >= 0.0 || delta * delta <= r2 {
            self.visit_within(p, r2, mid + 1, hi, out);
        }
    }
}

fn build_range(points: &[Vec3], order: &mut [u32], axes: &mut [u8], lo: usize, hi: usize) {
    if hi - lo <= 1 {
        return;
    }
    let mut low = [f64::INFINITY; 3];
    let mut high = [f64::NEG_INFINITY; 3];
    for &i in &order[lo..hi] {
        for a in 0..3 {
            low[a] = low[a].min(points[i as usize][a]);
            high[a] = high[a].max(points[i as usize][a]);
        }
    }
    let axis = (0..3).fold(0, |best, a| if high[a] - low[a] > high[best] - low[best] { a } else { best });
    order[lo..hi].sort_unstable_by(|&i, &j| points[i as usize][axis].total_cmp(&points[j as usize][axis]).then(i.cmp(&j)));
    let mid = (lo + hi) / 2;
    axes[mid] = axis as u8;
    build_range(points, order, axes, lo, mid);
    build_range(points, order, axes, mid + 1, hi);
}

/// Median nearest-neighbour distance of `points` (the cloud's point spacing), over at most `sample` points taken evenly.
pub fn median_spacing(tree: &KdTree, sample: usize) -> f64 {
    let n = tree.len();
    if n < 2 {
        return 0.0;
    }
    let step = (n / sample.max(1)).max(1);
    let mut distances: Vec<f64> = (0..n).step_by(step).filter_map(|i| tree.nearest(tree.point(i), Some(i)).map(|(_, d)| d)).collect();
    distances.sort_by(f64::total_cmp);
    distances[distances.len() / 2]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cloud() -> Vec<Vec3> {
        let mut rng = Rng::new(3);
        (0..2000).map(|_| [rng.unit(), rng.unit() * 2.0, rng.unit() * 0.5]).collect()
    }

    #[test]
    fn queries_match_brute_force() {
        let points = cloud();
        let tree = KdTree::build(&points);
        let mut rng = Rng::new(9);
        for _ in 0..50 {
            let p = [rng.unit(), rng.unit() * 2.0, rng.unit() * 0.5];
            let mut brute: Vec<(f64, usize)> = points.iter().enumerate().map(|(i, q)| (squared(&p, q), i)).collect();
            brute.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
            assert_eq!(tree.nearest(&p, None).unwrap().0, brute[0].1);
            let knn: Vec<usize> = tree.knn(&p, 7).iter().map(|e| e.0).collect();
            assert_eq!(knn, brute[..7].iter().map(|e| e.1).collect::<Vec<_>>());
            let mut inside: Vec<usize> = brute.iter().filter(|e| e.0 <= 0.01).map(|e| e.1).collect();
            inside.sort_unstable();
            assert_eq!(tree.within(&p, 0.1), inside);
        }
        assert!(median_spacing(&tree, 500) > 0.0);
    }

    #[test]
    fn rng_is_seeded_and_uniform_enough() {
        let (mut a, mut b) = (Rng::new(1), Rng::new(1));
        assert_eq!((a.next_u64(), a.next_u64()), (b.next_u64(), b.next_u64()));
        let mean: f64 = (0..10_000).map(|_| a.unit()).sum::<f64>() / 10_000.0;
        assert!((mean - 0.5).abs() < 0.02);
        assert!(a.below(10) < 10);
    }
}

//! Sampled scalar data of the tape (`sample_field`): twin of `packages/core/src/geometry/field/sampled.ts` (05 IMP 14.11). A cell-centred density grid read
//! by trilinear interpolation (edge values outside), or a tetrahedral mesh with node values read by barycentric interpolation in the first tetrahedron
//! (lowest index) that contains the point, the nearest node (lowest index on a tie) outside. Only + - * / floor and comparisons: bit-identical to TypeScript.

use llull_jsmath::cbrt;

use crate::jsnum::{jmax, jmin};

const OUTSIDE_TOLERANCE: f64 = -1e-9;
const MAX_BUCKETS_PER_AXIS: f64 = 64.0;

#[derive(Clone, Debug)]
pub enum Sampled {
    Grid(Grid),
    Tets(Tets),
}

#[derive(Clone, Debug)]
pub struct Grid {
    nodes: [usize; 3],
    origin: [f64; 3],
    voxel: f64,
    values: Vec<f64>,
    lo: f64,
    hi: f64,
}

#[derive(Clone, Debug)]
pub struct Tets {
    points: Vec<f64>,
    tets: Vec<usize>,
    values: Vec<f64>,
    data_lo: f64,
    data_hi: f64,
    low: [f64; 3],
    high: [f64; 3],
    resolution: usize,
    size: [f64; 3],
    buckets: Vec<Vec<usize>>,
}

/// Smallest and largest value (NaN-free data: `sampledFieldError` / the loader refuse the rest).
fn extremes(values: &[f64]) -> (f64, f64) {
    values.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), &v| (if v < lo { v } else { lo }, if v > hi { v } else { hi }))
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

fn clamp_index(i: f64, n: usize) -> usize {
    let last = (n - 1) as f64;
    (if i < 0.0 {
        0.0
    } else if i > last {
        last
    } else {
        i
    }) as usize
}

impl Grid {
    pub fn new(nodes: [usize; 3], origin: [f64; 3], voxel: f64, values: Vec<f64>) -> Grid {
        let (lo, hi) = extremes(&values);
        Grid { nodes, origin, voxel, values, lo, hi }
    }

    fn at(&self, i: usize, j: usize, k: usize) -> f64 {
        self.values[i + self.nodes[0] * (j + self.nodes[1] * k)]
    }

    fn value(&self, x: f64, y: f64, z: f64) -> f64 {
        let u = [(x - self.origin[0]) / self.voxel - 0.5, (y - self.origin[1]) / self.voxel - 0.5, (z - self.origin[2]) / self.voxel - 0.5];
        if !(u[0].is_finite() && u[1].is_finite() && u[2].is_finite()) {
            return f64::NAN;
        }
        let f = u.map(f64::floor);
        let t = [u[0] - f[0], u[1] - f[1], u[2] - f[2]];
        let [nx, ny, nz] = self.nodes;
        let (ia, ib) = (clamp_index(f[0], nx), clamp_index(f[0] + 1.0, nx));
        let (ja, jb) = (clamp_index(f[1], ny), clamp_index(f[1] + 1.0, ny));
        let (ka, kb) = (clamp_index(f[2], nz), clamp_index(f[2] + 1.0, nz));
        let c00 = lerp(self.at(ia, ja, ka), self.at(ib, ja, ka), t[0]);
        let c10 = lerp(self.at(ia, jb, ka), self.at(ib, jb, ka), t[0]);
        let c01 = lerp(self.at(ia, ja, kb), self.at(ib, ja, kb), t[0]);
        let c11 = lerp(self.at(ia, jb, kb), self.at(ib, jb, kb), t[0]);
        jmin(jmax(lerp(lerp(c00, c10, t[1]), lerp(c01, c11, t[1]), t[2]), self.lo), self.hi)
    }
}

fn cross(u: [f64; 3], v: [f64; 3]) -> [f64; 3] {
    [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
}

fn dot(u: [f64; 3], v: [f64; 3]) -> f64 {
    u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
}

impl Tets {
    pub fn new(points: Vec<f64>, tets: Vec<usize>, values: Vec<f64>) -> Tets {
        let tet_count = tets.len() / 4;
        let mut low = [f64::INFINITY; 3];
        let mut high = [f64::NEG_INFINITY; 3];
        for n in points.chunks_exact(3) {
            for axis in 0..3 {
                low[axis] = jmin(low[axis], n[axis]);
                high[axis] = jmax(high[axis], n[axis]);
            }
        }
        let resolution = jmax(1.0, jmin(MAX_BUCKETS_PER_AXIS, cbrt(tet_count as f64).ceil())) as usize;
        let size = [0, 1, 2].map(|axis| jmax((high[axis] - low[axis]) / resolution as f64, 1e-300));
        let (data_lo, data_hi) = extremes(&values);
        let mut built = Tets { points, tets, values, data_lo, data_hi, low, high, resolution, size, buckets: Vec::new() };
        let mut buckets: Vec<Vec<usize>> = vec![Vec::new(); resolution * resolution * resolution];
        for t in 0..tet_count {
            let mut lo = [f64::INFINITY; 3];
            let mut hi = [f64::NEG_INFINITY; 3];
            for v in 0..4 {
                let node = built.tets[4 * t + v];
                for axis in 0..3 {
                    let coordinate = built.points[3 * node + axis];
                    lo[axis] = jmin(lo[axis], coordinate);
                    hi[axis] = jmax(hi[axis], coordinate);
                }
            }
            for k in built.cell_of(2, lo[2])..=built.cell_of(2, hi[2]) {
                for j in built.cell_of(1, lo[1])..=built.cell_of(1, hi[1]) {
                    for i in built.cell_of(0, lo[0])..=built.cell_of(0, hi[0]) {
                        buckets[i + resolution * (j + resolution * k)].push(t);
                    }
                }
            }
        }
        built.buckets = buckets;
        built
    }

    fn cell_of(&self, axis: usize, v: f64) -> usize {
        let c = ((v - self.low[axis]) / self.size[axis]).floor();
        (if c < 0.0 {
            0.0
        } else if c > (self.resolution - 1) as f64 {
            (self.resolution - 1) as f64
        } else {
            c
        }) as usize
    }

    fn blend(&self, t: usize, x: f64, y: f64, z: f64) -> Option<f64> {
        let node = |v: usize| 3 * self.tets[4 * t + v];
        let p = |n: usize| [self.points[n], self.points[n + 1], self.points[n + 2]];
        let (a, b, c, d) = (node(0), node(1), node(2), node(3));
        let pa = p(a);
        let edge = |n: usize| {
            let q = p(n);
            [q[0] - pa[0], q[1] - pa[1], q[2] - pa[2]]
        };
        let (e1, e2, e3) = (edge(b), edge(c), edge(d));
        let q = [x - pa[0], y - pa[1], z - pa[2]];
        let det = dot(e1, cross(e2, e3));
        if det == 0.0 {
            return None;
        }
        let l1 = dot(q, cross(e2, e3)) / det;
        let l2 = dot(e1, cross(q, e3)) / det;
        let l3 = dot(e1, cross(e2, q)) / det;
        let l0 = 1.0 - l1 - l2 - l3;
        if !(l0 >= OUTSIDE_TOLERANCE && l1 >= OUTSIDE_TOLERANCE && l2 >= OUTSIDE_TOLERANCE && l3 >= OUTSIDE_TOLERANCE) {
            return None;
        }
        let v = |n: usize| self.values[n / 3];
        Some(jmin(jmax(l0 * v(a) + l1 * v(b) + l2 * v(c) + l3 * v(d), self.data_lo), self.data_hi))
    }

    fn nearest_node(&self, x: f64, y: f64, z: f64) -> f64 {
        let (mut best, mut best_d) = (0, f64::INFINITY);
        for (n, p) in self.points.chunks_exact(3).enumerate() {
            let (dx, dy, dz) = (x - p[0], y - p[1], z - p[2]);
            let d = dx * dx + dy * dy + dz * dz;
            if d < best_d {
                (best, best_d) = (n, d);
            }
        }
        self.values[best]
    }

    fn value(&self, x: f64, y: f64, z: f64) -> f64 {
        if !(x.is_finite() && y.is_finite() && z.is_finite()) {
            return f64::NAN;
        }
        let inside =
            x >= self.low[0] && x <= self.high[0] && y >= self.low[1] && y <= self.high[1] && z >= self.low[2] && z <= self.high[2];
        if inside {
            let r = self.resolution;
            let bucket = &self.buckets[self.cell_of(0, x) + r * (self.cell_of(1, y) + r * self.cell_of(2, z))];
            for &t in bucket {
                if let Some(hit) = self.blend(t, x, y, z) {
                    return hit;
                }
            }
        }
        self.nearest_node(x, y, z)
    }
}

impl Sampled {
    pub fn value(&self, x: f64, y: f64, z: f64) -> f64 {
        match self {
            Sampled::Grid(g) => g.value(x, y, z),
            Sampled::Tets(t) => t.value(x, y, z),
        }
    }

    /// Smallest and largest data value (the interval of every sample).
    pub fn range(&self) -> (f64, f64) {
        match self {
            Sampled::Grid(g) => (g.lo, g.hi),
            Sampled::Tets(t) => (t.data_lo, t.data_hi),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn linear(x: f64, y: f64, z: f64) -> f64 {
        1.0 + x + 2.0 * y + 3.0 * z
    }

    #[test]
    fn a_grid_reproduces_a_linear_field_between_voxel_centres_and_holds_its_edges_outside() {
        let mut values = Vec::new();
        for k in 0..2 {
            for j in 0..2 {
                for i in 0..3 {
                    values.push(linear((i as f64 + 0.5) * 0.5, (j as f64 + 0.5) * 0.5, (k as f64 + 0.5) * 0.5));
                }
            }
        }
        let grid = Sampled::Grid(Grid::new([3, 2, 2], [0.0; 3], 0.5, values.clone()));
        assert!((grid.value(0.9, 0.5, 0.6) - linear(0.9, 0.5, 0.6)).abs() < 1e-12);
        assert_eq!(grid.value(-9.0, -9.0, -9.0), values[0]);
        assert_eq!(grid.value(9.0, 9.0, 9.0), values[values.len() - 1]);
        assert!(grid.value(f64::NAN, 0.0, 0.0).is_nan());
        assert_eq!(grid.range(), (values[0], values[values.len() - 1]));
    }

    #[test]
    fn a_point_inside_the_face_tolerance_never_leaves_the_data_range() {
        let tets = Sampled::Tets(Tets::new(
            vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            vec![0, 1, 2, 3],
            vec![0.0, 1.0, 1.0, 1.0],
        ));
        assert_eq!(tets.value(0.4, 0.3, 0.3 + 5e-10), 1.0);
        assert_eq!(tets.range(), (0.0, 1.0));
    }

    #[test]
    fn tetrahedra_blend_inside_take_the_nearest_node_outside_and_the_lowest_tetrahedron_on_a_shared_face() {
        let points = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0];
        let values: Vec<f64> = points.chunks_exact(3).map(|p| linear(p[0], p[1], p[2])).collect();
        let mesh = Sampled::Tets(Tets::new(points, vec![0, 1, 2, 3, 4, 1, 2, 3], values.clone()));
        assert!((mesh.value(0.1, 0.2, 0.3) - linear(0.1, 0.2, 0.3)).abs() < 1e-12);
        assert!((mesh.value(0.7, 0.6, 0.5) - linear(0.7, 0.6, 0.5)).abs() < 1e-12);
        assert_eq!(mesh.value(5.0, 5.0, 5.0), values[4]);
        assert_eq!(mesh.value(-3.0, 0.0, 0.0), values[0]);
        assert!(mesh.value(0.0, f64::NAN, 0.0).is_nan());
    }
}

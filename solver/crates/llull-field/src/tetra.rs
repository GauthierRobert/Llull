//! Marching tetrahedra on a streamed node grid: twin of `packages/core/src/lib/isosurface/tetra.ts` (six Kuhn tetrahedra per cube, vertices on grid
//! edges by linear interpolation welded by the exact key `lo * nodes + hi`, numbered by first use, triangles oriented on grid-edge midpoints).
//! The grid arrives one z plane at a time, so the vertex map is the only state that grows with the surface; the output is the same mesh, vertex
//! for vertex and triangle for triangle, as the dense TypeScript mesher produces.

use crate::sampling::{Grid, PlaneStats};
use rayon::prelude::*;
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

/// Corner bit 0 = +x, 1 = +y, 2 = +z; each tetrahedron walks the cube diagonal 0 -> 7 through one axis permutation.
const KUHN: [[usize; 4]; 6] = [[0, 1, 3, 7], [0, 1, 5, 7], [0, 2, 3, 7], [0, 2, 6, 7], [0, 4, 5, 7], [0, 4, 6, 7]];

#[derive(Default)]
pub struct KeyHasher(u64);

/// Hasher builder of the exact edge / cell keys.
pub type KeyBuild = BuildHasherDefault<KeyHasher>;

impl Hasher for KeyHasher {
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 = (self.0 ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3);
        }
    }

    fn write_u64(&mut self, value: u64) {
        let mixed = value.wrapping_mul(0x9E37_79B9_7F4A_7C15);
        self.0 = mixed ^ (mixed >> 32);
    }

    fn finish(&self) -> u64 {
        self.0
    }
}

pub struct IsoMesh {
    pub positions: Vec<f64>,
    pub indices: Vec<u32>,
}

/// More triangles than the budget; carries the count reached when extraction stopped.
#[derive(Debug, PartialEq, Eq)]
pub struct TriangleBudget(pub u64);

#[derive(Clone, Copy)]
struct Corner {
    id: u64,
    p: [f64; 3],
    v: f64,
}

struct Builder<'a> {
    grid: &'a Grid,
    total: u64,
    vertex_of_edge: HashMap<u64, u32, BuildHasherDefault<KeyHasher>>,
    positions: Vec<f64>,
    indices: Vec<u32>,
}

impl Builder<'_> {
    fn vertex_on(&mut self, a: &Corner, b: &Corner) -> u32 {
        let (lo, hi) = if a.id < b.id { (a, b) } else { (b, a) };
        let key = lo.id * self.total + hi.id;
        if let Some(&known) = self.vertex_of_edge.get(&key) {
            return known;
        }
        let t = (0.0 - lo.v) / (hi.v - lo.v);
        let index = (self.positions.len() / 3) as u32;
        for axis in 0..3 {
            let p = lo.p[axis];
            self.positions.push(self.grid.min[axis] + (p + (hi.p[axis] - p) * t) * self.grid.voxel);
        }
        self.vertex_of_edge.insert(key, index);
        index
    }

    fn emit(&mut self, ea: (&Corner, &Corner), eb: (&Corner, &Corner), ec: (&Corner, &Corner), outward: [f64; 3]) {
        let (ia, ib, ic) = (self.vertex_on(ea.0, ea.1), self.vertex_on(eb.0, eb.1), self.vertex_on(ec.0, ec.1));
        if ia == ib || ib == ic || ia == ic {
            return;
        }
        let mid = |e: (&Corner, &Corner)| [0, 1, 2].map(|a| (e.0.p[a] + e.1.p[a]) / 2.0);
        let (pa, pb, pc) = (mid(ea), mid(eb), mid(ec));
        let (u0, u1, u2) = (pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]);
        let (v0, v1, v2) = (pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]);
        let facing = (u1 * v2 - u2 * v1) * outward[0] + (u2 * v0 - u0 * v2) * outward[1] + (u0 * v1 - u1 * v0) * outward[2];
        if facing >= 0.0 {
            self.indices.extend([ia, ib, ic]);
        } else {
            self.indices.extend([ia, ic, ib]);
        }
    }

    fn tetrahedron(&mut self, corners: &[Corner; 8], inside: &[bool; 8], tetra: &[usize; 4]) {
        let in_ids: Vec<usize> = tetra.iter().copied().filter(|&c| inside[c]).collect();
        let out_ids: Vec<usize> = tetra.iter().copied().filter(|&c| !inside[c]).collect();
        if in_ids.is_empty() || out_ids.is_empty() {
            return;
        }
        let centroid = |ids: &[usize]| [0, 1, 2].map(|a| ids.iter().fold(0.0, |sum, &c| sum + corners[c].p[a]) / ids.len() as f64);
        let (ci, co) = (centroid(&in_ids), centroid(&out_ids));
        let voxel = self.grid.voxel;
        let outward = [(co[0] - ci[0]) * voxel, (co[1] - ci[1]) * voxel, (co[2] - ci[2]) * voxel];
        let c = |i: usize| &corners[i];
        if in_ids.len() == 2 {
            let (a, b, cc, d) = (c(in_ids[0]), c(in_ids[1]), c(out_ids[0]), c(out_ids[1]));
            self.emit((a, cc), (a, d), (b, d), outward);
            self.emit((a, cc), (b, d), (b, cc), outward);
        } else {
            let (apex, ring) = if in_ids.len() == 1 { (in_ids[0], &out_ids) } else { (out_ids[0], &in_ids) };
            self.emit((c(apex), c(ring[0])), (c(apex), c(ring[1])), (c(apex), c(ring[2])), outward);
        }
    }
}

/// The closed, oriented iso-surface at 0 (material where value < 0). `planes(k, out)` fills the node values of plane k; `progress(layer, layers)`
/// is called before each cell layer. `Err` when the surface needs more than `max_triangles`.
pub fn extract(
    grid: &Grid,
    max_triangles: u64,
    planes: &mut dyn FnMut(usize, &mut [f64]) -> PlaneStats,
    progress: &mut dyn FnMut(usize, usize),
) -> Result<(IsoMesh, PlaneStats), TriangleBudget> {
    let [sx, sy, sz] = grid.nodes();
    let slab = sx * sy;
    let mut builder = Builder {
        grid,
        total: grid.node_count(),
        vertex_of_edge: HashMap::with_hasher(BuildHasherDefault::default()),
        positions: Vec::new(),
        indices: Vec::new(),
    };
    let mut current = vec![0.0; slab];
    let mut next = vec![0.0; slab];
    let mut stats = planes(0, &mut current);
    for k in 0..sz - 1 {
        progress(k, sz - 1);
        stats = stats.add(planes(k + 1, &mut next));
        for j in 0..sy - 1 {
            for i in 0..sx - 1 {
                let mut values = [0.0; 8];
                let mut inside = [false; 8];
                let mut count = 0;
                for c in 0..8 {
                    let plane = if c >> 2 & 1 == 0 { &current } else { &next };
                    values[c] = plane[(i + (c & 1)) + sx * (j + (c >> 1 & 1))];
                    inside[c] = values[c] < 0.0;
                    count += usize::from(inside[c]);
                }
                if count == 0 || count == 8 {
                    continue;
                }
                let corners: [Corner; 8] = std::array::from_fn(|c| {
                    let p = [(i + (c & 1)) as f64, (j + (c >> 1 & 1)) as f64, (k + (c >> 2 & 1)) as f64];
                    let id = (i + (c & 1)) as u64 + sx as u64 * (j + (c >> 1 & 1)) as u64 + slab as u64 * (k + (c >> 2 & 1)) as u64;
                    Corner { id, p, v: values[c] }
                });
                for tetra in &KUHN {
                    builder.tetrahedron(&corners, &inside, tetra);
                }
            }
        }
        let triangles = builder.indices.len() as u64 / 3;
        if triangles > max_triangles {
            return Err(TriangleBudget(triangles));
        }
        std::mem::swap(&mut current, &mut next);
    }
    Ok((IsoMesh { positions: builder.positions, indices: builder.indices }, stats))
}

/// Every directed edge occurs exactly once and so does its reverse.
pub fn is_closed_manifold(vertices: usize, indices: &[u32]) -> bool {
    if !indices.len().is_multiple_of(3) {
        return false;
    }
    let v = vertices as u64;
    let mut keys: Vec<u64> = Vec::with_capacity(indices.len());
    for triangle in indices.chunks_exact(3) {
        for e in 0..3 {
            keys.push(u64::from(triangle[e]) * v + u64::from(triangle[(e + 1) % 3]));
        }
    }
    keys.par_sort_unstable();
    if keys.windows(2).any(|w| w[0] == w[1]) {
        return false;
    }
    keys.par_iter().all(|&key| keys.binary_search(&((key % v) * v + key / v)).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sphere_planes(grid: &Grid, radius: f64) -> impl FnMut(usize, &mut [f64]) -> PlaneStats + '_ {
        move |k, out| {
            let nodes = grid.nodes();
            for (id, slot) in out.iter_mut().enumerate() {
                let (i, j) = (id % nodes[0], id / nodes[0]);
                let p = [0, 1, 2].map(|a| grid.min[a] + [i, j, k][a] as f64 * grid.voxel);
                let value = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt() - radius;
                *slot = if value.abs() < 1e-3 * grid.voxel { 1e-3 * grid.voxel } else { value };
            }
            PlaneStats { evaluated: out.len() as u64, non_finite: 0 }
        }
    }

    #[test]
    fn a_sphere_is_a_closed_manifold_with_the_expected_volume() {
        let grid = Grid::new([-6.0; 3], [6.0; 3], 0.5).unwrap();
        let mut planes = sphere_planes(&grid, 4.0);
        let (mesh, stats) = extract(&grid, u64::MAX, &mut planes, &mut |_, _| {}).unwrap();
        assert_eq!(stats.evaluated, grid.node_count());
        assert!(is_closed_manifold(mesh.positions.len() / 3, &mesh.indices));
        let mut volume = 0.0;
        for t in mesh.indices.chunks_exact(3) {
            let p = |i: u32| [0, 1, 2].map(|a| mesh.positions[i as usize * 3 + a]);
            let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
            volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0;
        }
        let exact = 4.0 / 3.0 * std::f64::consts::PI * 64.0;
        assert!(((volume - exact) / exact).abs() < 0.01, "mesh volume {volume} vs {exact}");
    }

    #[test]
    fn the_triangle_budget_stops_extraction() {
        let grid = Grid::new([-6.0; 3], [6.0; 3], 0.5).unwrap();
        let mut planes = sphere_planes(&grid, 4.0);
        let Err(TriangleBudget(reached)) = extract(&grid, 100, &mut planes, &mut |_, _| {}) else { panic!("expected a refusal") };
        assert!(reached > 100);
    }

    #[test]
    fn open_and_ragged_meshes_are_not_closed() {
        assert!(!is_closed_manifold(3, &[0, 1, 2]), "a single triangle has no reverse edges");
        assert!(!is_closed_manifold(3, &[0, 1]));
        assert!(!is_closed_manifold(4, &[0, 1, 2, 0, 1, 2]), "duplicate directed edges");
        assert!(is_closed_manifold(4, &[0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3]), "a tetrahedron");
    }
}

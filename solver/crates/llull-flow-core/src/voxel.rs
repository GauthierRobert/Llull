//! Parity ray casting of a closed surface along +x, one ray per cell row (TECHNICAL_SPEC §5.2): a cell is solid when its centre
//! lies between an odd number of crossings. Row centres are shifted by a fixed fraction of a cell so no ray runs exactly along a
//! triangle edge of axis-aligned geometry (the same shifts as the TypeScript `voxel.ts` of `prepare_cfd_case`). Each solid cell
//! is attributed to the body of the triangle the ray entered through, so forces can be summed per body.
//!
//! Deterministic: crossings are collected per row in triangle order (sequential), then every row is classified independently
//! (parallel; a row owns one contiguous run of cells), so the result does not depend on the thread count.

use crate::grid::Grid;
use crate::stl::Triangle;
use rayon::prelude::*;

const SHIFT_Y: f64 = 0.000123;
const SHIFT_Z: f64 = 0.000071;

/// Body id of a fluid cell.
pub const NO_BODY: u16 = u16::MAX;

/// Solid / fluid classification of a grid with per-cell body attribution.
#[derive(Debug, Clone, PartialEq)]
pub struct Voxelisation {
    pub solid: Vec<bool>,
    /// Body index per cell ([`NO_BODY`] for fluid cells).
    pub body: Vec<u16>,
    pub solid_cells: usize,
    /// Rows with an odd number of crossings (an open or non-manifold surface): left fluid, counted here.
    pub odd_rows: usize,
}

/// Crossings `(x, triangle)` of the row rays, in triangle order.
fn crossings(grid: &Grid, triangles: &[Triangle]) -> Vec<Vec<(f64, u32)>> {
    let rows = grid.ny * grid.nz;
    let mut per_row: Vec<Vec<(f64, u32)>> = vec![Vec::new(); rows];
    let h = grid.h;
    let [_, oy, oz] = grid.origin;
    for (t, triangle) in triangles.iter().enumerate() {
        let [a, b, c] = triangle.v;
        let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let nx = u[1] * w[2] - u[2] * w[1];
        let ny = u[2] * w[0] - u[0] * w[2];
        let nz = u[0] * w[1] - u[1] * w[0];
        if nx.abs() <= 1e-14 * (nx * nx + ny * ny + nz * nz).sqrt() {
            continue;
        }
        let range = |axis: usize, origin: f64, n: usize, shift: f64| {
            let low = a[axis].min(b[axis]).min(c[axis]);
            let high = a[axis].max(b[axis]).max(c[axis]);
            let first = ((low - origin) / h - 0.5 - shift).ceil().max(0.0) as usize;
            let last = ((high - origin) / h - 0.5 - shift).floor().min(n as f64 - 1.0);
            (first, last)
        };
        let (j0, j1) = range(1, oy, grid.ny, SHIFT_Y);
        let (k0, k1) = range(2, oz, grid.nz, SHIFT_Z);
        if j1 < 0.0 || k1 < 0.0 {
            continue;
        }
        for j in j0..=(j1 as usize) {
            let py = oy + (j as f64 + 0.5 + SHIFT_Y) * h;
            for k in k0..=(k1 as usize) {
                let pz = oz + (k as f64 + 0.5 + SHIFT_Z) * h;
                let qy = py - a[1];
                let qz = pz - a[2];
                let s = (qy * w[2] - qz * w[1]) / nx;
                let r = (u[1] * qz - u[2] * qy) / nx;
                if s < 0.0 || r < 0.0 || s + r > 1.0 {
                    continue;
                }
                let x = a[0] - (ny * qy + nz * qz) / nx;
                per_row[j + grid.ny * k].push((x, t as u32));
            }
        }
    }
    per_row
}

/// Classifies every cell of `grid`; `body_of_triangle[t]` names the body of triangle `t` (same length as `triangles`).
/// @invariant identical output for any rayon thread count
pub fn voxelise(grid: &Grid, triangles: &[Triangle], body_of_triangle: &[u16]) -> Voxelisation {
    assert_eq!(triangles.len(), body_of_triangle.len(), "one body id per triangle");
    let rows = crossings(grid, triangles);
    let mut solid = vec![false; grid.cells()];
    let mut body = vec![NO_BODY; grid.cells()];
    let h = grid.h;
    let ox = grid.origin[0];
    let nx = grid.nx;
    let counts: Vec<(usize, usize)> = solid
        .par_chunks_mut(nx)
        .zip(body.par_chunks_mut(nx))
        .zip(rows.par_iter())
        .map(|((solid_row, body_row), hits)| {
            if hits.len() % 2 != 0 {
                return (0, 1);
            }
            let mut sorted = hits.clone();
            sorted.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
            let mut filled = 0;
            for pair in sorted.chunks_exact(2) {
                let (enter, leave) = (pair[0], pair[1]);
                let first = ((enter.0 - ox) / h - 0.5).ceil().max(0.0) as usize;
                let last = (((leave.0 - ox) / h - 0.5).ceil().max(0.0) as usize).min(nx);
                let owner = body_of_triangle[enter.1 as usize];
                for i in first..last {
                    if !solid_row[i] {
                        filled += 1;
                    }
                    solid_row[i] = true;
                    body_row[i] = owner;
                }
            }
            (filled, 0)
        })
        .collect();
    let solid_cells = counts.iter().map(|c| c.0).sum();
    let odd_rows = counts.iter().map(|c| c.1).sum();
    Voxelisation { solid, body, solid_cells, odd_rows }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stl::{box_triangles, sphere_triangles};

    #[test]
    fn a_box_fills_exactly_its_cells() {
        let grid = Grid::covering([0.0; 3], [4.0, 4.0, 4.0], 1.0);
        let triangles = box_triangles([1.0, 1.0, 1.0], [3.0, 3.0, 3.0]);
        let voxels = voxelise(&grid, &triangles, &[0; 12]);
        assert_eq!(voxels.solid_cells, 8);
        assert_eq!(voxels.odd_rows, 0);
        assert!(voxels.solid[grid.index(1, 1, 1)] && voxels.solid[grid.index(2, 2, 2)]);
        assert!(!voxels.solid[grid.index(0, 1, 1)] && !voxels.solid[grid.index(3, 1, 1)]);
        assert_eq!(voxels.body[grid.index(1, 1, 1)], 0);
        assert_eq!(voxels.body[grid.index(0, 0, 0)], NO_BODY);
    }

    #[test]
    fn sphere_volume_error_stays_inside_the_bound_and_falls_with_h() {
        // VC-CFD-10: the voxel volume error is bounded by A (√3/2) h.
        let exact = 4.0 / 3.0 * std::f64::consts::PI;
        let area = 4.0 * std::f64::consts::PI;
        let mut errors = Vec::new();
        for cells_per_radius in [8usize, 16, 32] {
            let h = 1.0 / cells_per_radius as f64;
            let grid = Grid::covering([-1.5; 3], [1.5; 3], h);
            let triangles = sphere_triangles([0.0; 3], 1.0, 64, 128);
            let voxels = voxelise(&grid, &triangles, &vec![0; triangles.len()]);
            let volume = voxels.solid_cells as f64 * h * h * h;
            let error = (volume - exact).abs();
            assert!(error <= area * (3f64.sqrt() / 2.0) * h, "h {h}: error {error}");
            assert_eq!(voxels.odd_rows, 0);
            errors.push(error);
        }
        assert!(errors[2] < errors[0], "{errors:?}");
    }

    #[test]
    fn two_bodies_are_attributed_separately_and_the_result_is_thread_independent() {
        let grid = Grid::covering([0.0; 3], [8.0, 4.0, 4.0], 1.0);
        let mut triangles = box_triangles([1.0, 1.0, 1.0], [3.0, 3.0, 3.0]);
        triangles.extend(box_triangles([5.0, 1.0, 1.0], [7.0, 3.0, 3.0]));
        let bodies: Vec<u16> = (0..24).map(|t| if t < 12 { 0 } else { 1 }).collect();
        let run = |threads: usize| {
            rayon::ThreadPoolBuilder::new().num_threads(threads).build().unwrap().install(|| voxelise(&grid, &triangles, &bodies))
        };
        let one = run(1);
        assert_eq!(one.solid_cells, 16);
        assert_eq!(one.body[grid.index(1, 1, 1)], 0);
        assert_eq!(one.body[grid.index(6, 2, 2)], 1);
        assert_eq!(run(3), one);
    }

    #[test]
    fn an_open_surface_counts_odd_rows_and_fills_nothing() {
        let grid = Grid::covering([0.0; 3], [4.0; 3], 1.0);
        // Without its -x face every row through the box sees one crossing (the +x face).
        let all = box_triangles([1.0; 3], [3.0; 3]);
        let triangles: Vec<_> = all.iter().enumerate().filter(|(t, _)| *t != 8 && *t != 9).map(|(_, t)| *t).collect();
        let voxels = voxelise(&grid, &triangles, &vec![0; triangles.len()]);
        assert!(voxels.odd_rows > 0);
        assert_eq!(voxels.solid_cells, 0);
    }
}

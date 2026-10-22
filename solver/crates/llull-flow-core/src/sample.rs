//! Sampling of cell-centred fields: trilinear interpolation between the eight surrounding cell centres (invalid — solid — cells
//! drop out and the weights are renormalised), probes at points, and surface values taken a little outside each triangle along
//! its outward normal (TECHNICAL_SPEC §5.3 "surface fields interpolated from the nearest fluid cells along the normal").

use crate::grid::Grid;
use crate::stl::Triangle;
use rayon::prelude::*;

/// Value of `field` at `point` by trilinear interpolation over valid cells; None outside the grid or with no valid cell around.
/// @invariant exact for a linear field where every surrounding cell is valid
pub fn trilinear(grid: &Grid, field: &[f32], valid: &[bool], point: [f64; 3]) -> Option<f64> {
    let local = |axis: usize| (point[axis] - grid.origin[axis]) / grid.h - 0.5;
    let (tx, ty, tz) = (local(0), local(1), local(2));
    let n = [grid.nx, grid.ny, grid.nz];
    let t = [tx, ty, tz];
    if (0..3).any(|axis| t[axis] < -0.5 || t[axis] > n[axis] as f64 - 0.5) {
        return None;
    }
    let base = |axis: usize| t[axis].floor().clamp(0.0, (n[axis] as f64 - 2.0).max(0.0)) as usize;
    let (i0, j0, k0) = (base(0), base(1), base(2));
    let frac = |axis: usize, i: usize| (t[axis] - i as f64).clamp(0.0, 1.0);
    let (fx, fy, fz) = (frac(0, i0), frac(1, j0), frac(2, k0));
    let mut weight_sum = 0.0;
    let mut value_sum = 0.0;
    for dk in 0..2usize {
        for dj in 0..2usize {
            for di in 0..2usize {
                let (i, j, k) = ((i0 + di).min(n[0] - 1), (j0 + dj).min(n[1] - 1), (k0 + dk).min(n[2] - 1));
                let cell = grid.index(i, j, k);
                if !valid[cell] {
                    continue;
                }
                let weight =
                    (if di == 0 { 1.0 - fx } else { fx }) * (if dj == 0 { 1.0 - fy } else { fy }) * (if dk == 0 { 1.0 - fz } else { fz });
                weight_sum += weight;
                value_sum += weight * f64::from(field[cell]);
            }
        }
    }
    (weight_sum > 1e-12).then(|| value_sum / weight_sum)
}

/// Field value on every triangle: sampled at the centroid pushed `0.5 h, 1 h, …, 3 h` along the outward normal, the first
/// sample that finds fluid; NaN when none does (a triangle buried inside the solid).
pub fn surface_values(grid: &Grid, triangles: &[Triangle], field: &[f32], valid: &[bool]) -> Vec<f32> {
    triangles
        .par_iter()
        .map(|triangle| {
            let c = triangle.centroid();
            let n = triangle.unit_normal();
            [0.5, 1.0, 1.5, 2.0, 3.0]
                .iter()
                .find_map(|k| {
                    let p = [c[0] + n[0] * k * grid.h, c[1] + n[1] * k * grid.h, c[2] + n[2] * k * grid.h];
                    trilinear(grid, field, valid, p)
                })
                .map_or(f32::NAN, |value| value as f32)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stl::box_triangles;
    use crate::voxel::voxelise;

    fn linear_field(grid: &Grid) -> Vec<f32> {
        (0..grid.cells())
            .map(|cell| {
                let (i, j, k) = grid.coords(cell);
                let c = grid.centre(i, j, k);
                (2.0 * c[0] - c[1] + 0.5 * c[2]) as f32
            })
            .collect()
    }

    #[test]
    fn trilinear_is_exact_for_a_linear_field_and_none_outside() {
        let grid = Grid::covering([0.0; 3], [1.0; 3], 0.125);
        let field = linear_field(&grid);
        let valid = vec![true; grid.cells()];
        let p = [0.37, 0.61, 0.52];
        let value = trilinear(&grid, &field, &valid, p).unwrap();
        assert!((value - (2.0 * p[0] - p[1] + 0.5 * p[2])).abs() < 1e-6, "{value}");
        assert_eq!(trilinear(&grid, &field, &valid, [1.2, 0.5, 0.5]), None);
        assert_eq!(trilinear(&grid, &field, &vec![false; grid.cells()], p), None);
    }

    #[test]
    fn surface_values_of_a_linear_field_err_by_at_most_two_cells_times_the_gradient() {
        // VC-CFD-41: p = x on the faces of a box inside the grid.
        let grid = Grid::covering([0.0; 3], [2.0; 3], 0.1);
        let triangles = box_triangles([0.5; 3], [1.5; 3]);
        let voxels = voxelise(&grid, &triangles, &[0; 12]);
        let field: Vec<f32> = (0..grid.cells())
            .map(|cell| {
                let (i, j, k) = grid.coords(cell);
                grid.centre(i, j, k)[0] as f32
            })
            .collect();
        let valid: Vec<bool> = voxels.solid.iter().map(|s| !s).collect();
        let values = surface_values(&grid, &triangles, &field, &valid);
        for (triangle, value) in triangles.iter().zip(&values) {
            let expected = triangle.centroid()[0];
            assert!(value.is_finite());
            assert!((f64::from(*value) - expected).abs() <= 2.0 * grid.h + 1e-9, "{value} vs {expected}");
        }
    }
}

//! Sensitivity and density filters of TECHNICAL_SPEC §5.2 as a fixed-stencil convolution (no assembled H).
//!
//! `H_ei = max(0, rmin − ‖c_e − c_i‖)` over the active voxels `i` within the stencil half-width `ceil(rmin) − 1` (voxels
//! further away have zero weight), `Hs_e = Σ_i H_ei`. Each output sums its stencil in a fixed (z, y, x) order, so the result
//! is independent of the thread count. Inactive voxels neither contribute nor receive (their outputs are 0).

use llull_voxfe::Grid;
use llull_voxfe::MIN_LEN;
use rayon::prelude::*;

/// Filter kind (top88 `ft` = 1 / 2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilterKind {
    Sensitivity,
    Density,
}

/// The stencil weights of one grid, active mask and radius (`rmin` in voxels).
pub struct Filter {
    grid: Grid,
    active: Vec<bool>,
    stencil: Vec<([isize; 3], f64)>,
    hs: Vec<f64>,
}

impl Filter {
    pub fn new(grid: Grid, active: &[bool], rmin: f64) -> Filter {
        assert!(rmin > 0.0, "filter radius must be positive");
        let reach = (rmin.ceil() as isize - 1).max(0);
        let z_reach = if grid.dim == 3 { reach } else { 0 };
        let mut stencil = Vec::new();
        for dz in -z_reach..=z_reach {
            for dy in -reach..=reach {
                for dx in -reach..=reach {
                    let w = rmin - ((dx * dx + dy * dy + dz * dz) as f64).sqrt();
                    if w > 0.0 {
                        stencil.push(([dx, dy, dz], w));
                    }
                }
            }
        }
        let mut filter = Filter { grid, active: active.to_vec(), stencil, hs: Vec::new() };
        let ones: Vec<f64> = active.iter().map(|&a| if a { 1.0 } else { 0.0 }).collect();
        filter.hs = filter.convolve(&ones);
        filter
    }

    /// `Hs_e` (0 for inactive voxels).
    pub fn hs(&self) -> &[f64] {
        &self.hs
    }

    /// The stencil offsets and weights, in summation order.
    pub fn stencil(&self) -> &[([isize; 3], f64)] {
        &self.stencil
    }

    /// `out_e = Σ_i H_ei v_i` over active `i`, for active `e` (0 elsewhere).
    pub fn convolve(&self, values: &[f64]) -> Vec<f64> {
        let g = self.grid;
        (0..g.elements())
            .into_par_iter()
            .with_min_len(MIN_LEN)
            .map(|e| {
                if !self.active[e] {
                    return 0.0;
                }
                let [i, j, k] = g.element_ijk(e).map(|v| v as isize);
                let mut sum = 0.0;
                for &([dx, dy, dz], w) in &self.stencil {
                    let (a, b, c) = (i + dx, j + dy, k + dz);
                    if a < 0 || b < 0 || c < 0 || a >= g.nx as isize || b >= g.ny as isize || c >= g.nz as isize {
                        continue;
                    }
                    let other = g.element(a as usize, b as usize, c as usize);
                    if self.active[other] {
                        sum += w * values[other];
                    }
                }
                sum
            })
            .collect()
    }

    /// Sensitivity filter: `dc_e ← Σ_i H_ei x_i dc_i / (Hs_e · max(1e-3, x_e))`.
    pub fn sensitivity(&self, x: &[f64], dc: &[f64]) -> Vec<f64> {
        let weighted: Vec<f64> = x.iter().zip(dc).map(|(x, dc)| x * dc).collect();
        let sums = self.convolve(&weighted);
        sums.iter().zip(&self.hs).zip(x).map(|((s, hs), x)| if *hs > 0.0 { s / hs / x.max(1e-3) } else { 0.0 }).collect()
    }

    /// Density filter: `xPhys_e = Σ_i H_ei x_i / Hs_e`.
    pub fn density(&self, x: &[f64]) -> Vec<f64> {
        self.convolve(x).iter().zip(&self.hs).map(|(s, hs)| if *hs > 0.0 { s / hs } else { 0.0 }).collect()
    }

    /// Chain rule of the density filter: `d_e ← Σ_i H_ei d_i / Hs_i`.
    pub fn density_adjoint(&self, d: &[f64]) -> Vec<f64> {
        let scaled: Vec<f64> = d.iter().zip(&self.hs).map(|(d, hs)| if *hs > 0.0 { d / hs } else { 0.0 }).collect();
        self.convolve(&scaled)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weights_match_vc_top_02() {
        let grid = Grid::new_2d(5, 5);
        let filter = Filter::new(grid, &[true; 25], 1.5);
        let weight = |dx: isize, dy: isize| filter.stencil().iter().find(|(o, _)| *o == [dx, dy, 0]).map(|(_, w)| *w).unwrap();
        assert_eq!(weight(0, 0), 1.5);
        assert_eq!(weight(1, 0), 0.5);
        assert!((weight(1, 1) - 0.0857864376269).abs() < 1e-13);
        assert!((filter.hs()[12] - 3.84314575051).abs() / 3.84314575051 < 1e-11);
        assert!((filter.hs()[12] - (1.5 + 4.0 * 0.5 + 4.0 * (1.5 - 2f64.sqrt()))).abs() < 1e-15);
        assert_eq!(filter.stencil().len(), 9);
    }

    #[test]
    fn density_filter_keeps_a_uniform_field_and_its_adjoint_is_the_transpose() {
        let grid = Grid::new_3d(5, 4, 3);
        let active: Vec<bool> = (0..grid.elements()).map(|e| e % 5 != 2).collect();
        let filter = Filter::new(grid, &active, 2.2);
        let uniform: Vec<f64> = active.iter().map(|&a| if a { 0.4 } else { 0.0 }).collect();
        for (value, &a) in filter.density(&uniform).iter().zip(&active) {
            assert!(if a { (value - 0.4).abs() < 1e-15 } else { *value == 0.0 });
        }
        let x: Vec<f64> = (0..grid.elements()).map(|e| if active[e] { ((e * 7) % 11) as f64 / 11.0 } else { 0.0 }).collect();
        let y: Vec<f64> = (0..grid.elements()).map(|e| if active[e] { ((e * 3) % 5) as f64 - 2.0 } else { 0.0 }).collect();
        let left: f64 = filter.density(&x).iter().zip(&y).map(|(a, b)| a * b).sum();
        let right: f64 = x.iter().zip(&filter.density_adjoint(&y)).map(|(a, b)| a * b).sum();
        assert!((left - right).abs() < 1e-12);
    }
}

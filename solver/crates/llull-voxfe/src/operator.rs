//! Matrix-free stiffness operator `K = Σ_e s_e · KE` on a voxel grid (f64 CPU twin, rayon).
//!
//! - `s_e` is the per-element stiffness scale (E_e · t in 2D, E_e · h in 3D); `s_e = 0` marks an inactive voxel, removed
//!   from the system (TECHNICAL_SPEC §5.4: not modelled as Emin).
//! - Dirichlet DOFs (`fixed`) and DOFs of nodes touched by no active element are not free: the operator returns 0 there,
//!   and the solvers keep every vector at 0 there, so it acts as the reduced system on the free DOFs.
//! - The product runs in two passes: every element computes `s_e · KE u_e` once (parallel over elements, terms in element-DOF
//!   order), then every node gathers the rows of its (up to 4 / 8) elements in local-node order. No scatter, no atomics, so
//!   the bits do not depend on the thread count (the GPU shader computes the same sums in the same order, node by node).

use crate::grid::{Grid, LOCAL_NODES};
use crate::MIN_LEN;
use rayon::prelude::*;
use std::sync::Mutex;

/// The stiffness operator of one grid, element matrix and set of element scales.
#[derive(Debug)]
pub struct Operator {
    grid: Grid,
    ke: Vec<f64>,
    scale: Vec<f64>,
    fixed: Vec<bool>,
    free: Vec<bool>,
    /// Per-element products of the first pass, reused between calls.
    scratch: Mutex<Vec<f64>>,
}

impl Clone for Operator {
    fn clone(&self) -> Operator {
        Operator {
            grid: self.grid,
            ke: self.ke.clone(),
            scale: self.scale.clone(),
            fixed: self.fixed.clone(),
            free: self.free.clone(),
            scratch: Mutex::new(Vec::new()),
        }
    }
}

impl Operator {
    /// `ke`: unit element matrix (`element_dofs²`, row-major); `scale`: one per element (0 = inactive); `fixed`: one per DOF.
    pub fn new(grid: Grid, ke: Vec<f64>, scale: Vec<f64>, fixed: Vec<bool>) -> Operator {
        assert_eq!(ke.len(), grid.element_dofs() * grid.element_dofs(), "element matrix size");
        assert_eq!(scale.len(), grid.elements(), "one scale per element");
        assert_eq!(fixed.len(), grid.dofs(), "one fixed flag per DOF");
        let mut operator = Operator { grid, ke, scale, fixed, free: Vec::new(), scratch: Mutex::new(Vec::new()) };
        operator.free = operator.free_dofs();
        operator
    }

    fn free_dofs(&self) -> Vec<bool> {
        let g = &self.grid;
        let mut present = vec![false; g.nodes()];
        for (e, &s) in self.scale.iter().enumerate() {
            if s != 0.0 {
                for &n in &g.element_nodes(e)[..g.nodes_per_element()] {
                    present[n] = true;
                }
            }
        }
        (0..g.dofs()).map(|d| present[d / g.dim] && !self.fixed[d]).collect()
    }

    pub fn grid(&self) -> &Grid {
        &self.grid
    }

    pub fn ke(&self) -> &[f64] {
        &self.ke
    }

    pub fn scale(&self) -> &[f64] {
        &self.scale
    }

    pub fn fixed(&self) -> &[bool] {
        &self.fixed
    }

    pub fn free(&self) -> &[bool] {
        &self.free
    }

    /// Replaces the element scales; an element may not switch between active and inactive (the free DOFs stay valid).
    pub fn set_scale(&mut self, scale: Vec<f64>) {
        assert_eq!(scale.len(), self.scale.len(), "one scale per element");
        debug_assert!(scale.iter().zip(&self.scale).all(|(a, b)| (*a == 0.0) == (*b == 0.0)), "activity changed");
        self.scale = scale;
    }

    /// Zeroes `v` at every non-free DOF.
    pub fn mask(&self, v: &mut [f64]) {
        v.par_iter_mut().with_min_len(MIN_LEN).zip(&self.free).for_each(|(value, &free)| {
            if !free {
                *value = 0.0;
            }
        });
    }

    /// `y = K u` on the free DOFs, 0 elsewhere (`u` is used as given, including non-free entries).
    pub fn apply(&self, u: &[f64], y: &mut [f64]) {
        let g = &self.grid;
        assert!(u.len() == g.dofs() && y.len() == g.dofs(), "vector length");
        if g.dim == 3 {
            self.apply_fixed::<3, 8, 24>(u, y);
        } else {
            self.apply_fixed::<2, 4, 8>(u, y);
        }
    }

    /// [`Operator::apply`] for `D` DOFs per node, `NPE` nodes and `ND = NPE·D` DOFs per element (unrolled by the compiler).
    fn apply_fixed<const D: usize, const NPE: usize, const ND: usize>(&self, u: &[f64], y: &mut [f64]) {
        let g = &self.grid;
        let [nnx, nny, _] = g.node_dims();
        let offsets = g.local_offsets();
        let ke: Vec<[f64; ND]> = self.ke.chunks_exact(ND).map(|row| row.try_into().unwrap_or([0.0; ND])).collect();
        let mut guard = self.scratch.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let products = &mut *guard;
        products.resize(g.elements() * ND, 0.0);
        products.par_chunks_mut(ND).enumerate().with_min_len(MIN_LEN / 8).for_each(|(e, out)| {
            let s = self.scale[e];
            if s == 0.0 {
                return;
            }
            let [i, j, k] = g.element_ijk(e);
            let origin = g.node(i, j, k);
            let mut ue = [0.0f64; ND];
            for b in 0..NPE {
                let node = (origin + offsets[b]) * D;
                ue[b * D..b * D + D].copy_from_slice(&u[node..node + D]);
            }
            for (row, value) in ke.iter().zip(out.iter_mut()) {
                let mut sum = 0.0;
                for t in 0..ND {
                    sum += row[t] * ue[t];
                }
                *value = s * sum;
            }
        });
        let products = &*products;
        y.par_chunks_mut(D).enumerate().with_min_len(MIN_LEN / 4).for_each(|(n, out)| {
            let (i, j, k) = (n % nnx, (n / nnx) % nny, n / (nnx * nny));
            let mut acc = [0.0f64; D];
            for a in 0..NPE {
                let [ox, oy, oz] = LOCAL_NODES[a];
                if i < ox || j < oy || k < oz || i - ox >= g.nx || j - oy >= g.ny || k - oz >= g.nz {
                    continue;
                }
                let e = g.element(i - ox, j - oy, k - oz);
                if self.scale[e] == 0.0 {
                    continue;
                }
                let rows = &products[e * ND + a * D..e * ND + a * D + D];
                for c in 0..D {
                    acc[c] += rows[c];
                }
            }
            for c in 0..D {
                out[c] = if self.free[n * D + c] { acc[c] } else { 0.0 };
            }
        });
    }

    /// Diagonal of K on the free DOFs (0 elsewhere), summed per node in the same fixed order as [`Operator::apply`].
    pub fn diagonal(&self) -> Vec<f64> {
        let g = &self.grid;
        let [nnx, nny, _] = g.node_dims();
        let (dim, npe) = (g.dim, g.nodes_per_element());
        let nd = npe * dim;
        let mut diagonal = vec![0.0; g.dofs()];
        diagonal.par_chunks_mut(dim).enumerate().with_min_len(MIN_LEN / 4).for_each(|(n, out)| {
            let (i, j, k) = (n % nnx, (n / nnx) % nny, n / (nnx * nny));
            for (a, [ox, oy, oz]) in LOCAL_NODES.iter().enumerate().take(npe) {
                if i < *ox || j < *oy || k < *oz || i - ox >= g.nx || j - oy >= g.ny || k - oz >= g.nz {
                    continue;
                }
                let s = self.scale[g.element(i - ox, j - oy, k - oz)];
                for (c, value) in out.iter_mut().enumerate() {
                    let r = a * dim + c;
                    *value += s * self.ke[r * nd + r];
                }
            }
            for (c, value) in out.iter_mut().enumerate() {
                if !self.free[n * dim + c] {
                    *value = 0.0;
                }
            }
        });
        diagonal
    }

    /// Unscaled element energies `u_eᵀ KE u_e` (0 for inactive elements), each in a fixed order.
    pub fn element_energies(&self, u: &[f64]) -> Vec<f64> {
        let g = &self.grid;
        let (dim, npe) = (g.dim, g.nodes_per_element());
        let nd = npe * dim;
        (0..g.elements())
            .into_par_iter()
            .with_min_len(MIN_LEN)
            .map(|e| {
                if self.scale[e] == 0.0 {
                    return 0.0;
                }
                let nodes = g.element_nodes(e);
                let mut ue = [0.0f64; 24];
                for b in 0..npe {
                    for q in 0..dim {
                        ue[b * dim + q] = u[nodes[b] * dim + q];
                    }
                }
                let mut energy = 0.0;
                for r in 0..nd {
                    let row = &self.ke[r * nd..(r + 1) * nd];
                    energy += ue[r] * row.iter().zip(&ue[..nd]).fold(0.0, |acc, (k, v)| acc + k * v);
                }
                energy
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ke::element_matrix;

    fn operator(grid: Grid) -> Operator {
        let scale: Vec<f64> = (0..grid.elements()).map(|e| 1.0 + (e % 3) as f64 * 0.5).collect();
        Operator::new(grid, element_matrix(grid.dim, 0.3), scale, vec![false; grid.dofs()])
    }

    #[test]
    fn gather_equals_the_assembled_element_by_element_product() {
        for grid in [Grid::new_2d(4, 3), Grid::new_3d(3, 2, 2)] {
            let op = operator(grid);
            let u: Vec<f64> = (0..grid.dofs()).map(|d| ((d * 31) % 17) as f64 / 17.0 - 0.5).collect();
            let mut y = vec![0.0; grid.dofs()];
            op.apply(&u, &mut y);
            let nd = grid.element_dofs();
            let mut expected = vec![0.0; grid.dofs()];
            for e in 0..grid.elements() {
                let nodes = grid.element_nodes(e);
                let dof = |r: usize| nodes[r / grid.dim] * grid.dim + r % grid.dim;
                for r in 0..nd {
                    for c in 0..nd {
                        expected[dof(r)] += op.scale()[e] * op.ke()[r * nd + c] * u[dof(c)];
                    }
                }
            }
            for (a, b) in y.iter().zip(&expected) {
                assert!((a - b).abs() < 1e-12, "{a} vs {b}");
            }
            let energy: f64 = op.element_energies(&u).iter().zip(op.scale()).map(|(w, s)| w * s).sum();
            let uky: f64 = u.iter().zip(&y).map(|(a, b)| a * b).sum();
            assert!((energy - uky).abs() < 1e-12 * uky.abs().max(1.0));
            let diagonal = op.diagonal();
            let mut unit = vec![0.0; grid.dofs()];
            unit[7] = 1.0;
            op.apply(&unit, &mut y);
            assert!((diagonal[7] - y[7]).abs() < 1e-14);
        }
    }

    #[test]
    fn inactive_voxels_and_fixed_dofs_are_removed() {
        let grid = Grid::new_2d(2, 1);
        let mut fixed = vec![false; grid.dofs()];
        fixed[0] = true;
        let op = Operator::new(grid, element_matrix(2, 0.3), vec![1.0, 0.0], fixed);
        let free = op.free();
        assert!(!free[0] && free[1]);
        // nodes 2 and 5 (right column) belong only to the inactive element
        for node in [2, 5] {
            assert!(!free[node * 2] && !free[node * 2 + 1]);
        }
        let mut y = vec![1.0; grid.dofs()];
        op.apply(&[1.0; 12], &mut y);
        assert!(y.iter().all(|v| v.abs() < 1e-15));
    }
}

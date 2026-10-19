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
use crate::real::Real;
use crate::scatter;
use crate::MIN_LEN;
use rayon::prelude::*;

/// Grid points (elements or nodes) a rayon task gets at least in the row-wise loops.
const ROW_WORK: usize = 2048;

/// The stiffness operator of one grid, element matrix and set of element scales.
#[derive(Debug, Clone)]
pub struct Operator {
    grid: Grid,
    ke: Vec<f64>,
    scale: Vec<f64>,
    fixed: Vec<bool>,
    free: Vec<bool>,
}

impl Operator {
    /// `ke`: unit element matrix (`element_dofs²`, row-major); `scale`: one per element (0 = inactive); `fixed`: one per DOF.
    pub fn new(grid: Grid, ke: Vec<f64>, scale: Vec<f64>, fixed: Vec<bool>) -> Operator {
        assert_eq!(ke.len(), grid.element_dofs() * grid.element_dofs(), "element matrix size");
        assert_eq!(scale.len(), grid.elements(), "one scale per element");
        assert_eq!(fixed.len(), grid.dofs(), "one fixed flag per DOF");
        let mut operator = Operator { grid, ke, scale, fixed, free: Vec::new() };
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

    /// `y = K u` on the free DOFs, 0 elsewhere (`u` is used as given, including non-free entries). Every row of `KE u_e`
    /// sums its terms in element-DOF order, all rows at once (the loop vectorises); [`scatter`] fixes the order of the sums
    /// per node.
    pub fn apply(&self, u: &[f64], y: &mut [f64]) {
        let g = &self.grid;
        assert!(u.len() == g.dofs() && y.len() == g.dofs(), "vector length");
        if g.dim == 3 {
            let columns = self.columns::<3, 24>();
            scatter::apply_3d(g, &self.free, u, y, |e, ue, out| scaled_product(self.scale[e], &columns, ue, out));
        } else {
            let columns = self.columns::<2, 8>();
            scatter::apply_2d(g, &self.free, u, y, |e, ue, out| scaled_product(self.scale[e], &columns, ue, out));
        }
    }

    /// The element matrix in row order ([`scatter::ROW_ORDER`]) by columns (`[t][r] = KE[r][t]`), so `KE u_e` accumulates
    /// all rows at once.
    fn columns<const D: usize, const ND: usize>(&self) -> [[f64; ND]; ND] {
        std::array::from_fn(|t| std::array::from_fn(|r| self.ke[scatter::local_dof(r, D) * ND + scatter::local_dof(t, D)]))
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
        let mut energies = vec![0.0; self.grid.elements()];
        if self.grid.dim == 3 {
            self.energies_fixed::<3, 8, 24>(u, &mut energies);
        } else {
            self.energies_fixed::<2, 4, 8>(u, &mut energies);
        }
        energies
    }

    /// `Σ_r u_e[r] · (Σ_t KE[r][t] u_e[t])` in local order, inner sums in `t` order, outer in `r` order.
    fn energies_fixed<const D: usize, const NPE: usize, const ND: usize>(&self, u: &[f64], energies: &mut [f64]) {
        let g = &self.grid;
        let offsets = g.local_offsets();
        let columns: [[f64; ND]; ND] = std::array::from_fn(|t| std::array::from_fn(|r| self.ke[r * ND + t]));
        let rows = (ROW_WORK / g.nx).max(1);
        energies.par_chunks_mut(g.nx).enumerate().with_min_len(rows).for_each(|(row, out)| {
            let (j, k) = (row % g.ny, row / g.ny);
            let first = g.element(0, j, k);
            let origin = g.node(0, j, k);
            for (i, energy) in out.iter_mut().enumerate() {
                if self.scale[first + i] == 0.0 {
                    continue;
                }
                let mut ue = [0.0f64; ND];
                for b in 0..NPE {
                    let node = (origin + i + offsets[b]) * D;
                    ue[b * D..b * D + D].copy_from_slice(&u[node..node + D]);
                }
                let mut acc = [0.0f64; ND];
                for (column, &ut) in columns.iter().zip(&ue) {
                    for (a, c) in acc.iter_mut().zip(column) {
                        *a += c * ut;
                    }
                }
                *energy = ue.iter().zip(&acc).fold(0.0, |sum, (v, a)| sum + v * a);
            }
        });
    }
}

/// `out = s · KE u_e` from the columns of KE (all rows at once, each summed in element-DOF order); false (and `out`
/// untouched) for an inactive element (`s = 0`).
#[inline(always)]
pub(crate) fn scaled_product<T: Real, const ND: usize>(s: T, columns: &[[T; ND]; ND], ue: &[T; ND], out: &mut [T; ND]) -> bool {
    if s == T::ZERO {
        return false;
    }
    let mut acc = [T::ZERO; ND];
    for (column, &ut) in columns.iter().zip(ue) {
        for (a, &c) in acc.iter_mut().zip(column) {
            *a += c * ut;
        }
    }
    for (value, &a) in out.iter_mut().zip(&acc) {
        *value = s * a;
    }
    true
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

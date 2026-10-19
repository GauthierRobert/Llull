//! Galerkin coarse operators of the multigrid (TR-TOP-04 M3): `K_c = Pᵀ K P` for the bilinear / trilinear prolongation P.
//!
//! P interpolates inside one coarse element, so `Pᵀ K P` is a sum of coarse element matrices: a coarse element E with
//! children c (the 2^dim fine elements inside it; children past the fine edge do not exist) gets
//! `K_E = Σ_c P_cᵀ K_c P_c`, where `P_c` interpolates E's nodal values to child c's nodes (one fixed matrix per child
//! position, the same for every component). From the fine operator `K_c = s_c KE`, so `K_E = Σ_c s_c (P_cᵀ KE P_c)` with the
//! 2^dim products precomputed; deeper levels apply the triple product to the stored child matrices. Each matrix is
//! symmetrised exactly (`(A + Aᵀ) / 2`), so the mat-vec may read it by columns. Children are summed in local order, so the
//! bits do not depend on the thread count.
//!
//! Unlike averaging the element scales (rediscretisation), the Galerkin operator keeps the energy of a high-contrast SIMP
//! design (solid members next to Emin voids) on every level, which is what keeps the V-cycle effective on optimised designs.

use crate::grid::{Grid, LOCAL_NODES};
use crate::operator::Operator;
use crate::scatter;
use crate::MIN_LEN;
use rayon::prelude::*;

/// Per-element stiffness matrices on a voxel grid (row-major `element_dofs²` each, exactly symmetric), with Dirichlet DOFs.
#[derive(Debug)]
pub struct ElementMatrices {
    grid: Grid,
    matrices: Vec<f64>,
    active: Vec<bool>,
    fixed: Vec<bool>,
    free: Vec<bool>,
}

/// Scalar interpolation `P_c[a][b]` from the coarse element's local node b to child c's local node a, for every child
/// position `c = dx + 2 dy + 4 dz` (first `nodes_per_element` rows / columns meaningful).
fn child_interpolation(dim: usize) -> Vec<[[f64; 8]; 8]> {
    let npe = 1 << dim;
    (0..npe)
        .map(|c| {
            let child = [c & 1, (c >> 1) & 1, (c >> 2) & 1];
            let mut p = [[0.0; 8]; 8];
            for (a, row) in p.iter_mut().enumerate().take(npe) {
                for (b, value) in row.iter_mut().enumerate().take(npe) {
                    *value = (0..dim)
                        .map(|axis| {
                            let position = (child[axis] + LOCAL_NODES[a][axis]) as f64;
                            (1.0 - (position - 2.0 * LOCAL_NODES[b][axis] as f64).abs() / 2.0).max(0.0)
                        })
                        .product();
                }
            }
            p
        })
        .collect()
}

/// `out += P_cᵀ A P_c` for the scalar interpolation `p` (applied per component), `A` and `out` `nd × nd` row-major.
fn add_triple_product(p: &[[f64; 8]; 8], a: &[f64], dim: usize, out: &mut [f64]) {
    let npe = 1 << dim;
    let nd = npe * dim;
    let mut t = [0.0f64; 24 * 24];
    // t[(row), (b', q')] = Σ_a' A[row, (a', q')] P[a'][b']
    for row in 0..nd {
        for b in 0..npe {
            for q in 0..dim {
                let mut sum = 0.0;
                for (ap, weights) in p.iter().enumerate().take(npe) {
                    sum += a[row * nd + ap * dim + q] * weights[b];
                }
                t[row * nd + b * dim + q] = sum;
            }
        }
    }
    // out[(b, q), col] += Σ_a P[a][b] t[(a, q), col]
    for b in 0..npe {
        for q in 0..dim {
            for col in 0..nd {
                let mut sum = 0.0;
                for (a, weights) in p.iter().enumerate().take(npe) {
                    sum += weights[b] * t[(a * dim + q) * nd + col];
                }
                out[(b * dim + q) * nd + col] += sum;
            }
        }
    }
}

fn symmetrise(matrix: &mut [f64], nd: usize) {
    for r in 0..nd {
        for c in r + 1..nd {
            let mean = 0.5 * (matrix[r * nd + c] + matrix[c * nd + r]);
            matrix[r * nd + c] = mean;
            matrix[c * nd + r] = mean;
        }
    }
}

/// Free DOFs: touched by an active element and not fixed.
fn free_dofs(grid: &Grid, active: &[bool], fixed: &[bool]) -> Vec<bool> {
    let mut present = vec![false; grid.nodes()];
    for e in (0..grid.elements()).filter(|&e| active[e]) {
        for &n in &grid.element_nodes(e)[..grid.nodes_per_element()] {
            present[n] = true;
        }
    }
    (0..grid.dofs()).map(|d| present[d / grid.dim] && !fixed[d]).collect()
}

/// The children of coarse element `e` of `coarse` inside `fine`: `(child position, fine element)`.
fn children<'a>(fine: &'a Grid, coarse: &'a Grid, e: usize) -> impl Iterator<Item = (usize, usize)> + 'a {
    let [i, j, k] = coarse.element_ijk(e);
    (0..1usize << fine.dim).filter_map(move |c| {
        let (fi, fj, fk) = (2 * i + (c & 1), 2 * j + ((c >> 1) & 1), 2 * k + ((c >> 2) & 1));
        (fi < fine.nx && fj < fine.ny && fk < fine.nz).then(|| (c, fine.element(fi, fj, fk)))
    })
}

impl ElementMatrices {
    /// The Galerkin operator of the scaled fine operator on `fine.grid().coarsened()` with the coarse Dirichlet DOFs `fixed`.
    pub fn from_scaled(fine: &Operator, fixed: Vec<bool>) -> ElementMatrices {
        let coarse = fine.grid().coarsened();
        let nd = coarse.element_dofs();
        let mut matrices = ElementMatrices {
            grid: coarse,
            matrices: vec![0.0; coarse.elements() * nd * nd],
            active: vec![false; coarse.elements()],
            fixed,
            free: Vec::new(),
        };
        matrices.update_from_scaled(fine);
        matrices.free = free_dofs(&matrices.grid, &matrices.active, &matrices.fixed);
        matrices
    }

    /// The Galerkin operator of `fine` one level down.
    pub fn from_matrices(fine: &ElementMatrices, fixed: Vec<bool>) -> ElementMatrices {
        let coarse = fine.grid.coarsened();
        let nd = coarse.element_dofs();
        let mut matrices = ElementMatrices {
            grid: coarse,
            matrices: vec![0.0; coarse.elements() * nd * nd],
            active: vec![false; coarse.elements()],
            fixed,
            free: Vec::new(),
        };
        matrices.update_from_matrices(fine);
        matrices.free = free_dofs(&matrices.grid, &matrices.active, &matrices.fixed);
        matrices
    }

    /// Recomputes the matrices from new fine scales (same activity).
    pub fn update_from_scaled(&mut self, fine: &Operator) {
        let g = *fine.grid();
        let nd = g.element_dofs();
        let p = child_interpolation(g.dim);
        let basis: Vec<Vec<f64>> = p
            .iter()
            .map(|pc| {
                let mut m = vec![0.0; nd * nd];
                add_triple_product(pc, fine.ke(), g.dim, &mut m);
                m
            })
            .collect();
        let coarse = self.grid;
        let scale = fine.scale();
        self.matrices.par_chunks_mut(nd * nd).zip(&mut self.active).enumerate().with_min_len(MIN_LEN / 64).for_each(
            |(e, (out, active))| {
                out.fill(0.0);
                *active = false;
                for (c, child) in children(&g, &coarse, e) {
                    let s = scale[child];
                    if s == 0.0 {
                        continue;
                    }
                    *active = true;
                    for (value, m) in out.iter_mut().zip(&basis[c]) {
                        *value += s * m;
                    }
                }
                symmetrise(out, nd);
            },
        );
    }

    /// Recomputes the matrices from new fine matrices (same activity).
    pub fn update_from_matrices(&mut self, fine: &ElementMatrices) {
        let g = fine.grid;
        let nd = g.element_dofs();
        let p = child_interpolation(g.dim);
        let coarse = self.grid;
        self.matrices.par_chunks_mut(nd * nd).zip(&mut self.active).enumerate().with_min_len(MIN_LEN / 256).for_each(
            |(e, (out, active))| {
                out.fill(0.0);
                *active = false;
                for (c, child) in children(&g, &coarse, e) {
                    if !fine.active[child] {
                        continue;
                    }
                    *active = true;
                    add_triple_product(&p[c], &fine.matrices[child * nd * nd..(child + 1) * nd * nd], g.dim, out);
                }
                symmetrise(out, nd);
            },
        );
    }

    pub fn grid(&self) -> &Grid {
        &self.grid
    }

    pub fn fixed(&self) -> &[bool] {
        &self.fixed
    }

    pub fn free(&self) -> &[bool] {
        &self.free
    }

    /// Whether element `e` has any stiffness.
    pub fn active(&self, e: usize) -> bool {
        self.active[e]
    }

    /// The matrix of element `e` (row-major).
    pub fn matrix(&self, e: usize) -> &[f64] {
        let nd = self.grid.element_dofs();
        &self.matrices[e * nd * nd..(e + 1) * nd * nd]
    }

    /// `y = K u` on the free DOFs, 0 elsewhere ([`scatter`]; the matrices are symmetric, so they are read by columns).
    pub fn apply(&self, u: &[f64], y: &mut [f64]) {
        assert!(u.len() == self.grid.dofs() && y.len() == self.grid.dofs(), "vector length");
        if self.grid.dim == 3 {
            scatter::apply_3d(&self.grid, &self.free, u, y, |e, ue, out| self.product(e, ue, out));
        } else {
            scatter::apply_2d(&self.grid, &self.free, u, y, |e, ue, out| self.product(e, ue, out));
        }
    }

    #[inline(always)]
    fn product<const ND: usize>(&self, e: usize, ue: &[f64; ND], out: &mut [f64; ND]) -> bool {
        if !self.active[e] {
            return false;
        }
        let matrix = &self.matrices[e * ND * ND..(e + 1) * ND * ND];
        out.fill(0.0);
        for (column, &ut) in matrix.chunks_exact(ND).zip(ue) {
            for (a, c) in out.iter_mut().zip(column) {
                *a += c * ut;
            }
        }
        true
    }

    /// Diagonal on the free DOFs (0 elsewhere), summed per node in local-node order.
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
                let e = g.element(i - ox, j - oy, k - oz);
                for (c, value) in out.iter_mut().enumerate() {
                    let r = a * dim + c;
                    *value += self.matrices[e * nd * nd + r * nd + r];
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ke::element_matrix;

    #[test]
    fn interpolation_rows_sum_to_one() {
        for dim in [2, 3] {
            for p in child_interpolation(dim) {
                for row in p.iter().take(1 << dim) {
                    assert!((row.iter().sum::<f64>() - 1.0).abs() < 1e-15);
                }
            }
        }
    }

    #[test]
    fn a_uniform_galerkin_level_equals_the_rediscretised_one() {
        // bilinear / trilinear spaces are nested: Pᵀ (s KE) P on a full 2^dim block is the coarse element s·g·KE (g = 1 in 2D,
        // 2 in 3D, where KE ∝ edge length)
        for (grid, geometric) in [(Grid::new_2d(4, 2), 1.0), (Grid::new_3d(2, 2, 2), 2.0)] {
            let ke = element_matrix(grid.dim, 0.3);
            let fine = Operator::new(grid, ke.clone(), vec![1.5; grid.elements()], vec![false; grid.dofs()]);
            let coarse = ElementMatrices::from_scaled(&fine, vec![false; grid.coarsened().dofs()]);
            for (a, b) in coarse.matrix(0).iter().zip(&ke) {
                assert!((a - 1.5 * geometric * b).abs() < 1e-14, "{a} vs {}", 1.5 * geometric * b);
            }
        }
    }
}

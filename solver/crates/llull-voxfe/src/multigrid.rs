//! Geometric multigrid V-cycle used as a PCG preconditioner (TR-TOP-04 M3).
//!
//! - Hierarchy: each level halves every axis (rounded up). A coarse voxel's stiffness scale is the mean of its 2^dim
//!   children's scales, with children that are inactive or past the fine edge counted as 0, times the geometric factor of the
//!   element matrix (×2 per level in 3D, where KE ∝ edge length; ×1 in 2D). A coarse voxel is active iff any child is.
//! - Transfer: bilinear / trilinear prolongation P, restriction R = Pᵀ, both as node-centric gathers (fixed order).
//! - Dirichlet DOFs: a coarse DOF is fixed when a fine fixed DOF of the same component lies in its interpolation support
//!   (so fixed points at odd fine nodes are not lost); fine fixed DOFs are zeroed after prolongation.
//! - Smoother: damped Jacobi, ω = 4 / (3 λ̂) with λ̂ a 10-step power-iteration estimate of λmax(D⁻¹K) (×1.1 safety), ν pre-
//!   and ν post-sweeps (symmetric, so the V-cycle is a symmetric preconditioner and plain PCG applies).
//! - Coarsest level (≤ `coarse_dofs` free DOFs): dense Cholesky.

use crate::grid::Grid;
use crate::operator::Operator;
use crate::pcg::{inverse_diagonal, Preconditioner};
use crate::MIN_LEN;
use llull_gpu::reduce::dot;
use rayon::prelude::*;

/// Multigrid knobs (named defaults).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MultigridSettings {
    /// Jacobi sweeps before and after the coarse correction (default 2).
    pub smoothing_steps: usize,
    /// Stop coarsening at or below this many free DOFs and factor that level densely (default 256).
    pub coarse_dofs: usize,
}

impl Default for MultigridSettings {
    fn default() -> MultigridSettings {
        MultigridSettings { smoothing_steps: 2, coarse_dofs: 256 }
    }
}

struct Level {
    op: Operator,
    inverse_diagonal: Vec<f64>,
    omega: f64,
}

/// Dense Cholesky factor of the coarsest level's free-DOF matrix.
struct Coarse {
    dofs: Vec<usize>,
    factor: Vec<f64>,
}

/// A V-cycle hierarchy built from a fine operator (rebuild it when the element scales change).
pub struct Multigrid {
    levels: Vec<Level>,
    coarse: Coarse,
    settings: MultigridSettings,
}

fn free_count(op: &Operator) -> usize {
    op.free().iter().filter(|&&f| f).count()
}

/// Interpolation weights of the coarse nodes covering fine node index `i` along one axis.
fn parents(i: usize) -> [(usize, f64); 2] {
    if i.is_multiple_of(2) {
        [(i / 2, 1.0), (0, 0.0)]
    } else {
        [((i - 1) / 2, 0.5), (i.div_ceil(2), 0.5)]
    }
}

fn coarsen(fine: &Operator) -> Operator {
    let g = fine.grid();
    let c = g.coarsened();
    let geometric = if g.dim == 3 { 2.0 } else { 1.0 };
    let factor = geometric / (1 << g.dim) as f64;
    let scale: Vec<f64> = (0..c.elements())
        .into_par_iter()
        .with_min_len(MIN_LEN)
        .map(|e| {
            let [i, j, k] = c.element_ijk(e);
            let mut sum = 0.0;
            for dz in 0..if g.dim == 3 { 2 } else { 1 } {
                for dy in 0..2 {
                    for dx in 0..2 {
                        let (fi, fj, fk) = (2 * i + dx, 2 * j + dy, 2 * k + dz);
                        if fi < g.nx && fj < g.ny && fk < g.nz {
                            sum += fine.scale()[g.element(fi, fj, fk)];
                        }
                    }
                }
            }
            sum * factor
        })
        .collect();
    let [fnx, fny, fnz] = g.node_dims();
    let mut fixed = vec![false; c.dofs()];
    for (d, _) in fine.fixed().iter().enumerate().filter(|(_, &f)| f) {
        let [i, j, k] = g.node_ijk(d / g.dim);
        debug_assert!(i < fnx && j < fny && k < fnz);
        for (ci, wi) in parents(i) {
            for (cj, wj) in parents(j) {
                for (ck, wk) in parents(k) {
                    if wi * wj * wk > 0.0 {
                        fixed[c.node(ci, cj, ck) * g.dim + d % g.dim] = true;
                    }
                }
            }
        }
    }
    Operator::new(c, fine.ke().to_vec(), scale, fixed)
}

/// `coarse = R fine` (R = Pᵀ), masked to the coarse free DOFs.
fn restrict(fine_op: &Operator, coarse_op: &Operator, fine: &[f64], coarse: &mut [f64]) {
    let (g, c) = (fine_op.grid(), coarse_op.grid());
    let [fnx, fny, fnz] = g.node_dims();
    let dim = g.dim;
    coarse.par_chunks_mut(dim).enumerate().with_min_len(MIN_LEN / 4).for_each(|(n, out)| {
        let [ci, cj, ck] = c.node_ijk(n);
        out.fill(0.0);
        let range = |center: usize, limit: usize| (center * 2).saturating_sub(1)..(center * 2 + 2).min(limit);
        for fk in range(ck, fnz) {
            let wk = if fk == 2 * ck { 1.0 } else { 0.5 };
            for fj in range(cj, fny) {
                let wj = if fj == 2 * cj { 1.0 } else { 0.5 };
                for fi in range(ci, fnx) {
                    let w = wk * wj * if fi == 2 * ci { 1.0 } else { 0.5 };
                    let f = g.node(fi, fj, fk);
                    for (q, value) in out.iter_mut().enumerate() {
                        *value += w * fine[f * dim + q];
                    }
                }
            }
        }
        for (q, value) in out.iter_mut().enumerate() {
            if !coarse_op.free()[n * dim + q] {
                *value = 0.0;
            }
        }
    });
}

/// `fine += P coarse`, masked to the fine free DOFs.
fn prolong_add(fine_op: &Operator, coarse_op: &Operator, coarse: &[f64], fine: &mut [f64]) {
    let (g, c) = (fine_op.grid(), coarse_op.grid());
    let dim = g.dim;
    fine.par_chunks_mut(dim).enumerate().with_min_len(MIN_LEN / 4).for_each(|(n, out)| {
        let [i, j, k] = g.node_ijk(n);
        for (ck, wk) in parents(k) {
            for (cj, wj) in parents(j) {
                for (ci, wi) in parents(i) {
                    let w = wi * wj * wk;
                    if w == 0.0 {
                        continue;
                    }
                    let cn = c.node(ci, cj, ck);
                    for (q, value) in out.iter_mut().enumerate() {
                        if fine_op.free()[n * dim + q] {
                            *value += w * coarse[cn * dim + q];
                        }
                    }
                }
            }
        }
    });
}

fn smoothing_weight(op: &Operator, inverse_diagonal: &[f64]) -> f64 {
    let n = inverse_diagonal.len();
    let mut v: Vec<f64> = (0..n).map(|d| if inverse_diagonal[d] > 0.0 { 1.0 + ((d * 7) % 11) as f64 / 11.0 } else { 0.0 }).collect();
    let mut w = vec![0.0; n];
    let mut lambda = 1.0;
    for _ in 0..10 {
        let norm = dot(&v, &v).sqrt();
        if norm == 0.0 {
            break;
        }
        v.par_iter_mut().with_min_len(MIN_LEN).for_each(|x| *x /= norm);
        op.apply(&v, &mut w);
        w.par_iter_mut().with_min_len(MIN_LEN).zip(inverse_diagonal).for_each(|(w, d)| *w *= d);
        lambda = dot(&v, &w);
        std::mem::swap(&mut v, &mut w);
    }
    4.0 / (3.0 * 1.1 * lambda.max(1e-3))
}

fn dense_factor(op: &Operator) -> Coarse {
    let g = op.grid();
    let dofs: Vec<usize> = (0..g.dofs()).filter(|&d| op.free()[d]).collect();
    let m = dofs.len();
    let mut index = vec![usize::MAX; g.dofs()];
    for (i, &d) in dofs.iter().enumerate() {
        index[d] = i;
    }
    let nd = g.element_dofs();
    let mut a = vec![0.0; m * m];
    for e in 0..g.elements() {
        let s = op.scale()[e];
        if s == 0.0 {
            continue;
        }
        let nodes = g.element_nodes(e);
        let global = |r: usize| index[nodes[r / g.dim] * g.dim + r % g.dim];
        for r in 0..nd {
            let gr = global(r);
            if gr == usize::MAX {
                continue;
            }
            for col in 0..nd {
                let gc = global(col);
                if gc != usize::MAX {
                    a[gr * m + gc] += s * op.ke()[r * nd + col];
                }
            }
        }
    }
    let max_diagonal = (0..m).map(|i| a[i * m + i]).fold(0.0, f64::max);
    for j in 0..m {
        let original = a[j * m + j];
        let mut d = original;
        for k in 0..j {
            d -= a[j * m + k] * a[j * m + k];
        }
        // a pivot lost to round-off (near-singular coarse level) is replaced by the original diagonal: still SPD
        let pivot = if d > 1e-13 * max_diagonal { d.sqrt() } else { original.max(f64::MIN_POSITIVE).sqrt() };
        a[j * m + j] = pivot;
        for i in j + 1..m {
            let mut s = a[i * m + j];
            for k in 0..j {
                s -= a[i * m + k] * a[j * m + k];
            }
            a[i * m + j] = s / pivot;
        }
    }
    Coarse { dofs, factor: a }
}

impl Coarse {
    fn solve(&self, r: &[f64], z: &mut [f64]) {
        let m = self.dofs.len();
        let l = &self.factor;
        let mut y: Vec<f64> = self.dofs.iter().map(|&d| r[d]).collect();
        for i in 0..m {
            let mut s = y[i];
            for k in 0..i {
                s -= l[i * m + k] * y[k];
            }
            y[i] = s / l[i * m + i];
        }
        for i in (0..m).rev() {
            let mut s = y[i];
            for k in i + 1..m {
                s -= l[k * m + i] * y[k];
            }
            y[i] = s / l[i * m + i];
        }
        z.fill(0.0);
        for (&d, &v) in self.dofs.iter().zip(&y) {
            z[d] = v;
        }
    }
}

impl Multigrid {
    /// Builds the hierarchy below `fine` (copied as level 0).
    pub fn new(fine: &Operator, settings: MultigridSettings) -> Multigrid {
        let mut ops = vec![fine.clone()];
        loop {
            let last = &ops[ops.len() - 1];
            let g: Grid = *last.grid();
            let flat = g.nx == 1 && g.ny == 1 && g.nz == 1;
            if free_count(last) <= settings.coarse_dofs || flat {
                break;
            }
            let next = coarsen(last);
            ops.push(next);
        }
        let coarse = dense_factor(&ops[ops.len() - 1]);
        let levels = ops
            .into_iter()
            .map(|op| {
                let inverse_diagonal = inverse_diagonal(&op);
                let omega = smoothing_weight(&op, &inverse_diagonal);
                Level { op, inverse_diagonal, omega }
            })
            .collect();
        Multigrid { levels, coarse, settings }
    }

    /// Number of levels including the fine one.
    pub fn levels(&self) -> usize {
        self.levels.len()
    }

    fn smooth(&self, level: &Level, r: &[f64], z: &mut [f64], scratch: &mut [f64]) {
        level.op.apply(z, scratch);
        z.par_iter_mut().with_min_len(MIN_LEN).zip(r).zip(scratch.par_iter().with_min_len(MIN_LEN)).zip(&level.inverse_diagonal).for_each(
            |(((z, r), kz), d)| {
                *z += level.omega * d * (r - kz);
            },
        );
    }

    fn cycle(&self, index: usize, r: &[f64], z: &mut [f64]) {
        if index + 1 == self.levels.len() {
            self.coarse.solve(r, z);
            return;
        }
        let level = &self.levels[index];
        let next = &self.levels[index + 1];
        let mut scratch = vec![0.0; r.len()];
        z.fill(0.0);
        for _ in 0..self.settings.smoothing_steps {
            self.smooth(level, r, z, &mut scratch);
        }
        level.op.apply(z, &mut scratch);
        scratch.par_iter_mut().with_min_len(MIN_LEN).zip(r).for_each(|(s, r)| *s = r - *s);
        let mut coarse_r = vec![0.0; next.op.grid().dofs()];
        restrict(&level.op, &next.op, &scratch, &mut coarse_r);
        let mut coarse_z = vec![0.0; coarse_r.len()];
        self.cycle(index + 1, &coarse_r, &mut coarse_z);
        prolong_add(&level.op, &next.op, &coarse_z, z);
        for _ in 0..self.settings.smoothing_steps {
            self.smooth(level, r, z, &mut scratch);
        }
    }
}

impl Preconditioner for Multigrid {
    fn precondition(&self, r: &[f64], z: &mut [f64]) {
        self.cycle(0, r, z);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ke::element_matrix;

    #[test]
    fn restriction_is_the_transpose_of_prolongation() {
        let grid = Grid::new_3d(5, 4, 3);
        let mut fixed = vec![false; grid.dofs()];
        fixed[0] = true;
        let scale: Vec<f64> = (0..grid.elements()).map(|e| if e % 7 == 3 { 0.0 } else { 1.0 }).collect();
        let fine = Operator::new(grid, element_matrix(3, 0.3), scale, fixed);
        let coarse = coarsen(&fine);
        let mut u: Vec<f64> = (0..grid.dofs()).map(|d| ((d * 13) % 7) as f64 - 3.0).collect();
        fine.mask(&mut u);
        let mut v: Vec<f64> = (0..coarse.grid().dofs()).map(|d| ((d * 5) % 3) as f64 + 0.5).collect();
        coarse.mask(&mut v);
        let mut ru = vec![0.0; v.len()];
        restrict(&fine, &coarse, &u, &mut ru);
        let mut pv = vec![0.0; u.len()];
        prolong_add(&fine, &coarse, &v, &mut pv);
        let left: f64 = ru.iter().zip(&v).map(|(a, b)| a * b).sum();
        let right: f64 = u.iter().zip(&pv).map(|(a, b)| a * b).sum();
        assert!((left - right).abs() < 1e-10 * left.abs().max(1.0), "{left} vs {right}");
        assert_eq!(*coarse.grid(), Grid::new_3d(3, 2, 2));
        assert!(coarse.fixed()[0]);
    }

    #[test]
    fn coarse_scale_is_the_child_mean_times_the_geometric_factor() {
        let grid = Grid::new_2d(3, 2);
        let scale = vec![1.0, 2.0, 4.0, 3.0, 0.0, 8.0];
        let fine = Operator::new(grid, element_matrix(2, 0.3), scale, vec![false; grid.dofs()]);
        let coarse = coarsen(&fine);
        assert_eq!(coarse.scale(), &[1.5, 3.0]);
        let cube = Grid::new_3d(2, 2, 2);
        let solid = Operator::new(cube, element_matrix(3, 0.3), vec![1.0; 8], vec![false; cube.dofs()]);
        assert_eq!(coarsen(&solid).scale(), &[2.0]);
    }
}

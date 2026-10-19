//! Geometric multigrid V-cycle used as a PCG preconditioner (TR-TOP-04 M3).
//!
//! - Hierarchy: each level halves every axis (rounded up). A coarse voxel's stiffness scale is the mean of its 2^dim
//!   children's scales, with children that are inactive or past the fine edge counted as 0, times the geometric factor of the
//!   element matrix (×2 per level in 3D, where KE ∝ edge length; ×1 in 2D). A coarse voxel is active iff any child is.
//!   [`Multigrid::update`] re-derives the scales of an existing hierarchy in place (grids, masks and buffers are kept).
//! - Transfer: bilinear / trilinear prolongation P, restriction R = Pᵀ, both as node-centric gathers (fixed order).
//! - Dirichlet DOFs: a coarse DOF is fixed when a fine fixed DOF of the same component lies in its interpolation support
//!   (so fixed points at odd fine nodes are not lost); fine fixed DOFs are zeroed after prolongation.
//! - Smoother ([`Smoother`]): a polynomial in D⁻¹K, the same before and after the coarse correction, so the V-cycle is a
//!   symmetric preconditioner and plain PCG applies. λ̂ = 1.1 × a 10-step power-iteration estimate of λmax(D⁻¹K). Damped
//!   Jacobi uses ω = 4 / (3 λ̂); Chebyshev targets [λ̂ / `chebyshev_ratio`, λ̂]. A pass of ν steps costs ν mat-vecs: the
//!   pre-smoother starts from z = 0 (its first step is free) and hands its residual on to the restriction.
//! - Coarsest level (≤ `coarse_dofs` free DOFs): dense Cholesky.
//!
//! Every step is element-wise or a fixed-order gather (the power iteration's dots are fixed-order reductions), so a V-cycle
//! gives the same bits for any thread count.

use crate::galerkin::ElementMatrices;
use crate::grid::Grid;
use crate::operator::Operator;
use crate::pcg::Preconditioner;
use crate::MIN_LEN;
use llull_gpu::reduce::dot;
use rayon::prelude::*;
use std::sync::Mutex;

/// Smoothing polynomial of every level but the coarsest.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Smoother {
    /// Damped Jacobi, ω = 4 / (3 λ̂).
    Jacobi,
    /// Chebyshev polynomial of degree `smoothing_steps` on [λ̂ / `chebyshev_ratio`, λ̂].
    Chebyshev,
}

/// Multigrid knobs (named defaults).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MultigridSettings {
    /// Smoothing steps (mat-vecs) before and after the coarse correction (default 2).
    pub smoothing_steps: usize,
    /// Stop coarsening at or below this many free DOFs and factor that level densely (default 256).
    pub coarse_dofs: usize,
    pub smoother: Smoother,
    /// λmax / λmin of the Chebyshev interval (default 4).
    pub chebyshev_ratio: f64,
    /// Galerkin coarse operators `Pᵀ K P` (default) instead of averaged element scales.
    pub galerkin: bool,
}

impl Default for MultigridSettings {
    fn default() -> MultigridSettings {
        MultigridSettings { smoothing_steps: 2, coarse_dofs: 256, smoother: Smoother::Jacobi, chebyshev_ratio: 4.0, galerkin: true }
    }
}

/// The operator of one level: the fine operator and averaged coarse levels scale KE per element; Galerkin levels store a
/// matrix per element.
enum LevelOperator {
    Scaled(Operator),
    Assembled(ElementMatrices),
}

impl LevelOperator {
    fn grid(&self) -> &Grid {
        match self {
            LevelOperator::Scaled(op) => op.grid(),
            LevelOperator::Assembled(op) => op.grid(),
        }
    }

    fn free(&self) -> &[bool] {
        match self {
            LevelOperator::Scaled(op) => op.free(),
            LevelOperator::Assembled(op) => op.free(),
        }
    }

    fn fixed(&self) -> &[bool] {
        match self {
            LevelOperator::Scaled(op) => op.fixed(),
            LevelOperator::Assembled(op) => op.fixed(),
        }
    }

    fn apply(&self, u: &[f64], y: &mut [f64]) {
        match self {
            LevelOperator::Scaled(op) => op.apply(u, y),
            LevelOperator::Assembled(op) => op.apply(u, y),
        }
    }

    fn inverse_diagonal(&self) -> Vec<f64> {
        let diagonal = match self {
            LevelOperator::Scaled(op) => op.diagonal(),
            LevelOperator::Assembled(op) => op.diagonal(),
        };
        diagonal.into_iter().map(|d| if d > 0.0 { 1.0 / d } else { 0.0 }).collect()
    }

    /// Writes element `e`'s matrix into `out`; false for an element without stiffness.
    fn element_matrix(&self, e: usize, out: &mut [f64]) -> bool {
        match self {
            LevelOperator::Scaled(op) => {
                let s = op.scale()[e];
                for (value, k) in out.iter_mut().zip(op.ke()) {
                    *value = s * k;
                }
                s != 0.0
            }
            LevelOperator::Assembled(op) => {
                out.copy_from_slice(op.matrix(e));
                op.active(e)
            }
        }
    }

    /// The next coarser level.
    fn coarsen(&self, galerkin: bool) -> LevelOperator {
        let fixed = coarse_fixed(self.grid(), self.fixed());
        match (self, galerkin) {
            (LevelOperator::Scaled(op), false) => {
                let c = op.grid().coarsened();
                LevelOperator::Scaled(Operator::new(c, op.ke().to_vec(), coarse_scale(op, &c), fixed))
            }
            (LevelOperator::Scaled(op), true) => LevelOperator::Assembled(ElementMatrices::from_scaled(op, fixed)),
            (LevelOperator::Assembled(op), _) => LevelOperator::Assembled(ElementMatrices::from_matrices(op, fixed)),
        }
    }

    /// Re-derives this coarse level from its (updated) finer level.
    fn update_from(&mut self, fine: &LevelOperator) {
        match (self, fine) {
            (LevelOperator::Scaled(op), LevelOperator::Scaled(fine)) => {
                let scale = coarse_scale(fine, op.grid());
                op.set_scale(scale);
            }
            (LevelOperator::Assembled(op), LevelOperator::Scaled(fine)) => op.update_from_scaled(fine),
            (LevelOperator::Assembled(op), LevelOperator::Assembled(fine)) => op.update_from_matrices(fine),
            (LevelOperator::Scaled(_), LevelOperator::Assembled(_)) => unreachable!("a scaled level below a Galerkin one"),
        }
    }
}

struct Level {
    op: LevelOperator,
    inverse_diagonal: Vec<f64>,
    /// 1.1 × the power-iteration estimate of λmax(D⁻¹K).
    lambda: f64,
}

impl Level {
    fn new(op: LevelOperator) -> Level {
        let mut level = Level { op, inverse_diagonal: Vec::new(), lambda: 1.0 };
        level.refresh();
        level
    }

    fn refresh(&mut self) {
        self.inverse_diagonal = self.op.inverse_diagonal();
        self.lambda = lambda_max(&self.op, &self.inverse_diagonal);
    }
}

/// Dense Cholesky factor of the coarsest level's free-DOF matrix.
struct Coarse {
    dofs: Vec<usize>,
    factor: Vec<f64>,
}

/// Vectors of one level for a V-cycle, allocated once.
struct Work {
    residual: Vec<f64>,
    /// Chebyshev direction.
    direction: Vec<f64>,
    product: Vec<f64>,
    /// Right-hand side and correction of this level as a coarse level (empty on the fine level).
    rhs: Vec<f64>,
    correction: Vec<f64>,
}

impl Work {
    fn new(dofs: usize, coarse: bool) -> Work {
        let coarse_len = if coarse { dofs } else { 0 };
        Work {
            residual: vec![0.0; dofs],
            direction: vec![0.0; dofs],
            product: vec![0.0; dofs],
            rhs: vec![0.0; coarse_len],
            correction: vec![0.0; coarse_len],
        }
    }
}

/// A V-cycle hierarchy built from a fine operator ([`Multigrid::update`] when the element scales change).
pub struct Multigrid {
    levels: Vec<Level>,
    coarse: Coarse,
    settings: MultigridSettings,
    work: Mutex<Vec<Work>>,
}

fn free_count(op: &LevelOperator) -> usize {
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

/// Element scales of grid `c`, one level coarser than `fine`.
fn coarse_scale(fine: &Operator, c: &Grid) -> Vec<f64> {
    let g = fine.grid();
    let geometric = if g.dim == 3 { 2.0 } else { 1.0 };
    let factor = geometric / (1 << g.dim) as f64;
    (0..c.elements())
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
        .collect()
}

/// Coarse Dirichlet DOFs: a coarse DOF is fixed when a fixed fine DOF of the same component lies in its support.
fn coarse_fixed(g: &Grid, fine_fixed: &[bool]) -> Vec<bool> {
    let c = g.coarsened();
    let mut fixed = vec![false; c.dofs()];
    for (d, _) in fine_fixed.iter().enumerate().filter(|(_, &f)| f) {
        let [i, j, k] = g.node_ijk(d / g.dim);
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
    fixed
}

/// Rows of nodes (fixed `j`, `k`) a rayon task gets at least.
fn node_rows(nodes_per_row: usize) -> usize {
    (2048 / nodes_per_row).max(1)
}

/// `coarse = R fine` (R = Pᵀ), masked to the coarse free DOFs.
fn restrict(fine_op: &LevelOperator, coarse_op: &LevelOperator, fine: &[f64], coarse: &mut [f64]) {
    let (g, c) = (fine_op.grid(), coarse_op.grid());
    let [fnx, fny, fnz] = g.node_dims();
    let [cnx, cny, _] = c.node_dims();
    let dim = g.dim;
    let free = coarse_op.free();
    let range = |center: usize, limit: usize| (center * 2).saturating_sub(1)..(center * 2 + 2).min(limit);
    let weight = |f: usize, center: usize| if f == 2 * center { 1.0 } else { 0.5 };
    coarse.par_chunks_mut(cnx * dim).enumerate().with_min_len(node_rows(cnx)).for_each(|(row, out)| {
        let (cj, ck) = (row % cny, row / cny);
        out.fill(0.0);
        for fk in range(ck, fnz) {
            let wk = weight(fk, ck);
            for fj in range(cj, fny) {
                let wjk = wk * weight(fj, cj);
                let base = g.node(0, fj, fk);
                for (ci, value) in out.chunks_exact_mut(dim).enumerate() {
                    for fi in range(ci, fnx) {
                        let w = wjk * weight(fi, ci);
                        let f = (base + fi) * dim;
                        for (q, v) in value.iter_mut().enumerate() {
                            *v += w * fine[f + q];
                        }
                    }
                }
            }
        }
        let first = row * cnx * dim;
        for (d, v) in out.iter_mut().enumerate() {
            if !free[first + d] {
                *v = 0.0;
            }
        }
    });
}

/// `fine += P coarse`, masked to the fine free DOFs.
fn prolong_add(fine_op: &LevelOperator, coarse_op: &LevelOperator, coarse: &[f64], fine: &mut [f64]) {
    let (g, c) = (fine_op.grid(), coarse_op.grid());
    let [fnx, fny, _] = g.node_dims();
    let dim = g.dim;
    let free = fine_op.free();
    fine.par_chunks_mut(fnx * dim).enumerate().with_min_len(node_rows(fnx)).for_each(|(row, out)| {
        let (j, k) = (row % fny, row / fny);
        let first = row * fnx * dim;
        for (i, value) in out.chunks_exact_mut(dim).enumerate() {
            let mut acc = [0.0f64; 3];
            for (ck, wk) in parents(k) {
                for (cj, wj) in parents(j) {
                    for (ci, wi) in parents(i) {
                        let w = wi * wj * wk;
                        if w == 0.0 {
                            continue;
                        }
                        let cn = c.node(ci, cj, ck) * dim;
                        for (q, a) in acc.iter_mut().enumerate().take(dim) {
                            *a += w * coarse[cn + q];
                        }
                    }
                }
            }
            for (q, v) in value.iter_mut().enumerate() {
                if free[first + i * dim + q] {
                    *v += acc[q];
                }
            }
        }
    });
}

/// 1.1 × λmax(D⁻¹K) estimated by 10 power iterations from a fixed start vector.
fn lambda_max(op: &LevelOperator, inverse_diagonal: &[f64]) -> f64 {
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
    1.1 * lambda.max(1e-3)
}

fn dense_factor(op: &LevelOperator) -> Coarse {
    let g = op.grid();
    let dofs: Vec<usize> = (0..g.dofs()).filter(|&d| op.free()[d]).collect();
    let m = dofs.len();
    let mut index = vec![usize::MAX; g.dofs()];
    for (i, &d) in dofs.iter().enumerate() {
        index[d] = i;
    }
    let nd = g.element_dofs();
    let mut a = vec![0.0; m * m];
    let mut element = vec![0.0; nd * nd];
    for e in 0..g.elements() {
        if !op.element_matrix(e, &mut element) {
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
                    a[gr * m + gc] += element[r * nd + col];
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

/// `residual = r − product` (element-wise).
fn difference(r: &[f64], product: &[f64], residual: &mut [f64]) {
    residual.par_iter_mut().with_min_len(MIN_LEN).zip(r).zip(product).for_each(|((out, r), p)| *out = r - p);
}

impl Multigrid {
    /// Builds the hierarchy below `fine` (copied as level 0).
    pub fn new(fine: &Operator, settings: MultigridSettings) -> Multigrid {
        let mut ops = vec![LevelOperator::Scaled(fine.clone())];
        loop {
            let last = &ops[ops.len() - 1];
            let g: Grid = *last.grid();
            let flat = g.nx == 1 && g.ny == 1 && g.nz == 1;
            if free_count(last) <= settings.coarse_dofs || flat {
                break;
            }
            let next = last.coarsen(settings.galerkin);
            ops.push(next);
        }
        let coarse = dense_factor(&ops[ops.len() - 1]);
        let levels: Vec<Level> = ops.into_iter().map(Level::new).collect();
        let work = levels.iter().enumerate().map(|(index, level)| Work::new(level.op.grid().dofs(), index > 0)).collect();
        Multigrid { levels, coarse, settings, work: Mutex::new(work) }
    }

    /// Re-derives every level from new element scales of the same fine grid, supports and activity (no reallocation of the
    /// grids, masks or V-cycle vectors). Gives the same hierarchy as [`Multigrid::new`] on `fine`.
    pub fn update(&mut self, fine: &Operator) {
        let LevelOperator::Scaled(first) = &mut self.levels[0].op else { unreachable!("the fine level is scaled") };
        assert!(fine.grid() == first.grid() && fine.fixed() == first.fixed(), "another fine operator");
        first.set_scale(fine.scale().to_vec());
        for index in 1..self.levels.len() {
            let (done, rest) = self.levels.split_at_mut(index);
            rest[0].op.update_from(&done[index - 1].op);
        }
        for level in &mut self.levels {
            level.refresh();
        }
        self.coarse = dense_factor(&self.levels[self.levels.len() - 1].op);
    }

    /// Number of levels including the fine one.
    pub fn levels(&self) -> usize {
        self.levels.len()
    }

    /// ν smoothing steps on `level`. From zero (pre-smoothing) `z` is overwritten; otherwise it is improved. With
    /// `want_residual`, `work.residual` ends as `r − K z`.
    fn smooth(&self, level: &Level, r: &[f64], z: &mut [f64], work: &mut Work, from_zero: bool, want_residual: bool) {
        let steps = self.settings.smoothing_steps.max(1);
        let Work { residual, direction, product, .. } = work;
        let d = &level.inverse_diagonal;
        if from_zero {
            residual.copy_from_slice(r);
        } else {
            level.op.apply(z, product);
            difference(r, product, residual);
        }
        match self.settings.smoother {
            Smoother::Jacobi => {
                let omega = 4.0 / (3.0 * level.lambda);
                for step in 0..steps {
                    let first = from_zero && step == 0;
                    z.par_iter_mut().with_min_len(MIN_LEN).zip(&**residual).zip(d).for_each(|((z, r), d)| {
                        let correction = omega * d * r;
                        *z = if first { correction } else { *z + correction };
                    });
                    if step + 1 < steps || want_residual {
                        level.op.apply(z, product);
                        difference(r, product, residual);
                    }
                }
            }
            Smoother::Chebyshev => {
                let upper = level.lambda;
                let lower = upper / self.settings.chebyshev_ratio;
                let (theta, delta) = (0.5 * (upper + lower), 0.5 * (upper - lower));
                let sigma = theta / delta;
                let mut rho = 1.0 / sigma;
                direction.par_iter_mut().with_min_len(MIN_LEN).zip(&**residual).zip(d).for_each(|((p, r), d)| *p = d * r / theta);
                for step in 0..steps {
                    if step > 0 {
                        let rho_next = 1.0 / (2.0 * sigma - rho);
                        let (a, b) = (rho_next * rho, 2.0 * rho_next / delta);
                        direction
                            .par_iter_mut()
                            .with_min_len(MIN_LEN)
                            .zip(&**residual)
                            .zip(d)
                            .for_each(|((p, r), d)| *p = a * *p + b * d * r);
                        rho = rho_next;
                    }
                    let first = from_zero && step == 0;
                    z.par_iter_mut().with_min_len(MIN_LEN).zip(&**direction).for_each(|(z, p)| *z = if first { *p } else { *z + p });
                    if step + 1 < steps || want_residual {
                        level.op.apply(direction, product);
                        residual.par_iter_mut().with_min_len(MIN_LEN).zip(&**product).for_each(|(r, kp)| *r -= kp);
                    }
                }
            }
        }
    }

    fn cycle(&self, index: usize, r: &[f64], z: &mut [f64], works: &mut [Work]) {
        if index + 1 == self.levels.len() {
            self.coarse.solve(r, z);
            return;
        }
        let (level, next) = (&self.levels[index], &self.levels[index + 1]);
        let (work, rest) = works.split_first_mut().unwrap_or_else(|| unreachable!("one work per level"));
        self.smooth(level, r, z, work, true, true);
        let (mut rhs, mut correction) = (std::mem::take(&mut rest[0].rhs), std::mem::take(&mut rest[0].correction));
        restrict(&level.op, &next.op, &work.residual, &mut rhs);
        self.cycle(index + 1, &rhs, &mut correction, rest);
        prolong_add(&level.op, &next.op, &correction, z);
        (rest[0].rhs, rest[0].correction) = (rhs, correction);
        self.smooth(level, r, z, work, false, false);
    }
}

impl Preconditioner for Multigrid {
    fn precondition(&self, r: &[f64], z: &mut [f64]) {
        let mut works = self.work.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        self.cycle(0, r, z, &mut works);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ke::element_matrix;

    fn mask(op: &LevelOperator, v: &mut [f64]) {
        for (value, &free) in v.iter_mut().zip(op.free()) {
            if !free {
                *value = 0.0;
            }
        }
    }

    #[test]
    fn restriction_is_the_transpose_of_prolongation() {
        let grid = Grid::new_3d(5, 4, 3);
        let mut fixed = vec![false; grid.dofs()];
        fixed[0] = true;
        let scale: Vec<f64> = (0..grid.elements()).map(|e| if e % 7 == 3 { 0.0 } else { 1.0 }).collect();
        let fine = LevelOperator::Scaled(Operator::new(grid, element_matrix(3, 0.3), scale, fixed));
        for galerkin in [false, true] {
            let coarse = fine.coarsen(galerkin);
            let mut u: Vec<f64> = (0..grid.dofs()).map(|d| ((d * 13) % 7) as f64 - 3.0).collect();
            mask(&fine, &mut u);
            let mut v: Vec<f64> = (0..coarse.grid().dofs()).map(|d| ((d * 5) % 3) as f64 + 0.5).collect();
            mask(&coarse, &mut v);
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
    }

    #[test]
    fn coarse_scale_is_the_child_mean_times_the_geometric_factor() {
        let grid = Grid::new_2d(3, 2);
        let fine = Operator::new(grid, element_matrix(2, 0.3), vec![1.0, 2.0, 4.0, 3.0, 0.0, 8.0], vec![false; grid.dofs()]);
        assert_eq!(coarse_scale(&fine, &grid.coarsened()), [1.5, 3.0]);
        let cube = Grid::new_3d(2, 2, 2);
        let solid = Operator::new(cube, element_matrix(3, 0.3), vec![1.0; 8], vec![false; cube.dofs()]);
        assert_eq!(coarse_scale(&solid, &cube.coarsened()), [2.0]);
    }

    #[test]
    fn the_galerkin_operator_is_pt_k_p() {
        // (P v)ᵀ K (P w) on the fine grid equals vᵀ K_c w on the coarse grid, including fixed DOFs and void voxels
        let grid = Grid::new_2d(5, 3);
        let mut fixed = vec![false; grid.dofs()];
        fixed[0] = true;
        fixed[grid.node(5, 0, 0) * 2 + 1] = true;
        let scale: Vec<f64> = (0..grid.elements()).map(|e| if e % 4 == 1 { 1e-9 } else { 1.0 + e as f64 * 0.1 }).collect();
        let fine = LevelOperator::Scaled(Operator::new(grid, element_matrix(2, 0.3), scale, fixed));
        let coarse = fine.coarsen(true);
        let mut v: Vec<f64> = (0..coarse.grid().dofs()).map(|d| ((d * 5) % 3) as f64 + 0.5).collect();
        mask(&coarse, &mut v);
        let mut pv = vec![0.0; grid.dofs()];
        prolong_add(&fine, &coarse, &v, &mut pv);
        let mut kpv = vec![0.0; grid.dofs()];
        fine.apply(&pv, &mut kpv);
        let mut kv = vec![0.0; v.len()];
        coarse.apply(&v, &mut kv);
        let fine_energy: f64 = pv.iter().zip(&kpv).map(|(a, b)| a * b).sum();
        let coarse_energy: f64 = v.iter().zip(&kv).map(|(a, b)| a * b).sum();
        assert!((fine_energy - coarse_energy).abs() < 1e-12 * fine_energy, "{fine_energy} vs {coarse_energy}");
        let deeper = coarse.coarsen(true);
        let mut w: Vec<f64> = (0..deeper.grid().dofs()).map(|d| (d % 4) as f64 - 1.5).collect();
        mask(&deeper, &mut w);
        let mut pw = vec![0.0; v.len()];
        prolong_add(&coarse, &deeper, &w, &mut pw);
        coarse.apply(&pw, &mut kv);
        let mut kw = vec![0.0; w.len()];
        deeper.apply(&w, &mut kw);
        let left: f64 = pw.iter().zip(&kv).map(|(a, b)| a * b).sum();
        let right: f64 = w.iter().zip(&kw).map(|(a, b)| a * b).sum();
        assert!((left - right).abs() < 1e-12 * left.abs(), "{left} vs {right}");
    }

    #[test]
    fn update_gives_the_hierarchy_new_builds() {
        let grid = Grid::new_3d(6, 4, 3);
        let fixed: Vec<bool> = (0..grid.dofs()).map(|d| d < 12).collect();
        let scale = |shift: usize| -> Vec<f64> { (0..grid.elements()).map(|e| 1e-3 + ((e + shift) % 5) as f64).collect() };
        let first = Operator::new(grid, element_matrix(3, 0.3), scale(0), fixed.clone());
        let second = Operator::new(grid, element_matrix(3, 0.3), scale(2), fixed);
        let r: Vec<f64> = (0..grid.dofs()).map(|d| if d < 12 { 0.0 } else { ((d * 7) % 5) as f64 - 2.0 }).collect();
        for settings in [
            MultigridSettings { coarse_dofs: 20, ..MultigridSettings::default() },
            MultigridSettings { coarse_dofs: 20, galerkin: false, smoother: Smoother::Chebyshev, ..MultigridSettings::default() },
        ] {
            let mut updated = Multigrid::new(&first, settings);
            updated.update(&second);
            let fresh = Multigrid::new(&second, settings);
            assert!(fresh.levels() > 2);
            let (mut a, mut b) = (vec![0.0; r.len()], vec![0.0; r.len()]);
            updated.precondition(&r, &mut a);
            fresh.precondition(&r, &mut b);
            assert_eq!(a, b);
            assert!(a.iter().zip(&r).map(|(z, r)| z * r).sum::<f64>() > 0.0);
        }
    }
}

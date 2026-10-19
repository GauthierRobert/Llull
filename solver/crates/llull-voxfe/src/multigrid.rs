//! Geometric multigrid V-cycle used as a PCG preconditioner (TR-TOP-04 M3).
//!
//! - Hierarchy: each level halves every axis (rounded up; elements past the fine edge do not exist). The coarse operators
//!   are Galerkin, `K_c = Pᵀ K P`, stored per coarse element ([`crate::galerkin`]); a coarse element has stiffness iff a
//!   child has. [`Multigrid::update`] re-derives an existing hierarchy from new element scales in place.
//! - Transfer ([`crate::transfer`]): bilinear / trilinear prolongation P, restriction R = Pᵀ, row by row (fixed order).
//! - Dirichlet DOFs: a coarse DOF is fixed when a fine fixed DOF of the same component lies in its interpolation support
//!   (so fixed points at odd fine nodes are not lost); fine fixed DOFs are zeroed after prolongation.
//! - Smoother ([`Smoother`]): a polynomial in D⁻¹K, the same before and after the coarse correction, so the V-cycle is a
//!   symmetric preconditioner and plain PCG applies. λ̂ = 1.1 × a 10-step power-iteration estimate of λmax(D⁻¹K). Chebyshev
//!   (default, degree `smoothing_steps`) targets [λ̂ / `chebyshev_ratio`, λ̂]; damped Jacobi uses ω = 4 / (3 λ̂). A pass of ν
//!   steps costs ν mat-vecs: the pre-smoother starts from z = 0 (its first step is free) and hands its residual on to the
//!   restriction.
//! - Coarsest level (≤ `coarse_dofs` free DOFs): dense Cholesky in f64.
//! - Float type `T` ([`Real`]): the V-cycle runs in f64 or f32. The PCG around it stays f64 (its residual, tolerance and
//!   answer); an f32 V-cycle halves the memory traffic and doubles the SIMD lanes of the smoothing mat-vecs.
//!
//! Every step is element-wise, a fixed-order gather / scatter, or a fixed-order dot (power iteration), so a V-cycle gives
//! the same bits for any thread count.

use crate::galerkin::ElementMatrices;
use crate::grid::Grid;
use crate::level::{Coarse, Fine, LevelOperator};
use crate::operator::Operator;
use crate::pcg::Preconditioner;
use crate::real::{self, Real};
use crate::transfer::{self, parents};
use crate::MIN_LEN;
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
    /// Default Chebyshev.
    pub smoother: Smoother,
    /// λmax / λmin of the Chebyshev interval (default 6).
    pub chebyshev_ratio: f64,
}

impl Default for MultigridSettings {
    fn default() -> MultigridSettings {
        MultigridSettings { smoothing_steps: 2, coarse_dofs: 256, smoother: Smoother::Chebyshev, chebyshev_ratio: 6.0 }
    }
}

struct Level<T: Real> {
    op: LevelOperator<T>,
    inverse_diagonal: Vec<T>,
    /// 1.1 × the power-iteration estimate of λmax(D⁻¹K).
    lambda: f64,
}

impl<T: Real> Level<T> {
    /// Recomputes the smoother data from the level operator and its f64 diagonal.
    fn refresh(&mut self, diagonal: Vec<f64>) {
        self.inverse_diagonal = diagonal.into_iter().map(|d| if d > 0.0 { T::of(1.0 / d) } else { T::ZERO }).collect();
        self.lambda = lambda_max(&self.op, &self.inverse_diagonal);
    }
}

/// Vectors of one level for a V-cycle, allocated once.
struct Work<T: Real> {
    residual: Vec<T>,
    /// Chebyshev direction.
    direction: Vec<T>,
    product: Vec<T>,
    /// Right-hand side and correction of this level (on the fine level: the V-cycle's input and output in `T`).
    rhs: Vec<T>,
    correction: Vec<T>,
}

impl<T: Real> Work<T> {
    fn new(dofs: usize) -> Work<T> {
        let zero = || vec![T::ZERO; dofs];
        Work { residual: zero(), direction: zero(), product: zero(), rhs: zero(), correction: zero() }
    }
}

/// A V-cycle hierarchy built from a fine operator ([`Multigrid::update`] when the element scales change), in float type `T`.
pub struct Multigrid<T: Real = f64> {
    levels: Vec<Level<T>>,
    coarse: Coarse,
    settings: MultigridSettings,
    work: Mutex<Vec<Work<T>>>,
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

/// 1.1 × λmax(D⁻¹K) estimated by 10 power iterations from a fixed start vector.
fn lambda_max<T: Real>(op: &LevelOperator<T>, inverse_diagonal: &[T]) -> f64 {
    let n = inverse_diagonal.len();
    let mut v: Vec<T> =
        (0..n).map(|d| if inverse_diagonal[d] > T::ZERO { T::of(1.0 + ((d * 7) % 11) as f64 / 11.0) } else { T::ZERO }).collect();
    let mut w = vec![T::ZERO; n];
    let mut lambda = 1.0;
    for _ in 0..10 {
        let norm = real::dot(&v, &v).sqrt();
        if norm == 0.0 {
            break;
        }
        v.par_iter_mut().with_min_len(MIN_LEN).for_each(|x| *x = T::of(x.get() / norm));
        op.apply(&v, &mut w);
        w.par_iter_mut().with_min_len(MIN_LEN).zip(inverse_diagonal).for_each(|(w, &d)| *w = *w * d);
        lambda = real::dot(&v, &w);
        std::mem::swap(&mut v, &mut w);
    }
    1.1 * lambda.max(1e-3)
}

/// Chebyshev smoothing on [λ / ratio, λ] in `steps` steps: the first direction is `first · D⁻¹ r`, step `s ≥ 1` updates
/// it to `a_s · direction + b_s · D⁻¹ r` (returned as `(first, [(a_1, b_1), …])`).
pub(crate) fn chebyshev(lambda: f64, ratio: f64, steps: usize) -> (f64, Vec<(f64, f64)>) {
    let lower = lambda / ratio;
    let (theta, delta) = (0.5 * (lambda + lower), 0.5 * (lambda - lower));
    let sigma = theta / delta;
    let mut rho = 1.0 / sigma;
    let recurrence = (1..steps.max(1))
        .map(|_| {
            let rho_next = 1.0 / (2.0 * sigma - rho);
            let coefficients = (rho_next * rho, 2.0 * rho_next / delta);
            rho = rho_next;
            coefficients
        })
        .collect();
    (1.0 / theta, recurrence)
}

/// `residual = r − product` (element-wise).
fn difference<T: Real>(r: &[T], product: &[T], residual: &mut [T]) {
    residual.par_iter_mut().with_min_len(MIN_LEN).zip(r).zip(product).for_each(|((out, &r), &p)| *out = r - p);
}

fn diagonal_of<T: Real>(op: &LevelOperator<T>, fine: &Operator) -> Vec<f64> {
    match op {
        LevelOperator::Fine(_) => fine.diagonal(),
        LevelOperator::Assembled(matrices) => matrices.diagonal(),
    }
}

impl<T: Real> Multigrid<T> {
    /// Builds the hierarchy below `fine` (level 0 is `fine` rounded to `T`).
    pub fn new(fine: &Operator, settings: MultigridSettings) -> Multigrid<T> {
        let mut ops = vec![LevelOperator::Fine(Fine::new(fine))];
        loop {
            let last = &ops[ops.len() - 1];
            let g: Grid = *last.grid();
            let flat = g.nx == 1 && g.ny == 1 && g.nz == 1;
            if last.free().iter().filter(|&&f| f).count() <= settings.coarse_dofs || flat {
                break;
            }
            let fixed = coarse_fixed(&g, last.fixed());
            let next = match last {
                LevelOperator::Fine(_) => ElementMatrices::from_scaled(fine, fixed),
                LevelOperator::Assembled(matrices) => ElementMatrices::from_matrices(matrices, fixed),
            };
            ops.push(LevelOperator::Assembled(next));
        }
        let coarse = Coarse::new(&ops[ops.len() - 1]);
        let levels: Vec<Level<T>> = ops
            .into_iter()
            .map(|op| {
                let diagonal = diagonal_of(&op, fine);
                let mut level = Level { op, inverse_diagonal: Vec::new(), lambda: 1.0 };
                level.refresh(diagonal);
                level
            })
            .collect();
        let work = levels.iter().map(|level| Work::new(level.op.grid().dofs())).collect();
        Multigrid { levels, coarse, settings, work: Mutex::new(work) }
    }

    /// Re-derives every level from new element scales of the same fine grid, supports and activity (no reallocation of the
    /// grids, masks or V-cycle vectors). Gives the same hierarchy as [`Multigrid::new`] on `fine`.
    pub fn update(&mut self, fine: &Operator) {
        assert!(fine.grid() == self.levels[0].op.grid() && fine.fixed() == self.levels[0].op.fixed(), "another fine operator");
        let LevelOperator::Fine(first) = &mut self.levels[0].op else { unreachable!("level 0 is the fine operator") };
        first.set_scale(fine);
        for index in 1..self.levels.len() {
            let (done, rest) = self.levels.split_at_mut(index);
            let LevelOperator::Assembled(coarse) = &mut rest[0].op else { unreachable!("coarse levels are Galerkin") };
            match &done[index - 1].op {
                LevelOperator::Fine(_) => coarse.update_from_scaled(fine),
                LevelOperator::Assembled(matrices) => coarse.update_from_matrices(matrices),
            }
        }
        for level in &mut self.levels {
            let diagonal = diagonal_of(&level.op, fine);
            level.refresh(diagonal);
        }
        self.coarse = Coarse::new(&self.levels[self.levels.len() - 1].op);
    }

    /// Number of levels including the fine one.
    pub fn levels(&self) -> usize {
        self.levels.len()
    }

    #[cfg(feature = "gpu")]
    pub(crate) fn settings(&self) -> &MultigridSettings {
        &self.settings
    }

    #[cfg(feature = "gpu")]
    /// Level `index`: its operator, 1 / diag(K) and λ̂ (the GPU mirror reads these).
    pub(crate) fn level(&self, index: usize) -> (&LevelOperator<T>, &[T], f64) {
        let level = &self.levels[index];
        (&level.op, &level.inverse_diagonal, level.lambda)
    }

    #[cfg(feature = "gpu")]
    pub(crate) fn coarse(&self) -> &Coarse {
        &self.coarse
    }

    /// ν smoothing steps on `level`. From zero (pre-smoothing) `z` is overwritten; otherwise it is improved. With
    /// `want_residual`, `work.residual` ends as `r − K z`.
    fn smooth(&self, level: &Level<T>, r: &[T], z: &mut [T], work: &mut Work<T>, from_zero: bool, want_residual: bool) {
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
                let omega = T::of(4.0 / (3.0 * level.lambda));
                for step in 0..steps {
                    let first = from_zero && step == 0;
                    z.par_iter_mut().with_min_len(MIN_LEN).zip(&**residual).zip(d).for_each(|((z, &r), &d)| {
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
                let (first_scale, recurrence) = chebyshev(level.lambda, self.settings.chebyshev_ratio, steps);
                let scale = T::of(first_scale);
                direction.par_iter_mut().with_min_len(MIN_LEN).zip(&**residual).zip(d).for_each(|((p, &r), &d)| *p = scale * d * r);
                for step in 0..steps {
                    if step > 0 {
                        let (a, b) = recurrence[step - 1];
                        let (a, b) = (T::of(a), T::of(b));
                        direction
                            .par_iter_mut()
                            .with_min_len(MIN_LEN)
                            .zip(&**residual)
                            .zip(d)
                            .for_each(|((p, &r), &d)| *p = a * *p + b * d * r);
                    }
                    let first = from_zero && step == 0;
                    z.par_iter_mut().with_min_len(MIN_LEN).zip(&**direction).for_each(|(z, &p)| *z = if first { p } else { *z + p });
                    if step + 1 < steps || want_residual {
                        level.op.apply(direction, product);
                        residual.par_iter_mut().with_min_len(MIN_LEN).zip(&**product).for_each(|(r, &kp)| *r -= kp);
                    }
                }
            }
        }
    }

    /// One V-cycle from `index` down: `z ≈ K⁻¹ r` on that level. `works[0]` belongs to level `index`.
    fn cycle(&self, index: usize, r: &[T], z: &mut [T], works: &mut [Work<T>]) {
        if index + 1 == self.levels.len() {
            self.coarse.solve(r, z);
            return;
        }
        let (level, next) = (&self.levels[index], &self.levels[index + 1]);
        let (work, rest) = works.split_first_mut().unwrap_or_else(|| unreachable!("one work per level"));
        self.smooth(level, r, z, work, true, true);
        let (mut rhs, mut correction) = (std::mem::take(&mut rest[0].rhs), std::mem::take(&mut rest[0].correction));
        transfer::restrict(level.op.grid(), next.op.grid(), next.op.free(), &work.residual, &mut rhs);
        self.cycle(index + 1, &rhs, &mut correction, rest);
        transfer::prolong_add(level.op.grid(), next.op.grid(), level.op.free(), &correction, z);
        (rest[0].rhs, rest[0].correction) = (rhs, correction);
        self.smooth(level, r, z, work, false, false);
    }
}

impl<T: Real> Preconditioner for Multigrid<T> {
    fn precondition(&self, r: &[f64], z: &mut [f64]) {
        let mut works = self.work.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let (mut rhs, mut correction) = (std::mem::take(&mut works[0].rhs), std::mem::take(&mut works[0].correction));
        rhs.par_iter_mut().with_min_len(MIN_LEN).zip(r).for_each(|(value, &r)| *value = T::of(r));
        self.cycle(0, &rhs, &mut correction, &mut works);
        z.par_iter_mut().with_min_len(MIN_LEN).zip(&correction).for_each(|(value, c)| *value = c.get());
        (works[0].rhs, works[0].correction) = (rhs, correction);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ke::element_matrix;

    fn mask(free: &[bool], v: &mut [f64]) {
        for (value, &free) in v.iter_mut().zip(free) {
            if !free {
                *value = 0.0;
            }
        }
    }

    fn energy(u: &[f64], v: &[f64]) -> f64 {
        u.iter().zip(v).map(|(a, b)| a * b).sum()
    }

    #[test]
    fn restriction_is_the_transpose_of_prolongation() {
        let grid = Grid::new_3d(5, 4, 3);
        let mut fixed = vec![false; grid.dofs()];
        fixed[0] = true;
        let scale: Vec<f64> = (0..grid.elements()).map(|e| if e % 7 == 3 { 0.0 } else { 1.0 }).collect();
        let fine = Operator::new(grid, element_matrix(3, 0.3), scale, fixed);
        let coarse: ElementMatrices = ElementMatrices::from_scaled(&fine, coarse_fixed(&grid, fine.fixed()));
        let c = grid.coarsened();
        let mut u: Vec<f64> = (0..grid.dofs()).map(|d| ((d * 13) % 7) as f64 - 3.0).collect();
        mask(fine.free(), &mut u);
        let mut v: Vec<f64> = (0..c.dofs()).map(|d| ((d * 5) % 3) as f64 + 0.5).collect();
        mask(coarse.free(), &mut v);
        let mut ru = vec![0.0; v.len()];
        transfer::restrict(&grid, &c, coarse.free(), &u, &mut ru);
        let mut pv = vec![0.0; u.len()];
        transfer::prolong_add(&grid, &c, fine.free(), &v, &mut pv);
        let (left, right) = (energy(&ru, &v), energy(&u, &pv));
        assert!((left - right).abs() < 1e-10 * left.abs().max(1.0), "{left} vs {right}");
        assert_eq!(c, Grid::new_3d(3, 2, 2));
        assert!(coarse.fixed()[0]);
    }

    #[test]
    fn the_galerkin_operator_is_pt_k_p() {
        // (P v)ᵀ K (P w) on the fine grid equals vᵀ K_c w on the coarse grid, including fixed DOFs and void voxels
        let grid = Grid::new_2d(5, 3);
        let mut fixed = vec![false; grid.dofs()];
        fixed[0] = true;
        fixed[grid.node(5, 0, 0) * 2 + 1] = true;
        let scale: Vec<f64> = (0..grid.elements()).map(|e| if e % 4 == 1 { 1e-9 } else { 1.0 + e as f64 * 0.1 }).collect();
        let fine = Operator::new(grid, element_matrix(2, 0.3), scale, fixed);
        let coarse: ElementMatrices = ElementMatrices::from_scaled(&fine, coarse_fixed(&grid, fine.fixed()));
        let c = grid.coarsened();
        let mut v: Vec<f64> = (0..c.dofs()).map(|d| ((d * 5) % 3) as f64 + 0.5).collect();
        mask(coarse.free(), &mut v);
        let mut pv = vec![0.0; grid.dofs()];
        transfer::prolong_add(&grid, &c, fine.free(), &v, &mut pv);
        let mut kpv = vec![0.0; grid.dofs()];
        fine.apply(&pv, &mut kpv);
        let mut kv = vec![0.0; v.len()];
        coarse.apply(&v, &mut kv);
        let (fine_energy, coarse_energy) = (energy(&pv, &kpv), energy(&v, &kv));
        assert!((fine_energy - coarse_energy).abs() < 1e-12 * fine_energy, "{fine_energy} vs {coarse_energy}");
        let deeper: ElementMatrices = ElementMatrices::from_matrices(&coarse, coarse_fixed(&c, coarse.fixed()));
        let d = c.coarsened();
        let mut w: Vec<f64> = (0..d.dofs()).map(|i| (i % 4) as f64 - 1.5).collect();
        mask(deeper.free(), &mut w);
        let mut pw = vec![0.0; v.len()];
        transfer::prolong_add(&c, &d, coarse.free(), &w, &mut pw);
        coarse.apply(&pw, &mut kv);
        let mut kw = vec![0.0; w.len()];
        deeper.apply(&w, &mut kw);
        let (left, right) = (energy(&pw, &kv), energy(&w, &kw));
        assert!((left - right).abs() < 1e-12 * left.abs(), "{left} vs {right}");
    }

    fn update_matches_new<T: Real>(settings: MultigridSettings) {
        let grid = Grid::new_3d(6, 4, 3);
        let fixed: Vec<bool> = (0..grid.dofs()).map(|d| d < 12).collect();
        let scale = |shift: usize| -> Vec<f64> { (0..grid.elements()).map(|e| 1e-3 + ((e + shift) % 5) as f64).collect() };
        let first = Operator::new(grid, element_matrix(3, 0.3), scale(0), fixed.clone());
        let second = Operator::new(grid, element_matrix(3, 0.3), scale(2), fixed);
        let r: Vec<f64> = (0..grid.dofs()).map(|d| if d < 12 { 0.0 } else { ((d * 7) % 5) as f64 - 2.0 }).collect();
        let mut updated = Multigrid::<T>::new(&first, settings);
        updated.update(&second);
        let fresh = Multigrid::<T>::new(&second, settings);
        assert!(fresh.levels() > 2);
        let (mut a, mut b) = (vec![0.0; r.len()], vec![0.0; r.len()]);
        updated.precondition(&r, &mut a);
        fresh.precondition(&r, &mut b);
        assert_eq!(a, b);
        assert!(energy(&a, &r) > 0.0);
    }

    #[test]
    fn update_gives_the_hierarchy_new_builds() {
        let settings = MultigridSettings { coarse_dofs: 20, ..MultigridSettings::default() };
        update_matches_new::<f64>(settings);
        update_matches_new::<f32>(settings);
        update_matches_new::<f64>(MultigridSettings { smoother: Smoother::Jacobi, ..settings });
    }
}

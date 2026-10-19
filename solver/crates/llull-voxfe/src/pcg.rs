//! Preconditioned conjugate gradients on the free DOFs of an [`Operator`] (TR-TOP-04): stop when ‖r‖₂ / ‖b‖₂ ≤ tolerance
//! (1e-10 in llull-topopt). Dots use the fixed-order reductions of `llull-gpu`, every other step is element-wise, so a solve
//! is bit-reproducible for any thread count.

use crate::operator::Operator;
use crate::MIN_LEN;
use llull_gpu::reduce::{dot, CHUNK};
use rayon::prelude::*;
use std::fmt;

/// `z = M⁻¹ r` for a symmetric positive definite M; `z` must be 0 at the non-free DOFs.
pub trait Preconditioner: Sync {
    fn precondition(&self, r: &[f64], z: &mut [f64]);
}

/// Diagonal (Jacobi) preconditioner.
pub struct Jacobi {
    inverse: Vec<f64>,
}

impl Jacobi {
    pub fn new(op: &Operator) -> Jacobi {
        Jacobi { inverse: inverse_diagonal(op) }
    }
}

/// 1 / diag(K) on the free DOFs, 0 elsewhere (a free DOF with a zero diagonal also gets 0).
pub fn inverse_diagonal(op: &Operator) -> Vec<f64> {
    op.diagonal().into_iter().map(|d| if d > 0.0 { 1.0 / d } else { 0.0 }).collect()
}

impl Preconditioner for Jacobi {
    fn precondition(&self, r: &[f64], z: &mut [f64]) {
        z.par_iter_mut().with_min_len(MIN_LEN).zip(r).zip(&self.inverse).for_each(|((z, r), d)| *z = r * d);
    }
}

/// Outcome of a converged solve.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SolveStats {
    pub iterations: usize,
    pub relative_residual: f64,
}

/// Why a solve failed (llull-topopt reports `TOP_SOLVER_FAILED`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SolveError {
    /// pᵀKp ≤ 0: the reduced system is singular (unsupported rigid-body motion) or not positive definite.
    Breakdown { iteration: usize, relative_residual: f64 },
    /// The residual did not reach the tolerance within the iteration cap.
    NotConverged { iterations: usize, relative_residual: f64 },
    /// A NaN or infinity appeared.
    NonFinite { iteration: usize },
}

impl fmt::Display for SolveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SolveError::Breakdown { iteration, relative_residual } => write!(
                f,
                "PCG breakdown at iteration {iteration} (relative residual {relative_residual:.3e}): the system is singular; check the supports"
            ),
            SolveError::NotConverged { iterations, relative_residual } => {
                write!(f, "PCG did not converge in {iterations} iterations (relative residual {relative_residual:.3e})")
            }
            SolveError::NonFinite { iteration } => write!(f, "PCG produced a non-finite value at iteration {iteration}"),
        }
    }
}

/// `x += α p`, `r −= α q` and `r · r` in one pass: the same element operations, and the same fixed-order chunked sum as
/// [`dot`], as the separate steps.
fn update(alpha: f64, p: &[f64], q: &[f64], x: &mut [f64], r: &mut [f64]) -> f64 {
    let partials: Vec<f64> = x
        .par_chunks_mut(CHUNK)
        .zip(r.par_chunks_mut(CHUNK))
        .zip(p.par_chunks(CHUNK))
        .zip(q.par_chunks(CHUNK))
        .map(|(((x, r), p), q)| {
            let mut sum = 0.0;
            for (((x, r), p), q) in x.iter_mut().zip(r.iter_mut()).zip(p).zip(q) {
                *x += alpha * p;
                *r += -alpha * q;
                sum += *r * *r;
            }
            sum
        })
        .collect();
    partials.iter().fold(0.0, |acc, v| acc + v)
}

/// Solves `K x = b` on the free DOFs, starting from `x` (masked first). `b` is masked internally.
pub fn pcg(
    op: &Operator,
    pre: &impl Preconditioner,
    b: &[f64],
    x: &mut [f64],
    tolerance: f64,
    max_iterations: usize,
) -> Result<SolveStats, SolveError> {
    let n = b.len();
    let mut rhs = b.to_vec();
    op.mask(&mut rhs);
    op.mask(x);
    let b_norm = dot(&rhs, &rhs).sqrt();
    if b_norm == 0.0 {
        x.fill(0.0);
        return Ok(SolveStats { iterations: 0, relative_residual: 0.0 });
    }
    let mut q = vec![0.0; n];
    op.apply(x, &mut q);
    let mut r: Vec<f64> = rhs.par_iter().with_min_len(MIN_LEN).zip(&q).map(|(b, q)| b - q).collect();
    let mut residual = dot(&r, &r).sqrt() / b_norm;
    if residual <= tolerance {
        return Ok(SolveStats { iterations: 0, relative_residual: residual });
    }
    let mut z = vec![0.0; n];
    pre.precondition(&r, &mut z);
    let mut p = z.clone();
    let mut rz = dot(&r, &z);
    for iteration in 1..=max_iterations {
        op.apply(&p, &mut q);
        let pq = dot(&p, &q);
        if !pq.is_finite() || !rz.is_finite() {
            return Err(SolveError::NonFinite { iteration });
        }
        if pq <= 0.0 {
            return Err(SolveError::Breakdown { iteration, relative_residual: residual });
        }
        let alpha = rz / pq;
        residual = update(alpha, &p, &q, x, &mut r).sqrt() / b_norm;
        if !residual.is_finite() {
            return Err(SolveError::NonFinite { iteration });
        }
        if residual <= tolerance {
            return Ok(SolveStats { iterations: iteration, relative_residual: residual });
        }
        pre.precondition(&r, &mut z);
        let rz_next = dot(&r, &z);
        let beta = rz_next / rz;
        rz = rz_next;
        p.par_iter_mut().with_min_len(MIN_LEN).zip(&z).for_each(|(p, z)| *p = z + beta * *p);
    }
    Err(SolveError::NotConverged { iterations: max_iterations, relative_residual: residual })
}

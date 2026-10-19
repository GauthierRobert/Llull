//! Matrix-free voxel finite elements (RS1 §2 `crates/llull-voxfe`, PHY-17 TR-TOP-03 / 04 / 05).
//!
//! - [`grid`]: regular voxel grid numbering (x fastest); inactive voxels are removed from the system, not set to Emin.
//! - [`ke`]: Q4 plane-stress (top88) and H8 (2×2×2 Gauss) unit element matrices.
//! - [`operator`]: `K u` as a node-centric gather of per-element contributions scaled by `s_e`, with Dirichlet DOFs.
//! - [`pcg`]: Jacobi-preconditioned CG to a relative residual (1e-10 in llull-topopt).
//! - [`multigrid`]: geometric multigrid V-cycle (element-scale averaging, Jacobi smoother) as a PCG preconditioner.
//! - `gpu` (feature `gpu`): wgpu kernels for the mat-vec and the vector ops in f32, plus an f32 Jacobi PCG.
//!
//! Precision (PHY-17 §11 Q7, decided here): the f64 CPU twin is the recorded path (`deterministic: true`, bit-reproducible
//! for any thread count: every reduction has a fixed order). The GPU stores and computes in f32 (not every adapter has f64)
//! and is the exploration path (`deterministic: false`); llull-topopt wraps it in f64 iterative refinement on the CPU so its
//! answers still meet the 1e-10 residual.

pub mod galerkin;
pub mod grid;
pub mod ke;
pub mod multigrid;
pub mod operator;
pub mod pcg;
pub mod scatter;

#[cfg(feature = "gpu")]
pub mod gpu;

/// Smallest slice a rayon task gets in the element-wise loops (smaller grids run inline on the calling worker).
pub const MIN_LEN: usize = 4096;

pub use grid::Grid;
pub use operator::Operator;
pub use pcg::{SolveError, SolveStats};

/// Linear solver choice of the CPU twin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SolverKind {
    Jacobi,
    Multigrid,
}

/// Solves `K x = b` with PCG and the chosen preconditioner (multigrid hierarchy built from `op`).
pub fn solve(
    op: &Operator,
    kind: SolverKind,
    b: &[f64],
    x: &mut [f64],
    tolerance: f64,
    max_iterations: usize,
) -> Result<SolveStats, SolveError> {
    match kind {
        SolverKind::Jacobi => pcg::pcg(op, &pcg::Jacobi::new(op), b, x, tolerance, max_iterations),
        SolverKind::Multigrid => {
            let mg = multigrid::Multigrid::new(op, multigrid::MultigridSettings::default());
            pcg::pcg(op, &mg, b, x, tolerance, max_iterations)
        }
    }
}

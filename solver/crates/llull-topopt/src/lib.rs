//! PHY-17 topology optimisation (RS1 RS-2, V1 TOP-V1): modified SIMP, sensitivity / density filters with Heaviside
//! projection, OC or MMA, multiple weighted load cases with gravity, the extrusion constraint, 2D Q4 plane stress and 3D H8 on
//! the matrix-free voxel FE of `llull-voxfe`, and the `llull-compute topopt` job.
//!
//! - [`filter`]: fixed-stencil convolution filters (rmin in voxels).
//! - [`projection`]: Heaviside projection with β continuation.
//! - [`oc`]: optimality-criteria bisection (l1 = 0, l2 = 1e9, tolerance 1e-3, move).
//! - [`mma`]: method of moving asymptotes (Svanberg 1987), dual subproblem solver, resumable state.
//! - [`design`]: design-variable space (identity, or one variable per column for the extrusion constraint).
//! - [`loads`]: design-dependent gravity loads.
//! - [`simp`]: the loop (TECHNICAL_SPEC §5.1 / §5.2 / §15), devices `cpu | gpu | auto`, resume from a design and a state.
//! - [`job`]: the job folder contract (`job.json` in; `field.bin`, `design.f64`, `displacements.f64`, `state.json`,
//!   `result.json` out). Read its module doc for the schema.

pub mod design;
pub mod filter;
pub mod homogenize_job;
pub mod job;
pub mod loads;
pub mod mma;
pub mod oc;
pub mod projection;
pub mod simp;
mod solver;

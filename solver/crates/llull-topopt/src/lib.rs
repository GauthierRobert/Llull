//! PHY-17 topology optimisation (RS1 RS-2): modified SIMP, sensitivity / density filters, OC, multiple weighted load cases,
//! 2D Q4 plane stress and 3D H8 on the matrix-free voxel FE of `llull-voxfe`, and the `llull-compute topopt` job.
//!
//! - [`filter`]: fixed-stencil convolution filters (rmin in voxels).
//! - [`oc`]: optimality-criteria bisection (l1 = 0, l2 = 1e9, tolerance 1e-3, move).
//! - [`simp`]: the loop (TECHNICAL_SPEC §5.1 / §5.2), devices `cpu | gpu | auto`, resume from a design.
//! - [`job`]: the job folder contract (`job.json` in; `field.bin`, `design.f64`, `result.json` out). Read its module doc for
//!   the schema.

pub mod filter;
pub mod job;
pub mod oc;
pub mod simp;

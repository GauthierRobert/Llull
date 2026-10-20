//! PHY-19 explicit dynamics (RS1 RS-8a): central-difference integration with lumped mass, the 8-node hexahedron with one-point
//! integration and Flanagan–Belytschko viscous hourglass control, the 4-node tetrahedron, hypoelastic (Jaumann) elasticity with
//! Johnson–Cook J2 plasticity, bulk viscosity and planar rigid walls; the `llull-compute explicit` job. Formulations and their sources:
//! docs/physics/19-explicit-impact/TECHNICAL_SPEC.md §13 (decision Q10).

// Tensor and element arithmetic indexes several arrays with one subscript (B_Ij, x_iI, σ_ij): index loops read like the equations.
#![allow(clippy::needless_range_loop)]
// `!(x > 0.0)` is deliberate: it rejects NaN together with non-positive values.
#![allow(clippy::neg_cmp_op_on_partial_ord)]

pub mod contact;
#[cfg(feature = "gpu")]
pub mod gpu;
pub mod hex8;
pub mod job;
pub mod material;
pub mod model;
pub mod projection;
pub mod shell;
pub mod shells;
pub mod solver;
pub mod stability;
pub mod tet4;

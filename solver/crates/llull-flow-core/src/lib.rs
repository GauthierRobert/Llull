//! Flow grid shared by the llull CFD solvers (aerospace 12 CFD TECHNICAL_SPEC §2, §5.2; RS1 §2 `crates/llull-flow-core`).
//!
//! - [`grid`]: the uniform cell grid in the case frame (metres; x along the free stream at α = β = 0, z up).
//! - [`stl`]: binary STL reading / writing (the flow surface the host exports, metres).
//! - [`voxel`]: parity ray casting of the surface into solid / fluid cells, each solid cell attributed to the body whose
//!   triangle the ray entered through (per-body forces).
//! - [`reduce`]: fixed-order per-body sums of per-cell vectors (bit-identical for any thread count).
//! - [`sample`]: trilinear sampling of cell-centred fields at points and on the surface triangles.
//!
//! Everything here is the CPU reference; the GPU solver mirrors the per-cell arithmetic and reuses these reductions on the host.

pub mod grid;
pub mod reduce;
pub mod sample;
pub mod stl;
pub mod voxel;

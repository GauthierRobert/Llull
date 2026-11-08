//! Flow grid shared by the llull CFD solvers (aerospace 12 CFD TECHNICAL_SPEC §2, §5.2, §5.5; RS1 §2 `crates/llull-flow-core`).
//!
//! - [`grid`]: the uniform cell grid in the case frame (metres; x along the free stream at α = β = 0, z up).
//! - [`stl`]: binary STL reading / writing (the flow surface the host exports, metres).
//! - [`voxel`]: parity ray casting of the surface into solid / fluid cells, each solid cell attributed to the body whose
//!   triangle the ray entered through (per-body forces).
//! - [`reduce`]: fixed-order per-body sums of per-cell vectors (bit-identical for any thread count).
//! - [`sample`]: trilinear sampling of cell-centred fields at points and on the surface triangles.
//! - [`field`]: the recorded field of a solve (`field.bin`, `LLFD`) and its half-model mirror sampling.
//! - [`slice`]: square plane patches (`LLSL`); [`streamline`]: RK4 streamlines with Douglas-Peucker decimation (CPU, f64,
//!   deterministic) and, with the feature `gpu`, the wgpu twin (`gpu_streamline`, f32).
//! - [`query`]: the `llull-compute flow-query` job (probes, slices, streamlines on a recorded field).
//!
//! Everything here is the CPU reference; the GPU paths mirror the arithmetic and reuse these reductions on the host.

pub mod field;
#[cfg(feature = "gpu")]
pub mod gpu_streamline;
pub mod grid;
pub mod query;
pub mod reduce;
pub mod sample;
pub mod slice;
pub mod stl;
pub mod streamline;
pub mod voxel;

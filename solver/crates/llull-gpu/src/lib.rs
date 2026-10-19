//! Shared GPU plumbing of the llull native jobs (RS1 §2 `crates/llull-gpu`).
//!
//! - [`reduce`]: fixed-order (deterministic) reductions on the CPU. Vectors are cut into fixed [`reduce::CHUNK`]-sized chunks,
//!   each chunk is summed left to right, then the chunk partials are summed left to right, so the result does not depend on
//!   the rayon thread count (RS1 §2 rule 3).
//! - `device` (feature `wgpu`): adapter / device selection shared by every GPU path (`llull-raster`, `llull-voxfe`). When no
//!   adapter exists, or `LLULL_GPU=off`, it returns the reason as an `Err(String)` and the caller runs its CPU twin.
//! - `buffers` (feature `wgpu`): storage / uniform buffer creation, read-back, 2D dispatch sizing.
//! - `dot` (feature `wgpu`): GPU dot product with a fixed-order workgroup tree and an in-order f64 sum of the workgroup
//!   partials on the host, so a run is reproducible on one device and driver.

pub mod reduce;

#[cfg(feature = "wgpu")]
pub mod buffers;
#[cfg(feature = "wgpu")]
pub mod device;
#[cfg(feature = "wgpu")]
pub mod dot;

#[cfg(feature = "wgpu")]
pub use wgpu;

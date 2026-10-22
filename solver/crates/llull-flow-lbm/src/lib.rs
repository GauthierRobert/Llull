//! Low-speed flow solver of llull (aerospace 12 CFD TECHNICAL_SPEC §5.3, §5.6; RS1 §2 `crates/llull-flow-lbm`): D3Q19 lattice
//! Boltzmann, BGK collision with Smagorinsky LES, Guo body force, half-way bounce-back walls (moving ground), equilibrium inlet,
//! zero-gradient pressure outlet, specular free-slip / symmetry faces, forces by momentum exchange per body.
//!
//! - [`lattice`], [`units`], [`domain`], [`kernel`]: the model; [`cpu`]: the Rust CPU twin (deterministic, the reference);
//! - [`gpu`] (feature `gpu`): the same kernel as WGSL compute shaders, f32, one dispatch per step in watchdog-safe slices;
//! - [`solver`]: the steady-state run (transient, averaging, convergence on the drag) over either backend;
//! - [`job`]: the `llull-compute flow <job-folder>` contract.

pub mod cpu;
pub mod domain;
pub mod job;
pub mod kernel;
pub mod lattice;
pub mod outputs;
pub mod real;
pub mod solver;
pub mod units;

#[cfg(feature = "gpu")]
pub mod gpu;

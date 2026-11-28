//! The wgpu compute path tracer (cargo feature `gpu`; RV1 RV-M3 `engine: "gpu"`): the CPU integrator ported to WGSL, one invocation
//! per pixel, on the CPU's own scene structures.
//!
//! - **Scene:** `pack` flattens the two-level BVH as built for the CPU (a BLAS per mesh, the TLAS over the instances with their affine
//!   and inverse, never expanded), the materials, lights, textures and environment CDFs into seven storage buffers (layout in `pack`).
//! - **Shading:** `common.wgsl` (bindings, random numbers), `scene.wgsl` (traversal, surface point), `bsdf.wgsl` (GGX metal-roughness,
//!   coat, rough transmission), `material.wgsl` (textures, normal maps, environment map + importance sampling), `lights.wgsl` (sun cone,
//!   point / spot spheres, area rects, emissive triangles from the CPU's alias table), `integrator.wgsl` (camera with thin lens and tent
//!   filter, NEE + MIS, Russian roulette, kernel).
//! - **Textures:** a storage-buffer atlas, not GPU textures: RGBA8 texels (sRGB decoded per texel through the CPU's table) and f32
//!   RGB texels, sampled bilinear in the shader exactly as `texture.rs`, so there is no texture-count or texture-size binding limit.
//! - **Progressive:** `run` renders 256² px tiles in submissions of about 100 ms; `maxSeconds` and `targetNoise` as on the CPU.
//! - **Limits (fall back to the CPU with the reason):** each buffer must fit the adapter's storage-buffer binding size (e.g. 3 x 4 B
//!   per triangle, 32 B per vertex, 4 B per LDR texel, 12 B per HDR texel), every BVH at most 62 levels deep (traversal stack 64), the
//!   adapter must offer 7 storage buffers per shader stage.
//! - **Not bit-identical:** 32-bit counter hashes replace the CPU's 64-bit ones and GPU float rounding differs, so a GPU image is a
//!   statistically equal estimate (`deterministic: false`); the denoiser and the EXR / PNG output are the CPU's.

mod pack;
mod run;

pub use run::{render, GpuRender, TILE};

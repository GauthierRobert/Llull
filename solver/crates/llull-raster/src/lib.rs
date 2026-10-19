//! Offscreen field-plot raster of `llull-compute raster` (RS1 RS-5, aerospace 05 TR-FEA-92): the per-pixel stage of
//! `packages/domain-cae/src/results/fieldRaster.ts` (z-buffer, edges, band colours, supersample resolve). The CPU twin (`cpu`) is
//! bit-identical to the TypeScript and is what every test runs; the wgpu path (`gpu`, cargo feature `gpu`) is a picture, not a reference
//! (`deterministic: false` in provenance) and falls back to the CPU twin when no adapter exists.
//!
//! Job folder: `job.json` (scalars) + little-endian f64 buffers `ghost.f64`, `triangles.f64`, `light.f64`, `normals.f64`, `owners.f64`,
//! `caps.f64` (written by the host from `prepareRaster`); outputs `rgba.bin` (u8 RGBA, logical size) and `depth.f32` (supersampled).

pub mod cpu;
#[cfg(feature = "gpu")]
pub mod gpu;

use llull_protocol::{sha256_hex, Output};
use serde::Deserialize;
use std::fs;
use std::path::Path;

/// Pixel rectangle (supersampled pixels, integer values).
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct Rect {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

/// Scalars of `job.json` (the TypeScript `PreparedRaster` without its arrays).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterJob {
    pub width: usize,
    pub height: usize,
    pub samples: usize,
    pub clip: Rect,
    pub ghost: bool,
    pub low: f64,
    pub step: f64,
    pub palette: Vec<f64>,
    pub jump: f64,
    pub show_mesh: bool,
    pub crease_cos: f64,
    /// `cpu` (default, bit-identical) or `gpu` (wgpu, needs the `gpu` feature and an adapter).
    #[serde(default)]
    pub engine: Engine,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    #[default]
    Cpu,
    Gpu,
}

/// A whole raster input: the job scalars and the per-face buffers.
#[derive(Debug, Clone, PartialEq)]
pub struct Prepared {
    pub width: usize,
    pub height: usize,
    pub samples: usize,
    pub clip: Rect,
    pub ghost: bool,
    pub ghost_triangles: Vec<f64>,
    pub triangles: Vec<f64>,
    pub light: Vec<f64>,
    pub normals: Vec<f64>,
    pub owners: Vec<f64>,
    pub caps: Vec<f64>,
    pub low: f64,
    pub step: f64,
    pub palette: Vec<f64>,
    pub jump: f64,
    pub show_mesh: bool,
    pub crease_cos: f64,
}

/// A raster job failure: stable code + message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RasterError {
    pub code: &'static str,
    pub message: String,
}

fn input_error(message: String) -> RasterError {
    RasterError { code: "NATIVE_JOB_INPUT", message }
}

fn read_f64(path: &Path) -> Result<Vec<f64>, RasterError> {
    let bytes = fs::read(path).map_err(|error| RasterError { code: "NATIVE_JOB_IO", message: format!("{}: {error}", path.display()) })?;
    if !bytes.len().is_multiple_of(8) {
        return Err(input_error(format!("{} is not a whole number of f64 values", path.display())));
    }
    Ok(bytes.chunks_exact(8).map(|c| f64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]])).collect())
}

/// Checks the buffer sizes against each other and the image size.
pub fn check(p: &Prepared) -> Result<(), RasterError> {
    let faces = p.light.len();
    if p.triangles.len() != faces * 12 || p.normals.len() != faces * 3 || p.owners.len() != faces || p.caps.len() != faces {
        return Err(input_error(format!("per-face buffers disagree with {faces} faces")));
    }
    if !p.ghost_triangles.len().is_multiple_of(6) || p.palette.is_empty() || !p.palette.len().is_multiple_of(3) {
        return Err(input_error("ghost triangles need 6 values each and the palette 3 per band".to_string()));
    }
    if p.width == 0 || p.height == 0 || p.samples == 0 || p.width * p.height * p.samples * p.samples > 64_000_000 {
        return Err(input_error(format!("image {} x {} at {}x supersampling is out of range", p.width, p.height, p.samples)));
    }
    let (w, h) = ((p.width * p.samples) as f64, (p.height * p.samples) as f64);
    if p.clip.left < 0.0 || p.clip.top < 0.0 || p.clip.right > w || p.clip.bottom > h {
        return Err(input_error("clip rectangle outside the supersampled image".to_string()));
    }
    Ok(())
}

/// Reads a job folder into a `Prepared` input and the requested engine.
pub fn read_job(folder: &Path) -> Result<(Prepared, Engine), RasterError> {
    let text = fs::read_to_string(folder.join("job.json"))
        .map_err(|error| RasterError { code: "NATIVE_JOB_IO", message: format!("job.json: {error}") })?;
    let job: RasterJob = serde_json::from_str(&text).map_err(|error| input_error(format!("job.json: {error}")))?;
    let prepared = Prepared {
        width: job.width,
        height: job.height,
        samples: job.samples,
        clip: job.clip,
        ghost: job.ghost,
        ghost_triangles: read_f64(&folder.join("ghost.f64"))?,
        triangles: read_f64(&folder.join("triangles.f64"))?,
        light: read_f64(&folder.join("light.f64"))?,
        normals: read_f64(&folder.join("normals.f64"))?,
        owners: read_f64(&folder.join("owners.f64"))?,
        caps: read_f64(&folder.join("caps.f64"))?,
        low: job.low,
        step: job.step,
        palette: job.palette,
        jump: job.jump,
        show_mesh: job.show_mesh,
        crease_cos: job.crease_cos,
    };
    check(&prepared)?;
    Ok((prepared, job.engine))
}

/// Which engine produced the image (reported as a warning event by the binary when the GPU was asked for but not used).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Produced {
    Cpu,
    Gpu { adapter: String },
    CpuFallback { reason: String },
}

fn render(prepared: &Prepared, engine: Engine) -> (Vec<u8>, Vec<f32>, Produced) {
    match engine {
        Engine::Cpu => {
            let (rgba, depth) = cpu::raster_pixels(prepared);
            (rgba, depth, Produced::Cpu)
        }
        Engine::Gpu => gpu_or_fallback(prepared),
    }
}

#[cfg(feature = "gpu")]
fn gpu_or_fallback(prepared: &Prepared) -> (Vec<u8>, Vec<f32>, Produced) {
    match gpu::raster_pixels(prepared) {
        Ok((rgba, depth, adapter)) => (rgba, depth, Produced::Gpu { adapter }),
        Err(reason) => {
            let (rgba, depth) = cpu::raster_pixels(prepared);
            (rgba, depth, Produced::CpuFallback { reason })
        }
    }
}

#[cfg(not(feature = "gpu"))]
fn gpu_or_fallback(prepared: &Prepared) -> (Vec<u8>, Vec<f32>, Produced) {
    let (rgba, depth) = cpu::raster_pixels(prepared);
    (rgba, depth, Produced::CpuFallback { reason: "llull-compute was built without the gpu feature".to_string() })
}

/// Runs `llull-compute raster <folder>`: writes `rgba.bin` and `depth.f32` and says which engine drew them.
pub fn run(folder: &Path) -> Result<(Vec<Output>, Produced), RasterError> {
    let (prepared, engine) = read_job(folder)?;
    let (rgba, depth, produced) = render(&prepared, engine);
    let depth_bytes: Vec<u8> = depth.iter().flat_map(|v| v.to_le_bytes()).collect();
    let mut outputs = Vec::new();
    for (name, bytes) in [("rgba.bin", rgba.as_slice()), ("depth.f32", depth_bytes.as_slice())] {
        let path = folder.join(name);
        fs::write(&path, bytes).map_err(|error| RasterError { code: "NATIVE_JOB_IO", message: format!("{}: {error}", path.display()) })?;
        outputs.push(Output { path: name.to_string(), sha256: sha256_hex(bytes) });
    }
    Ok((outputs, produced))
}

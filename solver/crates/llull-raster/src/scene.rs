//! Scene raster job of `llull-compute raster` (plant 09 VIS-M9, RS1 RS-5): the per-pixel stage of `render_view`, `render_walkthrough`
//! and BCF snapshots (`packages/core/src/commands/render/raster.ts` `rasterScenePixels`). `job.json` carries `"kind": "scene"` and the
//! scalars of a `RasterScene`; the flat buffers are little-endian f64 files `faces.f64` (8 per face), `fills.f64` (3 per fill),
//! `loops.f64` (2 per loop), `points.f64` (3 per point), `strokes.f64` (9 per segment). Output: `rgba.bin` (u8 RGBA, logical size).
//! The CPU twin (`scene_cpu`) is bit-identical to the TypeScript; the wgpu path (`scene_gpu`) is a picture.

use crate::{input_error, read_f64, Engine, Produced, RasterError};
use llull_protocol::{sha256_hex, Output};
use serde::Deserialize;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Projection {
    Orthographic,
    Perspective,
}

/// Scalars of a scene `job.json`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneJob {
    pub width: usize,
    pub height: usize,
    pub samples: usize,
    pub projection: Projection,
    pub depth_jump: f64,
    pub crease_cos: f64,
    #[serde(default)]
    pub engine: Engine,
}

/// A whole scene: the job scalars and the flat buffers (layouts in the module doc).
#[derive(Debug, Clone, PartialEq)]
pub struct Scene {
    pub width: usize,
    pub height: usize,
    pub samples: usize,
    pub projection: Projection,
    pub depth_jump: f64,
    pub crease_cos: f64,
    pub faces: Vec<f64>,
    pub fills: Vec<f64>,
    pub loops: Vec<f64>,
    pub points: Vec<f64>,
    pub strokes: Vec<f64>,
}

impl Scene {
    /// Supersampled buffer size.
    pub fn buffer_size(&self) -> (usize, usize) {
        (self.width * self.samples, self.height * self.samples)
    }
}

fn index_ok(value: f64, limit: usize) -> bool {
    value >= 0.0 && value.fract() == 0.0 && (value as usize) < limit
}

/// `first .. first + count` is a whole-number range inside `0 .. limit`.
fn range_ok(first: f64, count: f64, limit: usize) -> bool {
    first >= 0.0 && count >= 0.0 && first.fract() == 0.0 && count.fract() == 0.0 && first + count <= limit as f64
}

/// Checks buffer shapes and every index (face, loop, point) against its table.
pub fn check(scene: &Scene) -> Result<(), RasterError> {
    let s = scene;
    if !s.faces.len().is_multiple_of(8)
        || !s.fills.len().is_multiple_of(3)
        || !s.loops.len().is_multiple_of(2)
        || !s.points.len().is_multiple_of(3)
        || !s.strokes.len().is_multiple_of(9)
    {
        return Err(input_error("scene buffers are not whole records (8 / 3 / 2 / 3 / 9 values)".to_string()));
    }
    if s.width == 0 || s.height == 0 || s.samples == 0 || s.width * s.height * s.samples * s.samples > 64_000_000 {
        return Err(input_error(format!("image {} x {} at {}x supersampling is out of range", s.width, s.height, s.samples)));
    }
    let (faces, loops, points) = (s.faces.len() / 8, s.loops.len() / 2, s.points.len() / 3);
    if s.fills.chunks_exact(3).any(|fill| !index_ok(fill[0], faces) || !range_ok(fill[1], fill[2], loops)) {
        return Err(input_error("a fill references a face or loops out of range".to_string()));
    }
    if s.loops.chunks_exact(2).any(|range| !range_ok(range[0], range[1], points)) {
        return Err(input_error("a loop references points out of range".to_string()));
    }
    if s.strokes.chunks_exact(9).any(|segment| !index_ok(segment[0], faces)) {
        return Err(input_error("a stroke references a face out of range".to_string()));
    }
    Ok(())
}

/// Reads a scene job folder into a `Scene` and the requested engine.
pub fn read_scene_job(folder: &Path, text: &str) -> Result<(Scene, Engine), RasterError> {
    let job: SceneJob = serde_json::from_str(text).map_err(|error| input_error(format!("job.json: {error}")))?;
    let scene = Scene {
        width: job.width,
        height: job.height,
        samples: job.samples,
        projection: job.projection,
        depth_jump: job.depth_jump,
        crease_cos: job.crease_cos,
        faces: read_f64(&folder.join("faces.f64"))?,
        fills: read_f64(&folder.join("fills.f64"))?,
        loops: read_f64(&folder.join("loops.f64"))?,
        points: read_f64(&folder.join("points.f64"))?,
        strokes: read_f64(&folder.join("strokes.f64"))?,
    };
    check(&scene)?;
    Ok((scene, job.engine))
}

/// RGBA of the scene with the requested engine (GPU falls back to the CPU twin with the reason).
pub fn render(scene: &Scene, engine: Engine) -> (Vec<u8>, Produced) {
    match engine {
        Engine::Cpu => (crate::scene_cpu::raster_pixels(scene), Produced::Cpu),
        Engine::Gpu => gpu_or_fallback(scene),
    }
}

#[cfg(feature = "gpu")]
fn gpu_or_fallback(scene: &Scene) -> (Vec<u8>, Produced) {
    match crate::scene_gpu::raster_pixels(scene) {
        Ok((rgba, adapter)) => (rgba, Produced::Gpu { adapter }),
        Err(reason) => (crate::scene_cpu::raster_pixels(scene), Produced::CpuFallback { reason }),
    }
}

#[cfg(not(feature = "gpu"))]
fn gpu_or_fallback(scene: &Scene) -> (Vec<u8>, Produced) {
    let reason = "llull-compute was built without the gpu feature".to_string();
    (crate::scene_cpu::raster_pixels(scene), Produced::CpuFallback { reason })
}

/// Runs a scene job: writes `rgba.bin` and says which engine drew it.
pub fn run(folder: &Path, text: &str) -> Result<(Vec<Output>, Produced), RasterError> {
    let (scene, engine) = read_scene_job(folder, text)?;
    let (rgba, produced) = render(&scene, engine);
    let path = folder.join("rgba.bin");
    fs::write(&path, &rgba).map_err(|error| RasterError { code: "NATIVE_JOB_IO", message: format!("{}: {error}", path.display()) })?;
    Ok((vec![Output { path: "rgba.bin".to_string(), sha256: sha256_hex(&rgba) }], produced))
}

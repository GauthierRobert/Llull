//! `llull-compute pathtrace <job-folder>`: the realistic renderer of `render_realistic` (RV1 RV-M3; wire contract RV1 §5b).
//!
//! A unidirectional path tracer on the CPU: two-level BVH (one binned-SAH BLAS per mesh, a TLAS over the instances, never expanded),
//! next-event estimation to every light, the emissive triangles (`emitters`) and the environment map with MIS (`integrator`), a GGX metal-roughness BSDF with clear coat and
//! rough transmission (`bsdf`), Preetham sky / HDR / uniform environments (`env`, `sky`), thin-lens camera (`camera`), counter-based
//! random numbers (`rng`: the image is a pure function of the job and the seed, whatever the thread count), tiled adaptive sampling with
//! a time budget (`render`), an à-trous denoiser (`denoise`: OpenImageDenoise is not bundled; this edge-avoiding wavelet filter guided
//! by albedo, normal, depth and variance is the documented substitute), OpenEXR + AgX PNG output (`files`, `tonemap`).
//!
//! Engine `gpu` (`engine`): with the cargo feature `gpu` a wgpu compute twin of the integrator renders (`gpu`, `stats.device` the
//! adapter name, `deterministic` false); without the feature, an adapter or room on the device the CPU renders and the result says so
//! (`stats.device` "cpu", `fallbackReason`, warning `PATHTRACE_GPU_FALLBACK`). Outputs: `image.png`, `beauty.exr`, `stats.json`.

pub mod albedo;
pub mod bsdf;
pub mod bvh;
pub mod camera;
pub mod denoise;
pub mod emitters;
pub mod engine;
pub mod env;
pub mod files;
#[cfg(feature = "gpu")]
pub mod gpu;
pub mod integrator;
pub mod job;
pub mod lights;
mod lights_load;
pub mod load;
pub mod material;
pub mod math;
pub mod microfacet;
pub mod render;
pub mod rng;
pub mod scene;
pub mod sky;
pub mod texture;
pub mod tonemap;

use crate::files::{write_exr, write_png, HashingWriter};
use crate::render::{StoppedBy, DENOISE_MAX_PIXELS};
use llull_protocol::{emit, sha256_hex, Event, Output};
use serde::Serialize;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

/// A job failure: stable code + message naming the field or file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathTraceError {
    pub code: &'static str,
    pub message: String,
}

/// `stats.json` (RV1 §5b) plus `fallbackReason` when the GPU was asked for.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    /// Mean samples per pixel.
    pub samples: f64,
    pub seed: u32,
    pub device: String,
    pub deterministic: bool,
    pub elapsed_ms: f64,
    /// RMS relative standard error of the pixel means (see `render`); null below 2 samples.
    pub noise: Option<f64>,
    pub denoised: bool,
    /// Triangles stored in the meshes (instances not expanded).
    pub triangles: u64,
    pub instances: u64,
    pub stopped_by: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<String>,
}

/// A warning for the host (`warning` event).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Warning {
    pub code: &'static str,
    pub message: String,
}

/// What a render produced: the stats, the warnings, and the image (for tests and the binary).
#[derive(Debug, Clone)]
pub struct Rendered {
    pub stats: Stats,
    pub warnings: Vec<Warning>,
    pub image: render::Image,
}

/// Renders a loaded job (no files written).
pub fn render_job(job: &load::Job) -> Rendered {
    render_job_with(job, &engine::GpuAccess::Probe)
}

/// [`render_job`] with the GPU access decided by the caller (tests force the CPU fallback).
pub fn render_job_with(job: &load::Job, access: &engine::GpuAccess) -> Rendered {
    let settings = &job.settings;
    let mut warnings = Vec::new();
    let pixels = u64::from(settings.width) * u64::from(settings.height);
    let denoise = settings.denoise && pixels <= DENOISE_MAX_PIXELS;
    if settings.denoise && !denoise {
        warnings.push(Warning {
            code: "PATHTRACE_DENOISE_SKIPPED",
            message: format!(
                "{} x {} px is over the denoiser's {DENOISE_MAX_PIXELS} px memory limit; the beauty is not denoised",
                settings.width, settings.height
            ),
        });
    }
    if let Some(count) = job.world.emitters.over_cap {
        warnings.push(Warning {
            code: "PATHTRACE_EMITTER_LIMIT",
            message: format!(
                "{count} emissive triangles are over the {} light-sampled limit: their emission is only seen where paths hit it (noisier)",
                emitters::MAX_EMITTERS
            ),
        });
    }
    let engine::Produced { mut image, stats, device, fallback_reason } = engine::produce(job, denoise, access);
    if let Some(reason) = &fallback_reason {
        warnings.push(Warning { code: "PATHTRACE_GPU_FALLBACK", message: reason.clone() });
    }
    if stats.stopped_by == StoppedBy::Time {
        warnings.push(Warning {
            code: "PATHTRACE_TIME_LIMIT",
            message: format!("maxSeconds reached after {:.1} mean samples per pixel: the image is not deterministic", stats.mean_samples),
        });
    }
    if denoise {
        denoise::denoise(&mut image);
    }
    let stats = Stats {
        samples: stats.mean_samples,
        seed: settings.seed,
        deterministic: stats.stopped_by != StoppedBy::Time && device == "cpu",
        device,
        elapsed_ms: stats.elapsed.as_secs_f64() * 1000.0,
        noise: stats.noise,
        denoised: denoise,
        triangles: job.world.geometry.triangle_count() as u64,
        instances: job.world.geometry.instances.len() as u64,
        stopped_by: stats.stopped_by.name(),
        fallback_reason,
    };
    Rendered { stats, warnings, image }
}

fn output_error(name: &str, error: std::io::Error) -> PathTraceError {
    PathTraceError { code: "PATHTRACE_OUTPUT_IO", message: format!("{name}: {error}") }
}

fn write_streamed(
    folder: &Path,
    name: &str,
    write: impl FnOnce(&mut HashingWriter<BufWriter<File>>) -> std::io::Result<()>,
) -> Result<Output, PathTraceError> {
    let file = File::create(folder.join(name)).map_err(|error| output_error(name, error))?;
    let mut writer = HashingWriter::new(BufWriter::with_capacity(1 << 20, file));
    write(&mut writer).map_err(|error| output_error(name, error))?;
    writer.flush().map_err(|error| output_error(name, error))?;
    Ok(Output { path: name.to_string(), sha256: writer.hex() })
}

/// Writes `image.png` / `beauty.exr` (as the job asks) and `stats.json`; returns their outputs.
pub fn write_outputs(folder: &Path, job: &load::Job, rendered: &Rendered) -> Result<Vec<Output>, PathTraceError> {
    let mut outputs = Vec::new();
    if job.settings.png {
        outputs.push(write_streamed(folder, "image.png", |w| write_png(w, &rendered.image, job.settings.exposure))?);
    }
    if job.settings.exr {
        outputs.push(write_streamed(folder, "beauty.exr", |w| write_exr(w, &rendered.image))?);
    }
    let stats = serde_json::to_vec_pretty(&rendered.stats).map_err(|error| output_error("stats.json", std::io::Error::other(error)))?;
    std::fs::write(folder.join("stats.json"), &stats).map_err(|error| output_error("stats.json", error))?;
    outputs.push(Output { path: "stats.json".to_string(), sha256: sha256_hex(&stats) });
    Ok(outputs)
}

fn progress(out: &mut impl Write, step: u64, message: &str) {
    let _ = emit(out, &Event::Progress { step, total: 3, message, detail: None });
}

/// Runs `llull-compute pathtrace <folder>`: progress and warning events on `out`, the outputs for the `done` event.
pub fn run(folder: &Path, out: &mut impl Write) -> Result<Vec<Output>, PathTraceError> {
    let job = load::load(folder)?;
    progress(out, 1, "scene loaded");
    let rendered = render_job(&job);
    progress(out, 2, "rendered");
    for warning in &rendered.warnings {
        let _ = emit(out, &Event::Warning { code: warning.code, message: &warning.message });
    }
    let outputs = write_outputs(folder, &job, &rendered)?;
    progress(out, 3, "written");
    Ok(outputs)
}

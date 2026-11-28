//! The engine of a render (`engine` of the job): the CPU integrator, or with `engine: "gpu"` the wgpu path tracer (cargo feature
//! `gpu`, module `gpu`). When the GPU cannot render (a build without the feature, no adapter, `LLULL_GPU=off`, a scene over the
//! device limits, a device failure) the CPU renders and the reason is returned for `stats.fallbackReason` and the
//! `PATHTRACE_GPU_FALLBACK` warning.

use crate::job::Engine;
use crate::load::Job;
use crate::render::{render, Image, RenderStats};

/// Whether the GPU may be opened (tests force the fallback with `Unavailable`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GpuAccess {
    Probe,
    Unavailable(String),
}

/// A rendered image with the device that made it and, after a GPU request the CPU answered, the reason.
pub struct Produced {
    pub image: Image,
    pub stats: RenderStats,
    /// `cpu` or the GPU adapter's name.
    pub device: String,
    pub fallback_reason: Option<String>,
}

#[cfg(feature = "gpu")]
fn gpu_render(job: &Job, with_guides: bool) -> Result<Produced, String> {
    let rendered = crate::gpu::render(job, with_guides)?;
    Ok(Produced { image: rendered.image, stats: rendered.stats, device: rendered.device, fallback_reason: None })
}

#[cfg(not(feature = "gpu"))]
fn gpu_render(_job: &Job, _with_guides: bool) -> Result<Produced, String> {
    Err("no GPU path tracer in this build".to_string())
}

/// Renders on the job's engine (with the denoiser guides when `with_guides`).
pub fn produce(job: &Job, with_guides: bool, access: &GpuAccess) -> Produced {
    let fallback_reason = if job.settings.engine == Engine::Gpu {
        let attempt = match access {
            GpuAccess::Probe => gpu_render(job, with_guides),
            GpuAccess::Unavailable(reason) => Err(reason.clone()),
        };
        match attempt {
            Ok(produced) => return produced,
            Err(reason) => Some(format!("{reason}; rendered on the CPU")),
        }
    } else {
        None
    };
    let (image, stats) = render(job, with_guides);
    Produced { image, stats, device: "cpu".to_string(), fallback_reason }
}

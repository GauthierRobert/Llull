//! The GPU render loop: the image is cut into 256 x 256 px tiles rendered one after the other; each tile's accumulators (64 B/px,
//! 4 MiB) live on the GPU while its samples are added by submissions of `k` samples per pixel, `k` sized from the measured rate so a
//! submission takes about 100 ms (a driver watchdog never sees a long dispatch). `maxSeconds` stops the current tile at its next
//! submission and gives every later tile one sample (as the CPU's tiles); `targetNoise` is checked at the CPU's sample counts (16, 32,
//! 64, …) per 16 x 16 block with the CPU's formula, a converged block is masked off for the rest of its tile.

use super::pack::{self, Limits, Packed};
use crate::load::Job;
use crate::render::{to_half, Guides, Image, RenderStats, StoppedBy};
use half::f16;
use llull_gpu::buffers::{f32_bytes, read_f32, u32_bytes, uniform, STORAGE};
use llull_gpu::device::Gpu;
use llull_gpu::dot::{compute_pipeline, storage_entry, uniform_entry};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use wgpu::util::DeviceExt;

const SOURCES: [&str; 6] = [
    include_str!("common.wgsl"),
    include_str!("scene.wgsl"),
    include_str!("bsdf.wgsl"),
    include_str!("material.wgsl"),
    include_str!("lights.wgsl"),
    include_str!("integrator.wgsl"),
];
/// Tile side in pixels (the accumulator buffer covers one tile).
pub const TILE: u32 = 256;
const BLOCK: u32 = 16;
const ACC: usize = 16;
const BLOCKS: usize = ((TILE / BLOCK) * (TILE / BLOCK)) as usize;
const MASK_BASE: usize = (TILE * TILE) as usize * ACC;
const TARGET_SUBMISSION: f64 = 0.1;
const MAX_BATCH: u32 = 1024;
const MIN_NOISE_SAMPLES: u32 = 16;

/// What the GPU produced: the image (with the denoiser guides when asked), the stats and the adapter name.
pub struct GpuRender {
    pub image: Image,
    pub stats: RenderStats,
    pub device: String,
}

struct Pipeline {
    pipeline: wgpu::ComputePipeline,
    bind: wgpu::BindGroup,
    params: wgpu::Buffer,
    accum: wgpu::Buffer,
    errors: Arc<Mutex<Option<String>>>,
}

fn vec4_bytes(rows: &[[f32; 4]]) -> Vec<u8> {
    rows.iter().flatten().flat_map(|v| v.to_le_bytes()).collect()
}

fn storage(gpu: &Gpu, label: &str, mut bytes: Vec<u8>) -> wgpu::Buffer {
    bytes.resize(bytes.len().max(16), 0);
    gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some(label), contents: &bytes, usage: STORAGE })
}

fn pop_error(gpu: &Gpu) -> Option<String> {
    pollster::block_on(gpu.device.pop_error_scope()).map(|error| error.to_string())
}

impl Pipeline {
    fn new(gpu: &Gpu, packed: &Packed) -> Result<Pipeline, String> {
        gpu.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        gpu.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let entries: Vec<wgpu::BindGroupLayoutEntry> =
            std::iter::once(uniform_entry(0)).chain((1..=7).map(|binding| storage_entry(binding, binding != 7))).collect();
        let layout =
            gpu.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("llull-pathtrace"), entries: &entries });
        let pipeline = compute_pipeline(gpu, &SOURCES.concat(), "main", &layout);
        let params = uniform(gpu, "llull-pathtrace params", &[0u8; PARAM_WORDS * 4]);
        let buffers = [
            storage(gpu, "llull-pathtrace nodes", vec4_bytes(&packed.nodes)),
            storage(gpu, "llull-pathtrace words", u32_bytes(&packed.words)),
            storage(gpu, "llull-pathtrace verts", vec4_bytes(&packed.verts)),
            storage(gpu, "llull-pathtrace objects", vec4_bytes(&packed.objects)),
            storage(gpu, "llull-pathtrace ldr", u32_bytes(&packed.ldr)),
            storage(gpu, "llull-pathtrace hdr", f32_bytes(&packed.hdr)),
        ];
        let accum = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("llull-pathtrace accum"),
            size: ((MASK_BASE + BLOCKS) * 4) as u64,
            usage: STORAGE,
            mapped_at_creation: false,
        });
        let mut bind_entries = vec![wgpu::BindGroupEntry { binding: 0, resource: params.as_entire_binding() }];
        for (i, buffer) in buffers.iter().chain(std::iter::once(&accum)).enumerate() {
            bind_entries.push(wgpu::BindGroupEntry { binding: i as u32 + 1, resource: buffer.as_entire_binding() });
        }
        let bind = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("llull-pathtrace"),
            layout: &layout,
            entries: &bind_entries,
        });
        let validation = pop_error(gpu);
        let memory = pop_error(gpu);
        if let Some(error) = validation.or(memory) {
            return Err(format!("the GPU refused the path tracer ({error})"));
        }
        let errors = Arc::new(Mutex::new(None));
        let sink = Arc::clone(&errors);
        gpu.device.on_uncaptured_error(Box::new(move |error| {
            if let Ok(mut slot) = sink.lock() {
                slot.get_or_insert_with(|| error.to_string());
            }
        }));
        Ok(Pipeline { pipeline, bind, params, accum, errors })
    }

    fn failure(&self) -> Option<String> {
        self.errors.lock().ok().and_then(|slot| slot.clone())
    }

    /// Adds `samples` samples per active pixel of the tile and waits for the GPU.
    fn submit(&self, gpu: &Gpu, params: &[u8]) -> Result<(), String> {
        gpu.queue.write_buffer(&self.params, 0, params);
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("llull-pathtrace") });
        {
            let mut pass =
                encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("llull-pathtrace"), timestamp_writes: None });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.bind, &[]);
            pass.dispatch_workgroups(TILE / 8, TILE / 8, 1);
        }
        gpu.queue.submit([encoder.finish()]);
        gpu.device.poll(wgpu::PollType::Wait).map_err(|error| format!("GPU poll failed: {error}"))?;
        self.failure().map_or(Ok(()), |error| Err(format!("the GPU failed while rendering ({error})")))
    }
}

const PARAM_WORDS: usize = 28 + 24;

#[derive(Clone, Copy)]
struct TileRect {
    x0: u32,
    y0: u32,
    w: u32,
    h: u32,
}

fn params_bytes(job: &Job, layout: &pack::Layout, tile: TileRect, samples: u32) -> Vec<u8> {
    let s = &job.settings;
    let world = &job.world;
    let c = &world.camera;
    let projection = u32::from(c.projection == crate::job::Projection::Orthographic);
    let words = [
        s.width,
        s.height,
        tile.x0,
        tile.y0,
        tile.w,
        tile.h,
        samples,
        s.seed,
        s.max_bounces,
        world.lights.len() as u32,
        layout.tlas_nodes,
        layout.tlas_order,
        world.geometry.instances.len() as u32,
        layout.instance_base,
        layout.material_base,
        layout.light_base,
        layout.texture_base,
        world.materials.len() as u32,
        layout.env_kind,
        layout.env_texture,
        layout.env_marginal,
        layout.env_conditional,
        layout.env_rows,
        layout.srgb_table,
        projection,
        TILE / BLOCK,
        MASK_BASE as u32,
        layout.albedo_table,
    ];
    let v = |a: crate::math::Vec3, w: f32| [a.x, a.y, a.z, w];
    let floats = [
        layout.env_color,
        layout.env_rot,
        v(c.position, c.tan_half),
        v(c.forward, c.half_height),
        v(c.right, c.aperture),
        v(c.up, c.focus),
    ];
    let mut bytes = u32_bytes(&words);
    bytes.extend(vec4_bytes(&floats));
    bytes
}

/// Per-pixel accumulator view (the WGSL `ACC` words).
struct Pixel<'a>(&'a [f32]);

impl Pixel<'_> {
    fn n(&self) -> f64 {
        f64::from(self.0[13])
    }

    /// Variance of the pixel's mean luminance (s² / n).
    fn variance_of_mean(&self) -> f64 {
        let n = self.n();
        if n < 2.0 {
            return 0.0;
        }
        (f64::from(self.0[4]) / (n - 1.0)).max(0.0) / n
    }

    fn luminance_sum(&self) -> f64 {
        f64::from(self.0[3]) * self.n()
    }
}

fn pixel_of(acc: &[f32], tile: TileRect, lx: u32, ly: u32) -> Pixel<'_> {
    let start = ((ly * tile.w + lx) as usize) * ACC;
    Pixel(&acc[start..start + ACC])
}

/// Noise of one 16 x 16 block, the CPU's `tile_noise`.
fn block_noise(acc: &[f32], tile: TileRect, bx: u32, by: u32) -> f64 {
    let (mut variance, mut luminance, mut count, mut n) = (0.0f64, 0.0f64, 0.0f64, 1.0f64);
    for ly in by * BLOCK..((by + 1) * BLOCK).min(tile.h) {
        for lx in bx * BLOCK..((bx + 1) * BLOCK).min(tile.w) {
            let p = pixel_of(acc, tile, lx, ly);
            variance += p.variance_of_mean();
            luminance += p.luminance_sum();
            n = p.n();
            count += 1.0;
        }
    }
    let variance = variance / count;
    let mean = luminance / (count * n);
    if variance <= 0.0 {
        0.0
    } else {
        variance.sqrt() / mean.max(1e-12)
    }
}

/// Totals over the image for the stats (as the CPU's `render`).
#[derive(Default)]
struct Totals {
    samples: f64,
    variance: f64,
    luminance: f64,
    noise_stop: bool,
    timed_out: bool,
}

fn write_tile(image: &mut Image, acc: &[f32], tile: TileRect, totals: &mut Totals) {
    let width = image.width;
    for ly in 0..tile.h {
        for lx in 0..tile.w {
            let p = pixel_of(acc, tile, lx, ly);
            let index = ((tile.y0 + ly) * width + tile.x0 + lx) as usize;
            let n = p.n().max(1.0);
            let a = p.0;
            image.beauty[index] = [0, 1, 2].map(|k| to_half((f64::from(a[k]) / n) as f32));
            totals.samples += p.n();
            totals.variance += p.variance_of_mean();
            totals.luminance += p.luminance_sum() / n;
            if let Some(guides) = image.guides.as_mut() {
                let hits = f64::from(a[12]);
                guides.albedo[index] = [5, 6, 7].map(|k| to_half((f64::from(a[k]) / n) as f32));
                guides.normal[index] = [8, 9, 10].map(|k| to_half((f64::from(a[k]) / hits.max(1.0)) as f32));
                guides.depth[index] = if hits > 0.0 { (f64::from(a[11]) / hits) as f32 } else { f32::INFINITY };
                guides.variance[index] = p.variance_of_mean() as f32;
            }
        }
    }
}

/// Measured cost of one sample of one pixel, for sizing submissions.
struct Rate(Option<f64>);

impl Rate {
    fn batch(&self, pixels: u32, cap: u32) -> u32 {
        let k = self.0.map_or(1.0, |seconds| TARGET_SUBMISSION / (seconds * f64::from(pixels.max(1))));
        (k.floor() as u32).clamp(1, cap.clamp(1, MAX_BATCH))
    }

    fn record(&mut self, elapsed: Duration, pixels: u32, samples: u32) {
        let measured = elapsed.as_secs_f64() / (f64::from(pixels.max(1)) * f64::from(samples.max(1)));
        self.0 = Some(self.0.map_or(measured, |previous| 0.5 * (previous + measured)));
    }
}

/// The next sample count at which the CPU checks `targetNoise` (16, then powers of two).
fn next_checkpoint(done: u32) -> u32 {
    if done < MIN_NOISE_SAMPLES {
        MIN_NOISE_SAMPLES
    } else {
        (done + 1).next_power_of_two()
    }
}

struct Context<'a> {
    gpu: &'a Gpu,
    pipeline: &'a Pipeline,
    job: &'a Job,
    layout: pack::Layout,
    deadline: Option<Instant>,
}

impl Context<'_> {
    fn past_deadline(&self) -> bool {
        self.deadline.is_some_and(|d| Instant::now() >= d)
    }

    fn render_tile(&self, tile: TileRect, rate: &mut Rate, totals: &mut Totals) -> Result<Vec<f32>, String> {
        let settings = &self.job.settings;
        let blocks_x = tile.w.div_ceil(BLOCK);
        let mut mask = vec![0.0f32; BLOCKS];
        for by in 0..tile.h.div_ceil(BLOCK) {
            for bx in 0..blocks_x {
                mask[(by * (TILE / BLOCK) + bx) as usize] = 1.0;
            }
        }
        let mut initial = vec![0.0f32; MASK_BASE];
        initial.extend(&mask);
        self.gpu.queue.write_buffer(&self.pipeline.accum, 0, &f32_bytes(&initial));
        let pixels = tile.w * tile.h;
        let mut active_pixels = pixels;
        let late = self.past_deadline();
        let mut done = 0u32;
        loop {
            let remaining = settings.samples - done;
            let mut cap = if late { 1 } else { remaining };
            if settings.target_noise.is_some() {
                cap = cap.min(next_checkpoint(done).min(settings.samples) - done);
            }
            let k = rate.batch(active_pixels, cap);
            let started = Instant::now();
            self.pipeline.submit(self.gpu, &params_bytes(self.job, &self.layout, tile, k))?;
            rate.record(started.elapsed(), active_pixels, k);
            done += k;
            if done >= settings.samples {
                break;
            }
            if late || self.past_deadline() {
                totals.timed_out = true;
                break;
            }
            let Some(target) = settings.target_noise else { continue };
            if done < MIN_NOISE_SAMPLES || !done.is_power_of_two() {
                continue;
            }
            let acc = read_f32(self.gpu, &self.pipeline.accum, MASK_BASE)?;
            active_pixels = 0;
            for (i, active) in mask.iter_mut().enumerate() {
                let (bx, by) = (i as u32 % (TILE / BLOCK), i as u32 / (TILE / BLOCK));
                if *active > 0.5 && block_noise(&acc, tile, bx, by) <= f64::from(target) {
                    *active = 0.0;
                    totals.noise_stop = true;
                } else if *active > 0.5 {
                    active_pixels += BLOCK.min(tile.w - bx * BLOCK) * BLOCK.min(tile.h - by * BLOCK);
                }
            }
            if active_pixels == 0 {
                break;
            }
            self.gpu.queue.write_buffer(&self.pipeline.accum, (MASK_BASE * 4) as u64, &f32_bytes(&mask));
        }
        read_f32(self.gpu, &self.pipeline.accum, (pixels as usize) * ACC)
    }
}

/// Renders the job on the GPU, or returns why it cannot (no adapter, a limit exceeded, a device failure) for the CPU fallback.
pub fn render(job: &Job, with_guides: bool) -> Result<GpuRender, String> {
    let start = Instant::now();
    let gpu = llull_gpu::device::acquire("llull-pathtrace")?;
    let limits = gpu.device.limits();
    if limits.max_storage_buffers_per_shader_stage < 7 {
        return Err(format!(
            "the GPU offers {} storage buffers per shader, the path tracer needs 7",
            limits.max_storage_buffers_per_shader_stage
        ));
    }
    let max_binding = u64::from(limits.max_storage_buffer_binding_size).min(limits.max_buffer_size);
    pack::check(&job.world, Limits { max_binding })?;
    let packed = pack::pack(&job.world);
    let pipeline = Pipeline::new(&gpu, &packed)?;
    let settings = &job.settings;
    let pixels = settings.width as usize * settings.height as usize;
    let guides = with_guides.then(|| Guides {
        albedo: vec![[f16::ZERO; 3]; pixels],
        normal: vec![[f16::ZERO; 3]; pixels],
        depth: vec![0.0; pixels],
        variance: vec![0.0; pixels],
    });
    let mut image = Image { width: settings.width, height: settings.height, beauty: vec![[f16::ZERO; 3]; pixels], guides };
    let context = Context {
        gpu: &gpu,
        pipeline: &pipeline,
        job,
        layout: packed.layout,
        deadline: settings.max_seconds.map(|s| start + Duration::from_secs_f64(s)),
    };
    drop(packed);
    let mut rate = Rate(None);
    let mut totals = Totals::default();
    for y0 in (0..settings.height).step_by(TILE as usize) {
        for x0 in (0..settings.width).step_by(TILE as usize) {
            let tile = TileRect { x0, y0, w: TILE.min(settings.width - x0), h: TILE.min(settings.height - y0) };
            let acc = context.render_tile(tile, &mut rate, &mut totals)?;
            write_tile(&mut image, &acc, tile, &mut totals);
        }
    }
    let stopped_by = if totals.timed_out {
        StoppedBy::Time
    } else if totals.noise_stop {
        StoppedBy::Noise
    } else {
        StoppedBy::Samples
    };
    let mean_samples = totals.samples / pixels as f64;
    let noise = (mean_samples >= 2.0).then(|| {
        if totals.variance > 0.0 {
            (totals.variance / pixels as f64).sqrt() / (totals.luminance / pixels as f64).max(1e-12)
        } else {
            0.0
        }
    });
    let stats = RenderStats { mean_samples, noise, stopped_by, elapsed: start.elapsed() };
    Ok(GpuRender { image, stats, device: gpu.name.clone() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkpoints_follow_the_cpu_and_batches_stay_in_bounds() {
        assert_eq!([0, 15, 16, 17, 32, 33].map(next_checkpoint), [16, 16, 32, 32, 64, 64]);
        let mut rate = Rate(None);
        assert_eq!(rate.batch(65_536, 100), 1);
        rate.record(Duration::from_millis(10), 65_536, 1);
        assert_eq!(rate.batch(65_536, 100), 10);
        assert_eq!(rate.batch(65_536, 4), 4);
        assert_eq!(rate.batch(65_536, 0), 1);
    }
}

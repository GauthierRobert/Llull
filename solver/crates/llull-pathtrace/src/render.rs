//! Tiled rendering: 16 x 16 px tiles in parallel (rayon), each tile sampled in batches with its own adaptive stop, written into the
//! half-float image under a lock (disjoint rectangles, so the result does not depend on the order). Memory: the beauty is RGB half
//! (6 B/px, 403 MB at 8192²); the denoiser guides (albedo, normal half, depth and variance f32: 20 B/px) exist only when denoising.
//!
//! Adaptive stop (`targetNoise`): at every power-of-two sample count ≥ 16 a tile computes
//! `noise = sqrt(mean over its pixels of s²/n) / mean luminance` (s² the sample variance of a pixel's luminance, n its samples: the RMS
//! standard error of the pixel means relative to the tile's brightness) and stops once `noise <= targetNoise`. It depends only on the
//! tile's own samples, so it is deterministic. `maxSeconds` stops each tile at its next batch boundary (≤ 16 samples) after the deadline;
//! tiles started after it take one sample. Only that time stop makes the image depend on the machine.

use crate::integrator::{camera_ray, radiance};
use crate::load::Job;
use crate::rng::Sampler;
use half::f16;
use rayon::prelude::*;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const TILE: u32 = 16;
/// Largest image the denoiser runs on (its buffers: ~36 B/px).
pub const DENOISE_MAX_PIXELS: u64 = 4096 * 4096;
const BATCH: u32 = 16;
const MAX_HALF: f32 = 65504.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoppedBy {
    Samples,
    Noise,
    Time,
}

impl StoppedBy {
    pub fn name(self) -> &'static str {
        match self {
            StoppedBy::Samples => "samples",
            StoppedBy::Noise => "noise",
            StoppedBy::Time => "time",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Guides {
    pub albedo: Vec<[f16; 3]>,
    pub normal: Vec<[f16; 3]>,
    pub depth: Vec<f32>,
    /// Variance of each pixel's mean luminance (s² / n).
    pub variance: Vec<f32>,
}

#[derive(Debug, Clone)]
pub struct Image {
    pub width: u32,
    pub height: u32,
    pub beauty: Vec<[f16; 3]>,
    pub guides: Option<Guides>,
}

#[derive(Debug, Clone)]
pub struct RenderStats {
    pub mean_samples: f64,
    pub noise: Option<f64>,
    pub stopped_by: StoppedBy,
    pub elapsed: Duration,
}

#[derive(Default, Clone, Copy)]
struct Accumulator {
    rgb: [f64; 3],
    lum: f64,
    lum2: f64,
    albedo: [f64; 3],
    normal: [f64; 3],
    depth: f64,
    hits: u32,
}

impl Accumulator {
    fn variance_of_mean(&self, n: u32) -> f64 {
        if n < 2 {
            return 0.0;
        }
        let n = f64::from(n);
        ((self.lum2 - self.lum * self.lum / n) / (n - 1.0)).max(0.0) / n
    }
}

struct TileResult {
    samples: u64,
    variance_sum: f64,
    luminance_sum: f64,
    stopped: StoppedBy,
}

pub fn to_half(v: f32) -> f16 {
    f16::from_f32(if v.is_finite() { v.clamp(-MAX_HALF, MAX_HALF) } else { 0.0 })
}

fn tile_noise(acc: &[Accumulator], n: u32) -> f64 {
    let count = acc.len() as f64;
    let variance: f64 = acc.iter().map(|a| a.variance_of_mean(n)).sum::<f64>() / count;
    let mean: f64 = acc.iter().map(|a| a.lum).sum::<f64>() / (count * f64::from(n));
    if variance <= 0.0 {
        0.0
    } else {
        variance.sqrt() / mean.max(1e-12)
    }
}

fn next_stop(done: u32, samples: u32) -> u32 {
    if done < BATCH {
        return BATCH.min(samples);
    }
    let pow2 = (done + 1).next_power_of_two();
    pow2.min(done + BATCH).min(samples)
}

struct Shared<'a> {
    job: &'a Job,
    image: &'a Mutex<Image>,
    deadline: Option<Instant>,
    timed_out: &'a AtomicBool,
}

fn render_tile(shared: &Shared<'_>, x0: u32, y0: u32) -> TileResult {
    let settings = &shared.job.settings;
    let world = &shared.job.world;
    let (w, h) = (TILE.min(settings.width - x0), TILE.min(settings.height - y0));
    let mut acc = vec![Accumulator::default(); (w * h) as usize];
    let mut done = 0u32;
    let mut stopped = StoppedBy::Samples;
    let past_deadline = || shared.deadline.is_some_and(|d| Instant::now() >= d);
    loop {
        let next = if done == 0 && past_deadline() { 1 } else { next_stop(done, settings.samples) };
        for ly in 0..h {
            for lx in 0..w {
                let (x, y) = (x0 + lx, y0 + ly);
                let pixel = u64::from(y) * u64::from(settings.width) + u64::from(x);
                let a = &mut acc[(ly * w + lx) as usize];
                for s in done..next {
                    let mut sampler = Sampler::new(settings.seed, pixel, u64::from(s));
                    let (origin, direction) = camera_ray(&world.camera, x, y, &mut sampler);
                    let (mut l, first) = radiance(world, origin, direction, &mut sampler, settings.max_bounces);
                    if !l.is_finite() {
                        l = crate::math::Vec3::ZERO;
                    }
                    a.rgb[0] += f64::from(l.x);
                    a.rgb[1] += f64::from(l.y);
                    a.rgb[2] += f64::from(l.z);
                    let lum = f64::from(l.luminance());
                    a.lum += lum;
                    a.lum2 += lum * lum;
                    if first.depth.is_finite() {
                        a.hits += 1;
                        a.depth += f64::from(first.depth);
                        for (k, (albedo, normal)) in a.albedo.iter_mut().zip(a.normal.iter_mut()).enumerate() {
                            *albedo += f64::from(first.albedo[k]);
                            *normal += f64::from(first.normal[k]);
                        }
                    } else {
                        a.albedo.iter_mut().for_each(|v| *v += 1.0);
                    }
                }
            }
        }
        done = next;
        if done >= settings.samples {
            break;
        }
        if past_deadline() {
            stopped = StoppedBy::Time;
            shared.timed_out.store(true, Ordering::Relaxed);
            break;
        }
        if let Some(target) = settings.target_noise {
            if done >= BATCH && done.is_power_of_two() && tile_noise(&acc, done) <= f64::from(target) {
                stopped = StoppedBy::Noise;
                break;
            }
        }
    }
    write_tile(shared, x0, y0, w, &acc, done);
    let variance_sum = acc.iter().map(|a| a.variance_of_mean(done)).sum();
    let luminance_sum = acc.iter().map(|a| a.lum / f64::from(done)).sum();
    TileResult { samples: u64::from(done) * u64::from(w * h), variance_sum, luminance_sum, stopped }
}

fn write_tile(shared: &Shared<'_>, x0: u32, y0: u32, w: u32, acc: &[Accumulator], n: u32) {
    let mut image = shared.image.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let width = image.width;
    let inv = 1.0 / f64::from(n);
    for (i, a) in acc.iter().enumerate() {
        let (lx, ly) = (i as u32 % w, i as u32 / w);
        let index = ((y0 + ly) * width + x0 + lx) as usize;
        image.beauty[index] = [to_half((a.rgb[0] * inv) as f32), to_half((a.rgb[1] * inv) as f32), to_half((a.rgb[2] * inv) as f32)];
        if let Some(guides) = image.guides.as_mut() {
            guides.albedo[index] = a.albedo.map(|v| to_half((v * inv) as f32));
            let hits = f64::from(a.hits.max(1));
            guides.normal[index] = a.normal.map(|v| to_half((v / hits) as f32));
            guides.depth[index] = if a.hits > 0 { (a.depth / hits) as f32 } else { f32::INFINITY };
            guides.variance[index] = a.variance_of_mean(n) as f32;
        }
    }
}

/// Renders the job's image (and the denoiser guides when `with_guides`).
pub fn render(job: &Job, with_guides: bool) -> (Image, RenderStats) {
    let start = Instant::now();
    let settings = &job.settings;
    let pixels = settings.width as usize * settings.height as usize;
    let guides = with_guides.then(|| Guides {
        albedo: vec![[f16::ZERO; 3]; pixels],
        normal: vec![[f16::ZERO; 3]; pixels],
        depth: vec![0.0; pixels],
        variance: vec![0.0; pixels],
    });
    let image = Mutex::new(Image { width: settings.width, height: settings.height, beauty: vec![[f16::ZERO; 3]; pixels], guides });
    let timed_out = AtomicBool::new(false);
    let deadline = settings.max_seconds.map(|s| start + Duration::from_secs_f64(s));
    let shared = Shared { job, image: &image, deadline, timed_out: &timed_out };
    let tiles: Vec<(u32, u32)> = (0..settings.height.div_ceil(TILE))
        .flat_map(|ty| (0..settings.width.div_ceil(TILE)).map(move |tx| (tx * TILE, ty * TILE)))
        .collect();
    let results: Vec<TileResult> = tiles.par_iter().map(|&(x0, y0)| render_tile(&shared, x0, y0)).collect();
    let samples: u64 = results.iter().map(|r| r.samples).sum();
    let variance: f64 = results.iter().map(|r| r.variance_sum).sum();
    let luminance: f64 = results.iter().map(|r| r.luminance_sum).sum();
    let stopped_by = if timed_out.load(Ordering::Relaxed) {
        StoppedBy::Time
    } else if results.iter().any(|r| r.stopped == StoppedBy::Noise) {
        StoppedBy::Noise
    } else {
        StoppedBy::Samples
    };
    let mean_samples = samples as f64 / pixels as f64;
    let noise = (mean_samples >= 2.0).then(|| {
        if variance > 0.0 {
            (variance / pixels as f64).sqrt() / (luminance / pixels as f64).max(1e-12)
        } else {
            0.0
        }
    });
    let image = image.into_inner().unwrap_or_else(|poisoned| poisoned.into_inner());
    (image, RenderStats { mean_samples, noise, stopped_by, elapsed: start.elapsed() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batches_stop_at_powers_of_two_and_at_the_total() {
        let mut stops = Vec::new();
        let mut done = 0;
        while done < 100 {
            done = next_stop(done, 100);
            stops.push(done);
        }
        assert_eq!(stops, [16, 32, 48, 64, 80, 96, 100]);
        assert_eq!(next_stop(0, 3), 3);
    }
}

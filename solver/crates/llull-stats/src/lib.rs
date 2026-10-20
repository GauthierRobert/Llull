//! Monte Carlo stack-up job of `llull-compute stats` (aerospace 03 GDT TR-GDT-22, RS1 RS-7).
//!
//! Sample i draws contributor k from Philox4x32-10 counter (i mod 2^32, ⌊i/2^32⌋, ⌊k/2⌋, 0) under the key of the seed, so a sample does
//! not depend on any other. Statistics are reduced per chunk of [`CHUNK`] samples (sum, then squared deviations from the chunk mean) and
//! the chunks are merged in index order (Chan et al.), exactly as `packages/core/src/lib/stackupSampling.ts` does: the result is
//! bit-identical for any thread count, and bit-identical to TypeScript for every program without a trigonometric function.
//!
//! Job folder: `job.json` = `{ samples, seed, contributors: [{ centre, half, sigma, distribution }], program, lowerSpecLimit?,
//! upperSpecLimit? }`; output `stats.json` = `{ samples, mean, std, min, max, below, above, nonFinite, chunks, threads }`.

pub mod philox;
pub mod program;

use llull_protocol::{emit, sha256_hex, Event, Output};
use philox::{box_muller, key_of, philox4x32, unit_uniform};
use program::{Program, Step};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::Path;

/// Samples per reduction chunk (the TS `STACKUP_CHUNK`).
pub const CHUNK: u64 = 4096;
/// Chunks reduced in parallel between two progress events (bounds memory to one `Stats` per chunk of a block).
const BLOCK_CHUNKS: u64 = 16_384;
/// Native sample cap (TR-GDT-22): 2^40 samples keeps every chunk count and Chan product exact in f64.
pub const MAX_SAMPLES: u64 = 1 << 40;
const MAX_CONTRIBUTORS: usize = 64;

/// A job failure: stable code + message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobError {
    pub code: &'static str,
    pub message: String,
}

fn input_error(message: String) -> JobError {
    JobError { code: "NATIVE_JOB_INPUT", message }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Distribution {
    Normal,
    Uniform,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Contributor {
    pub centre: f64,
    pub half: f64,
    pub sigma: f64,
    pub distribution: Distribution,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsJob {
    pub samples: u64,
    pub seed: u64,
    pub contributors: Vec<Contributor>,
    pub program: Vec<Step>,
    pub lower_spec_limit: Option<f64>,
    pub upper_spec_limit: Option<f64>,
}

/// Statistics of a run (the TS `SamplingStats` plus run metadata).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub samples: u64,
    pub mean: f64,
    pub std: f64,
    pub min: f64,
    pub max: f64,
    pub below: u64,
    pub above: u64,
    pub non_finite: u64,
    pub chunks: u64,
    pub threads: usize,
}

#[derive(Debug, Clone, Copy)]
struct Partial {
    n: f64,
    mean: f64,
    m2: f64,
    min: f64,
    max: f64,
    below: u64,
    above: u64,
    non_finite: u64,
}

/// Chan et al. pairwise merge of `b` into `a` (the TS `merge`, same operation order).
fn merge(a: Partial, b: Partial) -> Partial {
    let n = a.n + b.n;
    let delta = b.mean - a.mean;
    Partial {
        n,
        mean: a.mean + delta * (b.n / n),
        m2: a.m2 + b.m2 + delta * delta * ((a.n * b.n) / n),
        min: if b.min < a.min { b.min } else { a.min },
        max: if b.max > a.max { b.max } else { a.max },
        below: a.below + b.below,
        above: a.above + b.above,
        non_finite: a.non_finite + b.non_finite,
    }
}

struct Sampler<'a> {
    job: &'a StatsJob,
    program: Program,
    key: [u32; 2],
}

impl Sampler<'_> {
    fn draw(&self, index: u64, x: &mut [f64]) {
        let (low, high) = (index as u32, (index >> 32) as u32);
        let mut words = [0u32; 4];
        for (k, contributor) in self.job.contributors.iter().enumerate() {
            let odd = k & 1;
            if odd == 0 {
                words = philox4x32([low, high, (k >> 1) as u32, 0], self.key);
            }
            let w1 = words[2 * odd];
            x[k] = match contributor.distribution {
                Distribution::Normal => contributor.centre + contributor.sigma * box_muller(w1, words[2 * odd + 1]),
                Distribution::Uniform => contributor.centre + contributor.half * (2.0 * unit_uniform(w1) - 1.0),
            };
        }
    }

    fn chunk(&self, chunk: u64) -> Partial {
        let start = chunk * CHUNK;
        let end = (start + CHUNK).min(self.job.samples);
        let mut x = vec![0.0; self.job.contributors.len()];
        let mut stack = self.program.stack();
        let mut values = Vec::with_capacity((end - start) as usize);
        let (mut sum, mut min, mut max) = (0.0, f64::INFINITY, f64::NEG_INFINITY);
        let (mut below, mut above, mut non_finite) = (0u64, 0u64, 0u64);
        for index in start..end {
            self.draw(index, &mut x);
            let y = self.program.evaluate(&x, &mut stack);
            values.push(y);
            if !y.is_finite() {
                non_finite += 1;
            }
            sum += y;
            if y < min {
                min = y;
            }
            if y > max {
                max = y;
            }
            if self.job.lower_spec_limit.is_some_and(|limit| y < limit) {
                below += 1;
            }
            if self.job.upper_spec_limit.is_some_and(|limit| y > limit) {
                above += 1;
            }
        }
        let n = (end - start) as f64;
        let mean = sum / n;
        let mut m2 = 0.0;
        for y in &values {
            let d = y - mean;
            m2 += d * d;
        }
        Partial { n, mean, m2, min, max, below, above, non_finite }
    }
}

fn validate(job: &StatsJob) -> Result<Program, JobError> {
    if job.samples < 2 || job.samples > MAX_SAMPLES {
        return Err(input_error(format!("samples {} outside 2..{MAX_SAMPLES}", job.samples)));
    }
    if job.seed > (1 << 53) - 1 {
        return Err(input_error("seed must be below 2^53".to_string()));
    }
    if job.contributors.is_empty() || job.contributors.len() > MAX_CONTRIBUTORS {
        return Err(input_error(format!("1..{MAX_CONTRIBUTORS} contributors expected")));
    }
    if job.contributors.iter().any(|c| !(c.centre.is_finite() && c.half.is_finite() && c.sigma.is_finite())) {
        return Err(input_error("contributor values must be finite".to_string()));
    }
    Program::compile(&job.program, job.contributors.len()).map_err(input_error)
}

/// Runs the Monte Carlo; `progress(done_chunks, total_chunks)` is called after every block.
pub fn sample(job: &StatsJob, mut progress: impl FnMut(u64, u64)) -> Result<Stats, JobError> {
    let program = validate(job)?;
    let sampler = Sampler { job, program, key: key_of(job.seed) };
    let chunks = job.samples.div_ceil(CHUNK);
    let mut total: Option<Partial> = None;
    let mut first = 0u64;
    while first < chunks {
        let last = (first + BLOCK_CHUNKS).min(chunks);
        let partials: Vec<Partial> = (first..last).into_par_iter().map(|chunk| sampler.chunk(chunk)).collect();
        for partial in partials {
            total = Some(match total {
                None => partial,
                Some(running) => merge(running, partial),
            });
        }
        progress(last, chunks);
        first = last;
    }
    let t = total.ok_or_else(|| input_error("no samples".to_string()))?;
    Ok(Stats {
        samples: job.samples,
        mean: t.mean,
        std: (t.m2 / (t.n - 1.0)).sqrt(),
        min: t.min,
        max: t.max,
        below: t.below,
        above: t.above,
        non_finite: t.non_finite,
        chunks,
        threads: rayon::current_num_threads(),
    })
}

/// Runs `llull-compute stats <folder>`: reads `job.json`, writes `stats.json`, one `progress` event per block of chunks.
pub fn run(folder: &Path, out: &mut impl Write) -> Result<Vec<Output>, JobError> {
    let path = folder.join("job.json");
    let text =
        fs::read_to_string(&path).map_err(|error| JobError { code: "NATIVE_JOB_IO", message: format!("{}: {error}", path.display()) })?;
    let job: StatsJob = serde_json::from_str(&text).map_err(|error| input_error(format!("job.json: {error}")))?;
    let stats = sample(&job, |done, total| {
        let _ = emit(out, &Event::Progress { step: done, total, message: "chunks sampled", detail: None });
    })?;
    let bytes = serde_json::to_vec(&stats).map_err(|error| input_error(error.to_string()))?;
    let output = folder.join("stats.json");
    fs::write(&output, &bytes).map_err(|error| JobError { code: "NATIVE_JOB_IO", message: format!("{}: {error}", output.display()) })?;
    Ok(vec![Output { path: "stats.json".to_string(), sha256: sha256_hex(&bytes) }])
}

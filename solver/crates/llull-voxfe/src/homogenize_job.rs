//! `llull-compute homogenize <job-folder>` (05 IMP 14.15): periodic numerical homogenisation of a unit cell on `llull-voxfe` (`llull_voxfe::homogenize`).
//!
//! Input `job.json` (camelCase, unknown fields rejected):
//! `{ "dims": [nx, ny, nz], "h": 0.05, "nu": 0.3, "eminRatio": 1e-6, "tolerance": 1e-9, "maxIterations": 6000, "maxVoxels": 262144, "density": "density.u8" }`
//! with `density.u8` one byte per voxel (x fastest), the partial volume `byte / 255` of the voxel. Out `report.json` = `{ c, iterations, residuals, converged, voxels, ms, threads }`
//! with `c` the 6 x 6 effective stiffness (row-major, Voigt `xx yy zz yz zx xy`) in units of the solid's Young modulus.
//! Failures: `NATIVE_JOB_INPUT` (a bad size, a density file of the wrong length, more voxels than `maxVoxels` or than the hard limit of the job).

use crate::homogenize::{homogenize, Cell, Refusal, Settings};
use llull_protocol::{sha256_hex, Output};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::time::Instant;

/// Most voxels a job takes whatever the host asks.
pub const HARD_VOXEL_LIMIT: usize = 262_144;

/// A job failure: stable code + message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobError {
    pub code: &'static str,
    pub message: String,
}

fn input_error(message: impl Into<String>) -> JobError {
    JobError { code: "NATIVE_JOB_INPUT", message: message.into() }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Job {
    dims: [usize; 3],
    h: f64,
    nu: f64,
    emin_ratio: f64,
    tolerance: Option<f64>,
    max_iterations: Option<usize>,
    max_voxels: Option<usize>,
    density: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    c: Vec<f64>,
    iterations: Vec<usize>,
    residuals: Vec<f64>,
    converged: bool,
    voxels: usize,
    ms: u128,
    threads: usize,
}

pub fn run(folder: &Path) -> Result<Vec<Output>, JobError> {
    let started = Instant::now();
    let read =
        |name: &str| fs::read(folder.join(name)).map_err(|error| JobError { code: "NATIVE_JOB_IO", message: format!("{name}: {error}") });
    let text = String::from_utf8(read("job.json")?).map_err(|error| input_error(format!("job.json: {error}")))?;
    let job: Job = serde_json::from_str(&text).map_err(|error| input_error(format!("job.json: {error}")))?;
    let voxels = job.dims.iter().try_fold(1usize, |total, d| total.checked_mul(*d)).unwrap_or(usize::MAX);
    let limit = job.max_voxels.unwrap_or(HARD_VOXEL_LIMIT).min(HARD_VOXEL_LIMIT);
    if voxels > limit {
        return Err(input_error(format!("{voxels} voxels exceed the limit of {limit}")));
    }
    if job.density.contains(['/', '\\']) || job.density.contains("..") {
        return Err(input_error("density must be a file name inside the job folder"));
    }
    let bytes = read(&job.density)?;
    if bytes.len() != voxels {
        return Err(input_error(format!("{}: {} bytes for {voxels} voxels", job.density, bytes.len())));
    }
    let density: Vec<f64> = bytes.iter().map(|b| f64::from(*b) / 255.0).collect();
    let cell = Cell { dims: job.dims, h: job.h, density: &density, nu: job.nu, emin: job.emin_ratio };
    let defaults = Settings::default();
    let settings = Settings {
        tolerance: job.tolerance.unwrap_or(defaults.tolerance),
        max_iterations: job.max_iterations.unwrap_or(defaults.max_iterations),
    };
    let result = homogenize(&cell, settings).map_err(|Refusal::Input(message)| input_error(message))?;
    let report = Report {
        c: result.c.to_vec(),
        iterations: result.iterations.to_vec(),
        residuals: result.residuals.to_vec(),
        converged: result.converged,
        voxels,
        ms: started.elapsed().as_millis(),
        threads: rayon::current_num_threads(),
    };
    let bytes = serde_json::to_vec(&report).map_err(|error| input_error(error.to_string()))?;
    let path = folder.join("report.json");
    fs::write(&path, &bytes).map_err(|error| JobError { code: "NATIVE_JOB_IO", message: format!("{}: {error}", path.display()) })?;
    Ok(vec![Output { path: "report.json".to_string(), sha256: sha256_hex(&bytes) }])
}

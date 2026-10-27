//! `llull-compute meshops <folder>` (07 MSH M3, RS1 RS-9): triangle-mesh operations on meshes of any size, bit-identical to the TypeScript
//! mesh engine (`packages/core/src/geometry/mesh`), which stays the oracle (`deterministic: true`, VC-MSH-32).
//!
//! Job folder: `job.json` = `{ "op": "decimate" | "smooth", "params": { ... } }`, `positions.f64` (little-endian f64, 3 per vertex) and
//! `indices.u32` (little-endian u32, 3 per triangle) of a welded, indexed mesh. Out: `result_positions.f64`, `result_indices.u32` (the canonical result)
//! and `report.json` = `{ op, items, ms, report }` with the op-specific report of the TypeScript engine.
//!
//! - `decimate`: `{ targetTriangles?, maxDeviation?, preserveBoundary, featureCos?, lockedRegion?: { center, radius } }`; the mesh must be
//!   manifold, consistently wound and free of degenerate faces (the host checks, as the TypeScript engine does).
//! - `smooth`: `{ taubin, lambda, passBand, iterations, cotangent, fixBoundary, volumeCorrection, region? }`.
//! - `quad_remesh` (feature `quad`): `{ targetFaces, preserveSharp, sharpCos, adaptive }`; the result is a quad mesh: `result_positions.f64`
//!   and `result_indices.u32` with FOUR indices per quad; the manifold / winding / degeneracy checks are the host's. Failures: code `QUAD_REMESH_FAILED`.
//! - `deviation`: `{ maxSamples }` between the mesh above and `positions_b.f64` / `indices_b.u32`; writes `report.json` only.

pub mod decimate;
pub mod deviation;
mod edit;
mod geom;
mod progress;
#[cfg(feature = "quad")]
mod quad;
pub mod smooth;
mod surface;

use geom::Sphere;
use llull_protocol::{sha256_hex, Output};
use progress::Progress;
use serde::Deserialize;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::Instant;

/// Stages QuadriFlow reports (`kStages` in `llull-quadflow/cpp/facade.cxx`), for the `total` of the progress events of `quad_remesh`.
const QUAD_STAGES: u64 = 10;

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
struct Region {
    center: [f64; 3],
    radius: f64,
}

impl Region {
    fn sphere(&self) -> Sphere {
        Sphere { center: self.center, radius: self.radius }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DecimateJob {
    target_triangles: Option<usize>,
    max_deviation: Option<f64>,
    preserve_boundary: bool,
    feature_cos: Option<f64>,
    locked_region: Option<Region>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SmoothJob {
    taubin: bool,
    lambda: f64,
    pass_band: f64,
    iterations: usize,
    cotangent: bool,
    fix_boundary: bool,
    volume_correction: bool,
    region: Option<Region>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviationJob {
    max_samples: usize,
}

#[derive(Debug, Deserialize)]
struct Job {
    op: String,
    params: serde_json::Value,
}

fn read(folder: &Path, name: &str) -> Result<Vec<u8>, JobError> {
    let path = folder.join(name);
    fs::read(&path).map_err(|error| JobError { code: "NATIVE_JOB_IO", message: format!("{}: {error}", path.display()) })
}

fn write(folder: &Path, name: &str, bytes: &[u8]) -> Result<Output, JobError> {
    let path = folder.join(name);
    fs::write(&path, bytes).map_err(|error| JobError { code: "NATIVE_JOB_IO", message: format!("{}: {error}", path.display()) })?;
    Ok(Output { path: name.to_string(), sha256: sha256_hex(bytes) })
}

fn f64s(bytes: &[u8], name: &str) -> Result<Vec<f64>, JobError> {
    if !bytes.len().is_multiple_of(24) {
        return Err(input_error(format!("{name}: {} bytes is not a whole number of xyz triples", bytes.len())));
    }
    let values: Vec<f64> = bytes.chunks_exact(8).map(|b| f64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]])).collect();
    if !values.iter().all(|v| v.is_finite()) {
        return Err(input_error(format!("{name}: non-finite coordinate (the TypeScript engine answers it)")));
    }
    Ok(values)
}

fn u32s(bytes: &[u8], vertex_count: usize) -> Result<Vec<u32>, JobError> {
    if !bytes.len().is_multiple_of(12) {
        return Err(input_error(format!("indices.u32: {} bytes is not a whole number of triangles", bytes.len())));
    }
    let values: Vec<u32> = bytes.chunks_exact(4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    if values.iter().any(|&i| i as usize >= vertex_count) {
        return Err(input_error(format!("indices.u32: an index is not below the {vertex_count} vertices")));
    }
    Ok(values)
}

fn f64_bytes(values: &[f64]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
}

fn u32_bytes(values: &[u32]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
}

/// Runs the job in `folder`; returns the written outputs. `out` receives the `progress` events (a stage start, then throttled ticks inside long
/// stages): `read`, the op's own stages, `write`.
pub fn run(folder: &Path, out: &mut dyn Write) -> Result<Vec<Output>, JobError> {
    let started = Instant::now();
    let text = String::from_utf8(read(folder, "job.json")?).map_err(|error| input_error(format!("job.json: {error}")))?;
    let job: Job = serde_json::from_str(&text).map_err(|error| input_error(format!("job.json: {error}")))?;
    let mut progress = Progress::new(out, if job.op == "quad_remesh" { 2 + QUAD_STAGES } else { 3 });
    progress.stage("read", 0.0);
    let positions = f64s(&read(folder, "positions.f64")?, "positions.f64")?;
    let triangles = u32s(&read(folder, "indices.u32")?, positions.len() / 3)?;
    let items = triangles.len() / 3;
    let mut mesh_out: Option<(Vec<f64>, Vec<u32>)> = None;
    let report = match job.op.as_str() {
        "decimate" => {
            let p: DecimateJob = serde_json::from_value(job.params).map_err(|error| input_error(format!("decimate params: {error}")))?;
            let params = decimate::DecimateParams {
                target_triangles: p.target_triangles,
                max_deviation: p.max_deviation,
                preserve_boundary: p.preserve_boundary,
                feature_cos: p.feature_cos,
                locked_region: p.locked_region.as_ref().map(Region::sphere),
            };
            progress.stage("decimate", 0.05);
            let (pos, idx, report) = decimate::decimate(&positions, &triangles, &params, &mut |done| progress.tick(0.05 + 0.9 * done));
            mesh_out = Some((pos, idx));
            serde_json::to_value(report).map_err(|error| input_error(error.to_string()))?
        }
        "smooth" => {
            let p: SmoothJob = serde_json::from_value(job.params).map_err(|error| input_error(format!("smooth params: {error}")))?;
            let params = smooth::SmoothParams {
                taubin: p.taubin,
                lambda: p.lambda,
                pass_band: p.pass_band,
                iterations: p.iterations,
                cotangent: p.cotangent,
                fix_boundary: p.fix_boundary,
                volume_correction: p.volume_correction,
                region: p.region.as_ref().map(Region::sphere),
            };
            progress.stage("smooth", 0.05);
            let (pos, report) = smooth::smooth(&positions, &triangles, &params, &mut |done| progress.tick(0.05 + 0.9 * done));
            mesh_out = Some((pos, triangles.clone()));
            serde_json::to_value(report).map_err(|error| input_error(error.to_string()))?
        }
        #[cfg(feature = "quad")]
        "quad_remesh" => {
            let p: quad::QuadJob =
                serde_json::from_value(job.params).map_err(|error| input_error(format!("quad_remesh params: {error}")))?;
            let (pos, quads) = quad::quad_remesh(&positions, &triangles, &p, &mut |stage, done| progress.stage(stage, 0.05 + 0.9 * done))?;
            let report = serde_json::json!({ "quads": quads.len() / 4, "vertices": pos.len() / 3 });
            mesh_out = Some((pos, quads));
            report
        }
        #[cfg(not(feature = "quad"))]
        "quad_remesh" => return Err(input_error("quad_remesh needs llull-meshops built with the `quad` feature")),
        "deviation" => {
            progress.stage("deviation", 0.05);
            let p: DeviationJob = serde_json::from_value(job.params).map_err(|error| input_error(format!("deviation params: {error}")))?;
            let other_positions = f64s(&read(folder, "positions_b.f64")?, "positions_b.f64")?;
            let other_triangles = u32s(&read(folder, "indices_b.u32")?, other_positions.len() / 3)?;
            let result = deviation::deviation((&positions, &triangles), (&other_positions, &other_triangles), p.max_samples)
                .ok_or_else(|| input_error("a mesh without triangles has no surface to measure"))?;
            serde_json::to_value(result).map_err(|error| input_error(error.to_string()))?
        }
        other => return Err(input_error(format!("unknown meshops op '{other}' (decimate, smooth, deviation, quad_remesh)"))),
    };
    let summary = serde_json::json!({ "op": job.op, "items": items, "ms": started.elapsed().as_millis(), "report": report });
    let summary_bytes = serde_json::to_vec(&summary).map_err(|error| input_error(error.to_string()))?;
    progress.stage("write", 0.97);
    let mut outputs = Vec::new();
    if let Some((out_positions, out_indices)) = mesh_out {
        outputs.push(write(folder, "result_positions.f64", &f64_bytes(&out_positions))?);
        outputs.push(write(folder, "result_indices.u32", &u32_bytes(&out_indices))?);
    }
    outputs.push(write(folder, "report.json", &summary_bytes)?);
    Ok(outputs)
}

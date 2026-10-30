//! `llull-compute meshops <folder>` (07 MSH M3, RS1 RS-9): triangle-mesh operations on meshes of any size, bit-identical to the TypeScript
//! mesh engine (`packages/core/src/geometry/mesh`), which stays the oracle (`deterministic: true`, VC-MSH-32).
//!
//! Job folder: `job.json` = `{ "op": "decimate" | "smooth" | "remesh" | "analyze" | "repair" | "fill_holes" | "sculpt" | "shrinkwrap" | "deviation" | "quad_remesh", "params": { ... } }`, `positions.f64` (little-endian f64, 3 per vertex) and
//! `indices.u32` (little-endian u32, 3 per triangle) of a welded, indexed mesh. Out: `result_positions.f64`, `result_indices.u32` (the canonical result)
//! and `report.json` = `{ op, items, ms, report }` with the op-specific report of the TypeScript engine.
//!
//! - `decimate`: `{ targetTriangles?, maxDeviation?, preserveBoundary, featureAngleRad?, lockedRegion?: { center, radius } }`; the mesh must be
//!   manifold, consistently wound and free of degenerate faces (the host checks, as the TypeScript engine does).
//!   The collapse queue is one entry per edge and the closest-point tree and the set-up scans use rayon; the bytes of the result do not depend on the thread count.
//! - `smooth`: `{ taubin, lambda, passBand, iterations, cotangent, fixBoundary, volumeCorrection, region? }`.
//! - `remesh` (DES-7c step 7): `{ targetEdge? | minEdge + maxEdge + approxError, iterations, featureAngleRad, preserveBoundary, project, region?, maxTriangles? }`;
//!   the same manifold / winding / degeneracy checks as decimate are the host's. A working mesh past `maxTriangles` (default 4 000 000) ends the job with code `REMESH_TOO_LARGE`.
//! - `analyze` (DES-7c step 7): `{ maxListed, weldTolerance: 0, selfIntersections }` on any triangle soup: welds exact duplicates, runs the pair search (stage `self_intersections`) when asked, and writes `report.json` with
//!   `report` = `{ weldTolerance, mergedVertices }` and `analysis` = the `MeshAnalysis` of the TypeScript engine (no result mesh). Coordinates above 1e100 are refused.
//! - `repair` and `fill_holes` (DES-7c step 7, slice 2): see `repair_job.rs`; the result is the repaired / filled mesh and the report is the TypeScript engine's.
//! - `shrinkwrap` (DES-7c native twins, 13.20): see `shrinkwrap_job.rs`; the target is `positions_b.f64` / `indices_b.u32`, the result is the wrapped mesh.
//! - `sculpt` (DES-7c step 7, slice 3): see `sculpt_job.rs`; the result is the sculpted mesh and the report is the TypeScript engine's.
//! - `quad_remesh` (feature `quad`): `{ targetFaces, hardEdgeRad?, adaptive }` (edges sharper than `hardEdgeRad` align the quads); the result is a quad mesh: `result_positions.f64`
//!   and `result_indices.u32` with FOUR indices per quad; the manifold / winding / degeneracy checks are the host's. Failures: code `QUAD_REMESH_FAILED`.
//! - decimate / smooth / remesh / repair / fill_holes / quad_remesh with `"deviationSamples": N` beside `op` and `params`: the job also measures the symmetric deviation of its result from its input
//!   (at most N samples per mesh; a quad result is measured as its outward-wound quads split along the shorter diagonal, which is what the host commits) and writes
//!   it as `deviation` in `report.json`, after a stage `deviation` before `write`. The host saves the separate `deviation` job that would follow.
//! - `deviation`: `{ maxSamples }` between the mesh above and `positions_b.f64` / `indices_b.u32`; writes `report.json` only.

pub mod analyze;
mod collapse_check;
pub mod decimate;
pub mod deviation;
mod edge_heap;
mod edit;
mod geom;
mod hole_fair;
mod hole_fill;
mod hole_refine;
mod hole_triangulate;
mod progress;
#[cfg(feature = "quad")]
mod quad;
#[cfg(feature = "quad")]
pub mod quad_mesh;
mod quadric;
pub mod remesh;
mod remesh_quality;
mod remesh_types;
mod repair;
mod repair_job;
mod sculpt;
mod sculpt_brush;
mod sculpt_job;
mod sculpt_measure;
mod sculpt_refine;
pub mod self_intersect;
mod shrinkwrap;
mod shrinkwrap_job;
pub mod smooth;
mod surface;
mod topology;
mod weld;

use geom::Sphere;
use llull_protocol::{sha256_hex, Output};
use progress::Progress;
use serde::Deserialize;
use std::borrow::Cow;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::Instant;

/// Stages QuadriFlow reports (`kStages` in `llull-quadflow/cpp/facade.cxx`), for the `total` of the progress events of `quad_remesh`.
const QUAD_STAGES: u64 = 10;

/// Largest coordinate `analyze` takes: above it the sums of squares and triple products overflow to infinity, which JSON cannot carry.
const MAX_ANALYZE_COORDINATE: f64 = 1e100;

/// Most remesh iterations a job runs (the command allows 50).
const MAX_REMESH_ITERATIONS: usize = 1000;

/// A job failure: stable code + message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobError {
    pub code: &'static str,
    pub message: String,
}

pub(crate) fn input_error(message: impl Into<String>) -> JobError {
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
    /// Edges whose faces turn by more than this angle (radians) are features; the cosine is computed here, by the V8 twin.
    feature_angle_rad: Option<f64>,
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
struct RemeshJob {
    target_edge: Option<f64>,
    min_edge: Option<f64>,
    max_edge: Option<f64>,
    approx_error: Option<f64>,
    iterations: usize,
    feature_angle_rad: f64,
    preserve_boundary: bool,
    project: bool,
    region: Option<Region>,
    max_triangles: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnalyzeJob {
    max_listed: usize,
    #[serde(default)]
    weld_tolerance: f64,
    #[serde(default)]
    self_intersections: bool,
    /// Candidate pairs the pair search may examine (default `self_intersect::CANDIDATE_LIMIT`; a field that only tests set).
    max_candidates: Option<u64>,
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
    /// decimate, smooth and quad_remesh: also measure the deviation of the result from the input in this job (at most this many samples per mesh).
    #[serde(rename = "deviationSamples", default)]
    deviation_samples: Option<usize>,
}

/// The checked parameters of a remesh job: positive finite lengths, the three adaptive ones together when there is no target edge.
/// `Math.cos` of an angle in [0, pi] radians, by the V8 twin; the other angles are refused (the commands bound them to 0..180 degrees).
pub(crate) fn cosine_of(name: &str, angle: f64) -> Result<f64, JobError> {
    if !(0.0..=std::f64::consts::PI + 1e-9).contains(&angle) {
        return Err(input_error(format!("{name} must be an angle between 0 and pi radians, got {angle}")));
    }
    Ok(llull_jsmath::cos(angle))
}

fn remesh_params(p: &RemeshJob) -> Result<remesh::RemeshParams, JobError> {
    let length = |name: &str, value: Option<f64>| match value {
        Some(v) if v.is_finite() && v > 0.0 => Ok(Some(v)),
        Some(v) => Err(input_error(format!("remesh {name} must be a positive number, got {v}"))),
        None => Ok(None),
    };
    let (target_edge, min_edge, max_edge, approx_error) = (
        length("targetEdge", p.target_edge)?,
        length("minEdge", p.min_edge)?,
        length("maxEdge", p.max_edge)?,
        length("approxError", p.approx_error)?,
    );
    let adaptive = match (min_edge, max_edge, approx_error) {
        (Some(min_edge), Some(max_edge), Some(approx_error)) => Some(remesh_quality::Adaptive { min_edge, max_edge, approx_error }),
        _ => None,
    };
    if target_edge.is_none() && adaptive.is_none() {
        return Err(input_error("remesh needs targetEdge, or minEdge + maxEdge + approxError"));
    }
    if p.iterations > MAX_REMESH_ITERATIONS {
        return Err(input_error(format!("remesh iterations {} exceed {MAX_REMESH_ITERATIONS}", p.iterations)));
    }
    Ok(remesh::RemeshParams {
        target_edge,
        adaptive,
        iterations: p.iterations,
        feature_angle: p.feature_angle_rad,
        feature_cos: cosine_of("featureAngleRad", p.feature_angle_rad)?,
        preserve_boundary: p.preserve_boundary,
        project: p.project,
        region: p.region.as_ref().map(Region::sphere),
        max_triangles: p.max_triangles.unwrap_or(remesh::MAX_TRIANGLES),
    })
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

/// The triangles of an op's result for the deviation measurement: the result itself, or for `quad_remesh` its outward-wound quads split along the shorter
/// diagonal (what the host commits). `None` when the result is not a mesh that can be measured (an index past the vertices, a non-finite coordinate, a
/// quad count that is not whole): the job then reports no deviation and the host's own checks refuse the result by name.
fn result_triangles<'a>(op: &str, positions: &[f64], indices: &'a [u32]) -> Option<Cow<'a, [u32]>> {
    let vertices = positions.len() / 3;
    if !positions.len().is_multiple_of(3) || !positions.iter().all(|v| v.is_finite()) || indices.iter().any(|&i| i as usize >= vertices) {
        return None;
    }
    #[cfg(feature = "quad")]
    if op == "quad_remesh" {
        if !indices.len().is_multiple_of(4) {
            return None;
        }
        return Some(Cow::Owned(quad_mesh::triangulate_quads(positions, &quad_mesh::outward_quads(positions, indices))));
    }
    let _ = op;
    Some(Cow::Borrowed(indices))
}

/// Runs the job in `folder`; returns the written outputs. `out` receives the `progress` events (a stage start, then throttled ticks inside long
/// stages): `read`, the op's own stages, `write`.
pub fn run(folder: &Path, out: &mut dyn Write) -> Result<Vec<Output>, JobError> {
    let started = Instant::now();
    let text = String::from_utf8(read(folder, "job.json")?).map_err(|error| input_error(format!("job.json: {error}")))?;
    let job: Job = serde_json::from_str(&text).map_err(|error| input_error(format!("job.json: {error}")))?;
    let measures = job.deviation_samples.is_some() && job.op != "deviation";
    let pair_search = job.op == "analyze" && job.params["selfIntersections"] == true;
    let mut progress = Progress::new(out, if job.op == "quad_remesh" { 2 + QUAD_STAGES } else { 3 } + u64::from(measures || pair_search));
    progress.stage("read", 0.0);
    let positions = f64s(&read(folder, "positions.f64")?, "positions.f64")?;
    let triangles = u32s(&read(folder, "indices.u32")?, positions.len() / 3)?;
    let items = triangles.len() / 3;
    let mut mesh_out: Option<(Vec<f64>, Vec<u32>)> = None;
    let mut analysis = None;
    let report = match job.op.as_str() {
        "analyze" => {
            let p: AnalyzeJob = serde_json::from_value(job.params).map_err(|error| input_error(format!("analyze params: {error}")))?;
            if p.weld_tolerance != 0.0 {
                return Err(input_error("analyze welds exact duplicates only (the TypeScript engine welds with a tolerance)"));
            }
            if positions.iter().any(|v| v.abs() > MAX_ANALYZE_COORDINATE) {
                return Err(input_error(format!(
                    "analyze needs coordinates below {MAX_ANALYZE_COORDINATE:e}: the area and volume sums would overflow"
                )));
            }
            progress.stage("analyze", 0.05);
            let welded = weld::weld_exact(&positions, &triangles);
            let intersections = if p.self_intersections {
                progress.stage("self_intersections", 0.3);
                let found = self_intersect::find_self_intersections(
                    &welded.positions,
                    &welded.triangles,
                    p.max_listed,
                    p.max_candidates.unwrap_or(self_intersect::CANDIDATE_LIMIT),
                )
                .map_err(|_| JobError {
                    code: "SELF_INTERSECTION_TOO_COSTLY",
                    message: format!(
                        "the pair search would examine more than {} candidate pairs: the mesh has too many overlapping triangles",
                        p.max_candidates.unwrap_or(self_intersect::CANDIDATE_LIMIT)
                    ),
                })?;
                Some(found)
            } else {
                None
            };
            analysis = Some(analyze::analyze(&welded.positions, &welded.triangles, p.max_listed, intersections));
            serde_json::json!({ "weldTolerance": 0, "mergedVertices": welded.merged })
        }
        "repair" => {
            progress.stage("repair", 0.05);
            let (pos, idx, report) =
                repair_job::run_repair(&positions, &triangles, job.params, &mut |done| progress.tick(0.05 + 0.9 * done))?;
            mesh_out = Some((pos, idx));
            report
        }
        "fill_holes" => {
            progress.stage("fill_holes", 0.05);
            let (pos, idx, report) =
                repair_job::run_fill(&positions, &triangles, job.params, &mut |done| progress.tick(0.05 + 0.9 * done))?;
            mesh_out = Some((pos, idx));
            report
        }
        "sculpt" => {
            progress.stage("sculpt", 0.05);
            let (pos, idx, report) =
                sculpt_job::run_sculpt(&positions, &triangles, job.params, &mut |done| progress.tick(0.05 + 0.9 * done))?;
            mesh_out = Some((pos, idx));
            report
        }
        "shrinkwrap" => {
            progress.stage("shrinkwrap", 0.05);
            let target_positions = f64s(&read(folder, "positions_b.f64")?, "positions_b.f64")?;
            let target_triangles = u32s(&read(folder, "indices_b.u32")?, target_positions.len() / 3)?;
            let (pos, idx, report) = shrinkwrap_job::run_shrinkwrap(
                &positions,
                &triangles,
                (&target_positions, &target_triangles),
                job.params,
                &mut |done| progress.tick(0.05 + 0.9 * done),
            )?;
            mesh_out = Some((pos, idx));
            report
        }
        "decimate" => {
            let p: DecimateJob = serde_json::from_value(job.params).map_err(|error| input_error(format!("decimate params: {error}")))?;
            let params = decimate::DecimateParams {
                target_triangles: p.target_triangles,
                max_deviation: p.max_deviation,
                preserve_boundary: p.preserve_boundary,
                feature_cos: p.feature_angle_rad.map(|angle| cosine_of("featureAngleRad", angle)).transpose()?,
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
        "remesh" => {
            let p: RemeshJob = serde_json::from_value(job.params).map_err(|error| input_error(format!("remesh params: {error}")))?;
            let params = remesh_params(&p)?;
            progress.stage("remesh", 0.05);
            match remesh::remesh(&positions, &triangles, &params, &mut |done| progress.tick(0.05 + 0.9 * done)) {
                remesh::Remeshed::Done(pos, idx, report) => {
                    mesh_out = Some((pos, idx));
                    serde_json::to_value(report).map_err(|error| input_error(error.to_string()))?
                }
                remesh::Remeshed::TooLarge(count) => {
                    return Err(JobError {
                        code: "REMESH_TOO_LARGE",
                        message: format!(
                            "the remeshed surface passed {count} triangles (limit {}): use a longer target edge",
                            params.max_triangles
                        ),
                    })
                }
            }
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
        other => {
            return Err(input_error(format!(
                "unknown meshops op '{other}' (decimate, smooth, remesh, analyze, repair, fill_holes, sculpt, shrinkwrap, deviation, quad_remesh)"
            )))
        }
    };
    let measured = match (&mesh_out, job.deviation_samples) {
        (Some((out_positions, out_indices)), Some(samples)) if measures => {
            progress.stage("deviation", 0.96);
            result_triangles(&job.op, out_positions, out_indices)
                .and_then(|result| deviation::deviation((&positions, &triangles), (out_positions, &result), samples))
        }
        _ => None,
    };
    let mut summary = serde_json::json!({ "op": job.op, "items": items, "ms": started.elapsed().as_millis(), "report": report });
    if let Some(analysis) = analysis {
        summary["analysis"] = serde_json::to_value(analysis).map_err(|error| input_error(error.to_string()))?;
    }
    if let Some(measured) = measured {
        summary["deviation"] = serde_json::to_value(measured).map_err(|error| input_error(error.to_string()))?;
    }
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

#[cfg(test)]
mod tests {
    use super::result_triangles;

    #[test]
    fn a_result_that_cannot_be_measured_gives_no_triangles_instead_of_a_panic() {
        let square = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0];
        assert_eq!(result_triangles("decimate", &square, &[0, 1, 2]).as_deref(), Some(&[0u32, 1, 2][..]));
        // an index past the vertices, a non-finite coordinate, positions that are not whole triples
        assert!(result_triangles("decimate", &square, &[0, 1, 4]).is_none());
        assert!(result_triangles("smooth", &[f64::NAN, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0], &[0, 1, 2]).is_none());
        assert!(result_triangles("decimate", &square[..10], &[0, 1, 2]).is_none());
    }

    #[cfg(feature = "quad")]
    #[test]
    fn a_malformed_quad_result_gives_no_triangles() {
        let square = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0];
        assert_eq!(result_triangles("quad_remesh", &square, &[0, 1, 2, 3]).as_deref(), Some(&[0u32, 1, 2, 0, 2, 3][..]));
        assert!(result_triangles("quad_remesh", &square, &[0, 1, 2, 9]).is_none());
        assert!(result_triangles("quad_remesh", &square, &[0, 1, 2]).is_none());
        assert!(result_triangles("quad_remesh", &[0.0, f64::INFINITY, 0.0], &[0, 0, 0, 0]).is_none());
    }
}

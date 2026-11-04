//! `llull-compute bvh <folder>` (RS1 RS-6, plant 09 VIS-M8e): the instance BVH of `instance.rs` as a job, so a host can build the tree of
//! a very large scene out of process. Same tree, array for array, as `buildInstanceBvh` (`packages/core/src/geometry/instanceBvh.ts`).
//!
//! Job folder: `job.json` = `{ "version": 1, "op": "build", "count": n }` and `boxes.f64` = little-endian f64, 6 per box
//! (`minX minY minZ maxX maxY maxZ`; every value finite). Outputs, little-endian, sized exactly (the layout of `exportInstanceBvh`):
//! `order.u32` (n), `nodeBox.f64` (6 per node), `nodeStart.u32`, `nodeEnd.u32` (one per node), `nodeChild.i32` (first child, -1 for a
//! leaf), and `report.json` = `{ op, count, nodeCount, threads, ms }`. The boxes are not echoed: the host already holds them.
//! Errors: `NATIVE_JOB_INPUT` (version, op, count, file size, a non-finite box: the TypeScript build answers it), `NATIVE_JOB_IO`.

use crate::instance::InstanceBvh;
use llull_protocol::{sha256_hex, Output};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::time::Instant;

/// A job failure: stable code + message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobError {
    pub code: &'static str,
    pub message: String,
}

fn input_error(message: impl Into<String>) -> JobError {
    JobError { code: "NATIVE_JOB_INPUT", message: message.into() }
}

fn io_error(path: &Path, error: impl std::fmt::Display) -> JobError {
    JobError { code: "NATIVE_JOB_IO", message: format!("{}: {error}", path.display()) }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BvhJob {
    version: u32,
    op: String,
    count: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    op: &'static str,
    count: usize,
    node_count: usize,
    threads: usize,
    ms: u128,
}

/// The validated boxes of `bytes` for a job of `count` boxes.
pub fn parse_boxes(bytes: &[u8], count: u64) -> Result<Vec<f64>, JobError> {
    if count > u64::from(u32::MAX) {
        return Err(input_error(format!("count {count} exceeds the u32 index range")));
    }
    let expected = count as usize * 6 * 8;
    if bytes.len() != expected {
        return Err(input_error(format!("boxes.f64 is {} bytes, {count} boxes need {expected}", bytes.len())));
    }
    let boxes: Vec<f64> = bytes.chunks_exact(8).map(|b| f64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]])).collect();
    if let Some(at) = boxes.iter().position(|v| !v.is_finite()) {
        return Err(input_error(format!("box {}: non-finite coordinate (the TS build answers it)", at / 6)));
    }
    Ok(boxes)
}

fn le_bytes<T: Copy, const N: usize>(values: &[T], to_bytes: impl Fn(T) -> [u8; N]) -> Vec<u8> {
    values.iter().flat_map(|&v| to_bytes(v)).collect()
}

fn write(folder: &Path, name: &str, bytes: &[u8]) -> Result<Output, JobError> {
    let path = folder.join(name);
    fs::write(&path, bytes).map_err(|error| io_error(&path, error))?;
    Ok(Output { path: name.to_string(), sha256: sha256_hex(bytes) })
}

/// Runs the job in `folder`; returns the written outputs.
pub fn run(folder: &Path) -> Result<Vec<Output>, JobError> {
    let started = Instant::now();
    let manifest = folder.join("job.json");
    let text = fs::read_to_string(&manifest).map_err(|error| io_error(&manifest, error))?;
    let job: BvhJob = serde_json::from_str(&text).map_err(|error| input_error(format!("job.json: {error}")))?;
    if job.version != 1 {
        return Err(input_error(format!("job.json version {} is not supported (1)", job.version)));
    }
    if job.op != "build" {
        return Err(input_error(format!("unknown bvh op '{}' (build)", job.op)));
    }
    let boxes_path = folder.join("boxes.f64");
    let boxes = parse_boxes(&fs::read(&boxes_path).map_err(|error| io_error(&boxes_path, error))?, job.count)?;
    let bvh = InstanceBvh::build(&boxes);
    let report = Report { op: "build", count: bvh.count, node_count: bvh.node_start.len(), threads: 1, ms: started.elapsed().as_millis() };
    let report_json = serde_json::to_vec(&report).map_err(|error| input_error(error.to_string()))?;
    Ok(vec![
        write(folder, "order.u32", &le_bytes(&bvh.order, u32::to_le_bytes))?,
        write(folder, "nodeBox.f64", &le_bytes(&bvh.node_box, f64::to_le_bytes))?,
        write(folder, "nodeStart.u32", &le_bytes(&bvh.node_start, u32::to_le_bytes))?,
        write(folder, "nodeEnd.u32", &le_bytes(&bvh.node_end, u32::to_le_bytes))?,
        write(folder, "nodeChild.i32", &le_bytes(&bvh.node_child, i32::to_le_bytes))?,
        write(folder, "report.json", &report_json)?,
    ])
}

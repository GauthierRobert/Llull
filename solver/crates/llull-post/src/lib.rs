//! FE post-processing jobs of `llull-compute post` (RS1 RS-7): `fatigue` (PHY-07 TR-FAT-41, rainflow + Miner damage on every node) and
//! `map` (PHY-04 TR-TMC-24, mesh-to-mesh field mapping on `llull-bvh`). Rust CPU: the numbers are written into documents and decks, so
//! they must reproduce the TypeScript references bit for bit (RS1 §2 rules 3 and 4).
//!
//! Job folder: `job.json` (`{ "task": "fatigue" | "map", ... }`) plus little-endian `f64` buffers written by the host; results are
//! written next to them and reported with their sha256 (`llull_protocol::Output`).

pub mod damage;
pub mod fatigue;
pub mod life;
pub mod map;
pub mod rainflow;
pub mod stress;

use llull_protocol::{sha256_hex, Output};
use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

/// A job failure: stable code + message (the host maps it to its own codes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobError {
    pub code: &'static str,
    pub message: String,
}

impl JobError {
    pub fn input(message: String) -> JobError {
        JobError { code: "NATIVE_JOB_INPUT", message }
    }

    fn io(path: &Path, error: &std::io::Error) -> JobError {
        JobError { code: "NATIVE_JOB_IO", message: format!("{}: {error}", path.display()) }
    }
}

/// Reads a little-endian `f64` buffer.
pub fn read_f64(path: &Path) -> Result<Vec<f64>, JobError> {
    let bytes = fs::read(path).map_err(|error| JobError::io(path, &error))?;
    if !bytes.len().is_multiple_of(8) {
        return Err(JobError::input(format!("{} is not a whole number of f64 values", path.display())));
    }
    Ok(bytes.chunks_exact(8).map(|c| f64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]])).collect())
}

/// Writes bytes and returns the output entry (path relative to the job folder + sha256).
pub fn write_output(folder: &Path, name: &str, bytes: &[u8]) -> Result<Output, JobError> {
    let path = folder.join(name);
    fs::write(&path, bytes).map_err(|error| JobError::io(&path, &error))?;
    Ok(Output { path: name.to_string(), sha256: sha256_hex(bytes) })
}

/// Little-endian bytes of `f64` values.
pub fn f64_bytes(values: &[f64]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, JobError> {
    let text = fs::read_to_string(path).map_err(|error| JobError::io(path, &error))?;
    serde_json::from_str(&text).map_err(|error| JobError::input(format!("{}: {error}", path.display())))
}

fn rows<const N: usize>(values: &[f64], name: &str) -> Result<Vec<[f64; N]>, JobError> {
    if !values.len().is_multiple_of(N) {
        return Err(JobError::input(format!("{name} must hold {N} values per row")));
    }
    Ok(values.chunks_exact(N).map(|c| std::array::from_fn(|i| c[i])).collect())
}

fn run_fatigue(folder: &Path) -> Result<Vec<Output>, JobError> {
    let job: fatigue::FatigueJob = read_json(&folder.join("job.json"))?;
    let tensors = read_f64(&folder.join("tensors.f64"))?;
    let field = fatigue::run(&job, &tensors)?;
    Ok(vec![write_output(folder, "field.f64", &f64_bytes(&field))?])
}

fn run_map(folder: &Path) -> Result<Vec<Output>, JobError> {
    let source_nodes = rows::<4>(&read_f64(&folder.join("source_nodes.f64"))?, "source_nodes.f64")?;
    let target_nodes = rows::<4>(&read_f64(&folder.join("target_nodes.f64"))?, "target_nodes.f64")?;
    let source_values: HashMap<u64, f64> =
        rows::<2>(&read_f64(&folder.join("source_values.f64"))?, "source_values.f64")?.into_iter().map(|[id, v]| (id as u64, v)).collect();
    let source_elements = map::parse_elements(&read_f64(&folder.join("source_elements.f64"))?)?;
    let input = map::MapInput { source_nodes: &source_nodes, source_elements, source_values, target_nodes: &target_nodes };
    let (nodes, report) = map::map_field(&input).map_err(|message| JobError { code: "NATIVE_MAP_REFUSED", message })?;
    let flat: Vec<f64> = nodes.iter().flat_map(|node| [node.value, node.element as f64, node.distance]).collect();
    let report_json = serde_json::to_vec(&report).map_err(|error| JobError::input(error.to_string()))?;
    Ok(vec![write_output(folder, "mapped.f64", &f64_bytes(&flat))?, write_output(folder, "map.json", &report_json)?])
}

/// Runs `llull-compute post <task> <folder>`.
pub fn run(task: &str, folder: &Path) -> Result<Vec<Output>, JobError> {
    match task {
        "fatigue" => run_fatigue(folder),
        "map" => run_map(folder),
        _ => Err(JobError { code: "NATIVE_JOB_UNKNOWN", message: format!("unknown post task '{task}' (fatigue | map)") }),
    }
}

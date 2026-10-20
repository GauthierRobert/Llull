//! `llull-compute cloud <task> <job-folder>` (RS1 §2 job protocol).
//!
//! # `cloud import`: `job.json`
//!
//! ```json
//! { "version": 1, "source": "/abs/scan.e57", "sourceName": "scan.e57", "sourceSha256": "<hex>", "assetKey": "<hex>",
//!   "output": "/abs/store/.tmp-xyz", "options": { "applyStationPoses": true, "checksum": "all", "maxPointsPerNode": 20000 } }
//! ```
//!
//! Reads the source (format by signature, then extension), builds the octree and writes `manifest.json`, `hierarchy.bin`, `nodes.bin`
//! and `source.sha256` into `output` (the host renames that directory into the store: atomic). Progress events `read`, `index`,
//! `write`; `done` lists the four files with their sha256. Errors: the `SCN_*` reader codes, `SCN_CLOUD_EMPTY`,
//! `SCN_IMPORT_TOO_LARGE`, `NATIVE_JOB_INPUT`, `NATIVE_JOB_IO`.
//!
//! # `cloud op`: see [`crate::ops`].

use crate::asset;
use crate::error::{CloudError, CloudResult};
use crate::read::{self, ImportOptions};
use llull_protocol::{emit, Event, Output};
use serde::Deserialize;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportJob {
    version: u32,
    source: PathBuf,
    source_name: String,
    source_sha256: String,
    asset_key: String,
    output: PathBuf,
    #[serde(default)]
    options: ImportOptions,
}

pub fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> CloudResult<T> {
    let text = std::fs::read_to_string(path).map_err(|error| CloudError::io(path, &error))?;
    serde_json::from_str(&text).map_err(|error| CloudError::input(format!("{}: {error}", path.display())))
}

fn is_hex64(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn progress(out: &mut impl Write, step: u64, message: &str) {
    let _ = emit(out, &Event::Progress { step, total: 3, message, detail: None });
}

/// Runs `cloud import`.
pub fn import(folder: &Path, out: &mut impl Write) -> CloudResult<Vec<Output>> {
    let job: ImportJob = read_json(&folder.join("job.json"))?;
    if job.version != 1 {
        return Err(CloudError::input(format!("job version {} is not 1", job.version)));
    }
    if !is_hex64(&job.asset_key) || !is_hex64(&job.source_sha256) {
        return Err(CloudError::input("assetKey and sourceSha256 must be 64 lower-case hex digits"));
    }
    progress(out, 1, "read");
    let cloud = read::read(&job.source, &job.options)?;
    if cloud.record_index.last().is_some_and(|&r| r > u64::from(u32::MAX)) {
        return Err(CloudError::new("SCN_IMPORT_TOO_LARGE", "more than 2^32 source records"));
    }
    for warning in &cloud.warnings {
        let _ = emit(out, &Event::Warning { code: &warning.code, message: &warning.message });
    }
    progress(out, 2, "index");
    let built = asset::build(&cloud, &job.asset_key, &job.source_sha256, &job.source_name, &job.options)?;
    progress(out, 3, "write");
    asset::write(&built, &job.output)
}

/// Dispatches a `cloud` task.
pub fn run(task: &str, folder: &Path, out: &mut impl Write) -> CloudResult<Vec<Output>> {
    match task {
        "import" => import(folder, out),
        "op" => crate::ops::run(folder, out),
        other => Err(CloudError::new("NATIVE_USAGE", format!("unknown cloud task '{other}' (import | op)"))),
    }
}

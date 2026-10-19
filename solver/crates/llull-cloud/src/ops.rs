//! `llull-compute cloud op <job-folder>`: the heavy queries behind `PointCloudPort.compute` (TECHNICAL_SPEC §2.A).

use crate::error::{CloudError, CloudResult};
use llull_protocol::Output;
use std::io::Write;
use std::path::Path;

/// Runs one op job.
pub fn run(folder: &Path, _out: &mut impl Write) -> CloudResult<Vec<Output>> {
    let _ = folder;
    Err(CloudError::input("no op is implemented yet"))
}

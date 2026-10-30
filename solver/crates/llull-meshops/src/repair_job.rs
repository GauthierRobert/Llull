//! The `repair` and `fill_holes` jobs of `llull-compute meshops` (DES-7c step 7, slice 2): parameters, checks and the report of the TypeScript engine.
//!
//! - `repair`: `{ mode, weldTolerance, maxGap, smallComponents?: { maxFaces?, maxVolume? }, maxBoundaryEdges }` on any triangle soup; weld tolerance and gap are finite and
//!   at least 0. `report` = `{ mode, changes, notes, skippedHoles }`.
//! - `fill_holes`: `{ select: "all" | [loop numbers] | { near: [[x, y, z], ..] }, maxBoundaryEdges, fairing, refine, alpha? }` on the mesh as given (loops are those of
//!   its own topology, nothing is welded). `report` = `{ totalLoops, filled, skipped }`. A patch area that overflows to infinity (coordinates near 1e154) ends the job with
//!   `NATIVE_JOB_INPUT` (JSON cannot carry it; the host falls through to the TypeScript engine). A selection that names no loop ends the job with `MESH_HOLE_NOT_FOUND` (`HOLE_NEAR_NOT_FOUND` with the position of the point as message when a point
//!   has no loop to be near: the host words that message, because it needs the JavaScript text of the point), and an explicitly chosen loop that cannot be filled with
//!   its own code (`MESH_HOLE_TOO_LARGE`, `MESH_HOLE_NON_SIMPLE`, `MESH_HOLE_NO_TRIANGULATION`).

use crate::hole_fair::Fairing;
use crate::hole_fill::{fill_holes, FillOptions, NotFound, Select};
use crate::repair::{repair, Mode, RepairParams, SmallRule};
use crate::{input_error, JobError};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepairJob {
    mode: Mode,
    weld_tolerance: f64,
    max_gap: f64,
    small_components: Option<SmallRule>,
    max_boundary_edges: f64,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum SelectJob {
    Word(String),
    Loops(Vec<u64>),
    Near { near: Vec<[f64; 3]> },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FillJob {
    select: SelectJob,
    max_boundary_edges: f64,
    fairing: Fairing,
    refine: bool,
    alpha: Option<f64>,
}

type Done = (Vec<f64>, Vec<u32>, Value);

/// Run a `repair` job on the mesh; `tick` gets the share done.
pub fn run_repair(positions: &[f64], triangles: &[u32], params: Value, tick: &mut dyn FnMut(f64)) -> Result<Done, JobError> {
    let job: RepairJob = serde_json::from_value(params).map_err(|error| input_error(format!("repair params: {error}")))?;
    for (name, value) in [("weldTolerance", job.weld_tolerance), ("maxGap", job.max_gap)] {
        if !value.is_finite() || value < 0.0 {
            return Err(input_error(format!("repair {name} must be a finite number of at least 0, got {value}")));
        }
    }
    let params = RepairParams {
        mode: job.mode,
        weld_tolerance: job.weld_tolerance,
        max_gap: job.max_gap,
        small: job.small_components,
        max_boundary_edges: job.max_boundary_edges,
    };
    let repaired = repair(positions, triangles, &params, tick);
    let report = json!({
        "mode": job.mode,
        "changes": repaired.changes,
        "notes": repaired.notes,
        "skippedHoles": repaired.skipped_holes,
    });
    Ok((repaired.positions, repaired.triangles, report))
}

/// Run a `fill_holes` job on the mesh; `tick` gets the share of the loops done.
pub fn run_fill(positions: &[f64], triangles: &[u32], params: Value, tick: &mut dyn FnMut(f64)) -> Result<Done, JobError> {
    let job: FillJob = serde_json::from_value(params).map_err(|error| input_error(format!("fill_holes params: {error}")))?;
    let select = match job.select {
        SelectJob::Word(word) if word == "all" => Select::All,
        SelectJob::Word(word) => {
            return Err(input_error(format!("fill_holes select must be \"all\", loop numbers or points, got \"{word}\"")))
        }
        SelectJob::Loops(numbers) => Select::Loops(numbers),
        SelectJob::Near { near } => Select::Near(near),
    };
    let options = FillOptions {
        select: &select,
        max_boundary_edges: job.max_boundary_edges,
        fairing: job.fairing,
        refine: job.refine,
        alpha: job.alpha.unwrap_or(std::f64::consts::SQRT_2),
    };
    let result = fill_holes(positions, triangles, &options, tick);
    match result.not_found {
        Some(NotFound::Loop { index, loops }) => {
            return Err(JobError {
                code: "MESH_HOLE_NOT_FOUND",
                message: format!("boundary loop {index} does not exist (the mesh has {loops})"),
            })
        }
        Some(NotFound::Near(at)) => return Err(JobError { code: "HOLE_NEAR_NOT_FOUND", message: at.to_string() }),
        None => {}
    }
    if let (true, Some(blocked)) = (result.explicit, result.skipped.first()) {
        return Err(JobError {
            code: blocked.code,
            message: format!("boundary loop {} ({} edges) cannot be filled: {}", blocked.loop_index, blocked.edges, blocked.code),
        });
    }
    if let Some(patch) = result.filled.iter().find(|patch| !patch.area.is_finite()) {
        return Err(input_error(format!(
            "fill_holes: the patch area of boundary loop {} overflows (coordinates too large)",
            patch.loop_index
        )));
    }
    let report = json!({ "totalLoops": result.total_loops, "filled": result.filled, "skipped": result.skipped });
    Ok((result.positions, result.triangles, report))
}

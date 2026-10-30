//! The `shrinkwrap` job of `llull-compute meshops` (DES-7c native twins, 13.20): `{ mode, direction?, offset, side, maxDistance? }` on a mesh (`positions.f64`, `indices.u32`) and
//! its target (`positions_b.f64`, `indices_b.u32`). The result is the wrapped mesh (the same triangles) and `report` = `{ moved, missed, maxMove, meanMove, residual }`.
//! Failures: `NATIVE_JOB_INPUT` for a parameter the job does not take (an offset that is negative or not finite, a distance that is not positive, a direction that is not finite,
//! a coordinate above 1e100 whose sums would overflow, a target without triangles) or a result that is not finite (JSON cannot carry it): the host then falls through to the
//! TypeScript engine, which answers (or refuses) it.

use crate::shrinkwrap::{shrinkwrap, Mode, Params, Side};
use crate::{input_error, JobError};
use serde::Deserialize;
use serde_json::Value;

/// Largest coordinate the job takes: above it the products of the projection overflow.
const MAX_COORDINATE: f64 = 1e100;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WrapJob {
    mode: Mode,
    direction: Option<[f64; 3]>,
    offset: f64,
    side: Side,
    max_distance: Option<f64>,
}

type Done = (Vec<f64>, Vec<u32>, Value);

/// Run a `shrinkwrap` job; `tick` gets the share done.
pub fn run_shrinkwrap(
    positions: &[f64],
    triangles: &[u32],
    target: (&[f64], &[u32]),
    params: Value,
    tick: &mut dyn FnMut(f64),
) -> Result<Done, JobError> {
    let job: WrapJob = serde_json::from_value(params).map_err(|error| input_error(format!("shrinkwrap params: {error}")))?;
    if target.1.is_empty() {
        return Err(input_error("shrinkwrap needs a target with triangles"));
    }
    if positions.iter().chain(target.0).any(|c| !c.is_finite() || c.abs() > MAX_COORDINATE) {
        return Err(input_error(format!(
            "shrinkwrap needs finite coordinates below {MAX_COORDINATE:e}: the products of the projection would overflow"
        )));
    }
    if !(job.offset.is_finite() && job.offset >= 0.0 && job.offset <= MAX_COORDINATE) {
        return Err(input_error(format!("shrinkwrap offset must be a number from 0 to {MAX_COORDINATE:e}, got {}", job.offset)));
    }
    if let Some(d) = job.max_distance {
        if d.is_nan() || d <= 0.0 {
            return Err(input_error(format!("shrinkwrap maxDistance must be positive, got {d}")));
        }
    }
    if let Some(direction) = job.direction {
        if direction.iter().any(|c| !c.is_finite() || c.abs() > MAX_COORDINATE) {
            return Err(input_error(format!(
                "shrinkwrap direction must be finite coordinates up to {MAX_COORDINATE:e}, got {direction:?}"
            )));
        }
    }
    let params = Params { mode: job.mode, direction: job.direction, offset: job.offset, side: job.side, max_distance: job.max_distance };
    let wrapped = shrinkwrap(positions, triangles, target, &params, tick);
    let r = &wrapped.report;
    if ![r.max_move, r.mean_move, r.residual].iter().all(|n| n.is_finite()) || !wrapped.positions.iter().all(|c| c.is_finite()) {
        return Err(input_error("shrinkwrap: the result is not finite; the TypeScript engine answers it"));
    }
    let report = serde_json::to_value(&wrapped.report).map_err(|error| input_error(error.to_string()))?;
    Ok((wrapped.positions, triangles.to_vec(), report))
}

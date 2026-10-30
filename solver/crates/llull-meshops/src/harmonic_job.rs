//! The `harmonic_map` job of `llull-compute meshops` (DES-7c, 13.26): `{ maxIterations? }` on a region mesh (`positions.f64`, `indices.u32`, every triangle is the region).
//! The result is the parameters: `result_positions.f64` = (u, v, 0) per region vertex, `result_indices.u32` = the region vertices, ascending (the vertex numbers of the input mesh), and
//! `report` = `{ weights, flippedFirst, collapsedInParameters, interiorVertices, boundaryVertices, cgIterations, cgResidual, corners }`.
//! Refusals: `MESH_FIT_NOT_DISK` and `MESH_FIT_PARAM_FOLDED` with the text of the TypeScript engine (the command shows them as they are).

use crate::harmonic::harmonic_map;
use crate::{input_error, JobError};
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HarmonicJob {
    max_iterations: Option<usize>,
}

type Done = (Vec<f64>, Vec<u32>, Value);

pub fn run_harmonic(positions: &[f64], triangles: &[u32], params: Value, tick: &mut dyn FnMut(f64)) -> Result<Done, JobError> {
    let job: HarmonicJob = serde_json::from_value(params).map_err(|error| input_error(format!("harmonic_map params: {error}")))?;
    tick(0.05);
    let map = harmonic_map(positions, triangles, job.max_iterations, &mut |done| tick(0.05 + 0.9 * done))
        .map_err(|refusal| JobError { code: refusal.code, message: refusal.message })?;
    tick(1.0);
    let uv: Vec<f64> = map.uv.iter().flat_map(|[u, v]| [*u, *v, 0.0]).collect();
    if !uv.iter().all(|c| c.is_finite()) || !map.cg_residual.is_finite() {
        return Err(input_error("harmonic_map: the result is not finite; the TypeScript engine answers it"));
    }
    let report = serde_json::json!({
        "weights": map.weights,
        "flippedFirst": map.flipped_first,
        "collapsedInParameters": map.collapsed_in_parameters,
        "interiorVertices": map.interior_vertices,
        "boundaryVertices": map.boundary_vertices,
        "cgIterations": map.cg_iterations,
        "cgResidual": map.cg_residual,
        "corners": map.corners,
    });
    Ok((uv, map.vertices, report))
}

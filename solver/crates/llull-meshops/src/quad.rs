//! `quad_remesh` (07 MSH M6): field-aligned quad remeshing by QuadriFlow (Huang et al., SGP 2018), vendored in `llull-quadflow` and built only
//! with the cargo feature `quad`. Unlike decimate / smooth it has no TypeScript twin: it is native-only and deterministic (single thread, fixed seed).

use crate::JobError;
use llull_quadflow::QuadParams;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuadJob {
    /// Wanted number of output quads (the result lands within about 15 % of it).
    pub target_faces: i32,
    /// Align the quads to edges whose faces turn by more than this angle (radians); absent = no alignment.
    pub hard_edge_rad: Option<f64>,
    pub adaptive: bool,
    /// The input is open: boundary edges are treated as sharp edges (the quads follow them).
    #[serde(default)]
    pub preserve_boundary: bool,
}

/// `(positions, quads)` of the remeshed surface; the host checks that the input is manifold, consistently wound and free of degenerate faces.
/// `on_stage(name, fraction)` hears each QuadriFlow stage as it starts.
pub fn quad_remesh(
    positions: &[f64],
    triangles: &[u32],
    job: &QuadJob,
    on_stage: &mut dyn FnMut(&str, f64),
) -> Result<(Vec<f64>, Vec<u32>), JobError> {
    if job.target_faces < 1 {
        return Err(JobError { code: "NATIVE_JOB_INPUT", message: format!("targetFaces {} must be at least 1", job.target_faces) });
    }
    let sharp_cos = job.hard_edge_rad.map(|angle| crate::cosine_of("hardEdgeRad", angle)).transpose()?;
    let params = QuadParams {
        target_faces: job.target_faces,
        preserve_sharp: sharp_cos.is_some(),
        sharp_cos: sharp_cos.unwrap_or(0.0),
        adaptive: job.adaptive,
        preserve_boundary: job.preserve_boundary,
    };
    let mesh = llull_quadflow::quad_remesh_with_stages(positions, triangles, &params, on_stage)
        .map_err(|error| JobError { code: "QUAD_REMESH_FAILED", message: error.0 })?;
    if mesh.quads.is_empty() {
        return Err(JobError { code: "QUAD_REMESH_FAILED", message: "QuadriFlow produced no quad".to_string() });
    }
    Ok((mesh.positions, mesh.quads))
}

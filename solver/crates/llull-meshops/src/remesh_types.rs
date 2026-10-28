//! The parameters and results of a remesh (see `remesh.rs`).

use crate::geom::Sphere;
pub use crate::remesh_quality::Adaptive;
use serde::Serialize;

/// Triangles the working mesh may reach before the splitting stops with a refusal (same in the TypeScript engine, `REMESH_MAX_TRIANGLES`).
pub const MAX_TRIANGLES: usize = 4_000_000;

pub struct RemeshParams {
    pub target_edge: Option<f64>,
    pub adaptive: Option<Adaptive>,
    pub iterations: usize,
    pub feature_angle: f64,
    /// Cosine of the feature angle (`Math.cos` by the V8 twin of `llull-jsmath`).
    pub feature_cos: f64,
    pub preserve_boundary: bool,
    pub project: bool,
    pub region: Option<Sphere>,
    pub max_triangles: usize,
}

#[derive(Debug, Serialize)]
pub struct EdgeStats {
    pub min: f64,
    pub max: f64,
    pub mean: f64,
    pub p5: f64,
    pub p95: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemeshReport {
    pub mode: &'static str,
    pub iterations: usize,
    pub triangles_before: usize,
    pub triangles_after: usize,
    pub splits: u64,
    pub collapses: u64,
    pub flips: u64,
    pub edge_length: EdgeStats,
    pub fraction_in_band: f64,
    pub feature_edges: usize,
}

/// The result, or the number of triangles the working mesh had when it passed the limit.
pub enum Remeshed {
    Done(Vec<f64>, Vec<u32>, RemeshReport),
    TooLarge(usize),
}

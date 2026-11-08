//! `llull-compute field` op `tets` (FLL-M1, `field_to_tets` of 14 FLL TECHNICAL_SPEC §2): a tetrahedral FE mesh of {f < 0} straight from the
//! field program (`stuffing.rs`), its quality (`tet_quality.rs`), second order on request (`tet_order2.rs`) and its targets (`tet_targets.rs`).
//!
//! job.json: `{ op: "tets", program, grid: {min, max, voxel}, order: 1 | 2, maxLatticeVertices, maxTets, lengthScale, targets: [{key,
//! facesNear?, pointsNear?, edgesNear?, global?}] }`, lengths in document units; `lengthScale` turns them into the analysis unit.
//! Out: `nodes.f64` (x y z per node, analysis unit: the corners, then one mid-edge node per edge when order 2), `elements.u32` (4 or 10 node
//! indices per element, 0-based, C3D4 / C3D10 order), `report.json` (counts, volume in document units^3, dihedral angles, folds, sets with
//! 0-based node / element indices, residuals in the analysis unit) or `report.json` alone with a `refusal`.
//! @invariant the lattice-vertex budget is checked before the field is evaluated; the tetrahedron budget stops stuffing as soon as it is passed
//! @invariant progress events (`message` = phase) are emitted at every whole percent the phases reach, and at least every HEARTBEAT while a
//!   phase keeps reporting (lattice planes, root-search chunks, stuffing layers, the quality scan, projection chunks, every undo pass), so a
//!   host can bound the job on its progress; no single uninterrupted step is longer than one parallel sort or pass over the elements

use crate::eval::Evaluator;
use crate::files::{f64_bytes, input_error, u32_bytes, write_file, JobError};
use crate::sampling::Grid;
use crate::stuffing::{crossings, cut_points, lattice_signs, orient, warp, Lattice, Stuffer, TetBudget};
use crate::tet_order2::{element_volume, order2};
use crate::tet_quality::{analyse, Quality};
use crate::tet_targets::{resolve, Surface, TargetSpec};
use llull_protocol::{emit, Event, Output};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::cell::RefCell;
use std::io::Write;
use std::path::Path;
use std::time::{Duration, Instant};

#[derive(Debug, Deserialize)]
struct GridSpec {
    min: [f64; 3],
    max: [f64; 3],
    voxel: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TetsJob {
    grid: GridSpec,
    order: u8,
    max_lattice_vertices: u64,
    max_tets: u64,
    length_scale: f64,
    #[serde(default)]
    targets: Vec<TargetSpec>,
}

/// Hard caps whatever the job asks: lattice ids and output node indices are u32.
const LATTICE_VERTEX_CAP: u64 = 1 << 30;
const TET_CAP: u64 = 1 << 28;
/// Root searches run in this many chunks, one progress step each.
const CUT_CHUNKS: usize = 10;

fn refusal(code: &str, message: String, samples: Option<u64>, limit: Option<u64>) -> Value {
    json!({ "refusal": { "code": code, "message": message, "samples": samples, "limit": limit } })
}

/// Longest silence between two progress events while a phase reports.
const HEARTBEAT: Duration = Duration::from_secs(5);

/// One progress event per whole percent of the job (phases own fixed spans of the 100 steps), repeated every HEARTBEAT when the percent
/// does not move.
struct Progress<'a, W: Write> {
    out: &'a mut W,
    last: u64,
    at: Instant,
}

impl<W: Write> Progress<'_, W> {
    fn at(&mut self, phase: &str, start: u64, span: u64, done: usize, of: usize) {
        let step = start + span * done as u64 / of.max(1) as u64;
        if step != self.last || self.at.elapsed() >= HEARTBEAT {
            self.last = step;
            self.at = Instant::now();
            let _ = emit(self.out, &Event::Progress { step, total: 100, message: phase, detail: None });
        }
    }
}

fn quality_json(q: &Quality) -> Value {
    let below: Map<String, Value> = Quality::bounds().iter().zip(q.below).map(|(b, n)| (format!("{b}"), json!(n))).collect();
    json!({
        "minDihedralDeg": q.min_dihedral_deg,
        "maxDihedralDeg": q.max_dihedral_deg,
        "tetsBelowDeg": below,
        "folded": q.folded,
        "nonManifold": q.non_manifold,
        "inverted": q.inverted,
        "degenerate": q.degenerate,
        "open": q.open,
    })
}

/// Runs a `tets` job; `text` is job.json. Returns the report body (written by the caller).
pub fn tets_job(
    folder: &Path,
    text: &str,
    evaluator: &Evaluator,
    out: &mut impl Write,
    outputs: &mut Vec<Output>,
) -> Result<Value, JobError> {
    let job: TetsJob = serde_json::from_str(text).map_err(|error| input_error(format!("job.json: {error}")))?;
    if job.order != 1 && job.order != 2 {
        return Err(input_error(format!("job.json: order must be 1 or 2, got {}", job.order)));
    }
    if !(job.length_scale > 0.0 && job.length_scale.is_finite()) {
        return Err(input_error(format!("job.json: lengthScale must be > 0, got {}", job.length_scale)));
    }
    let Some(grid) = Grid::new(job.grid.min, job.grid.max, job.grid.voxel) else {
        return Ok(refusal(
            "IMP_ENGINE_FAILED",
            format!("invalid grid: voxel {} over {:?}..{:?}", job.grid.voxel, job.grid.min, job.grid.max),
            None,
            None,
        ));
    };
    let (max_vertices, max_tets) = (job.max_lattice_vertices.min(LATTICE_VERTEX_CAP), job.max_tets.min(TET_CAP));
    let vertices = Lattice::vertex_count(&grid);
    if vertices > max_vertices {
        return Ok(refusal(
            "FLL_IMPLICIT_MESH_TOO_LARGE",
            format!("{vertices} lattice vertices exceed the limit of {max_vertices}: raise the mesh size"),
            Some(vertices),
            Some(max_vertices),
        ));
    }
    let mut progress = Progress { out, last: u64::MAX, at: Instant::now() };
    let lattice = Lattice::new(grid);
    let (mut signs, clipped) = lattice_signs(evaluator, &lattice, &mut |d, n| progress.at("lattice", 0, 40, d, n));
    let edges = crossings(&lattice, &signs);
    let chunk = edges.len().div_ceil(CUT_CHUNKS).max(1);
    let mut cuts = Vec::with_capacity(edges.len());
    for (done, part) in edges.chunks(chunk).enumerate() {
        cuts.extend(cut_points(evaluator, &lattice, part));
        progress.at("cut points", 40, 10, done + 1, edges.len().div_ceil(chunk));
    }
    let warped = warp(&mut signs, &edges, &cuts);
    let registers = RefCell::new(vec![0.0; evaluator.instrs.len()]);
    let inside = |p: [f64; 3]| evaluator.value_at(&mut registers.borrow_mut(), p[0], p[1], p[2]) < 0.0;
    let stuffer = Stuffer { lattice: &lattice, signs: &signs, edges: &edges, cuts: &cuts, warped: &warped, inside: &inside };
    let stuffed = match stuffer.run(max_tets, &mut |d, n| progress.at("stuffing", 50, 20, d, n)) {
        Ok(stuffed) => stuffed,
        Err(TetBudget(reached)) => {
            return Ok(refusal(
                "FLL_IMPLICIT_MESH_TOO_LARGE",
                format!("more than {max_tets} tetrahedra (at least {reached}) exceed the budget of {max_tets}: raise the mesh size"),
                Some(reached),
                Some(max_tets),
            ))
        }
    };
    if stuffed.tets.is_empty() {
        return Ok(refusal("IMP_BODY_EMPTY", "no lattice vertex of the grid is inside the field".to_string(), None, None));
    }
    progress.at("quality", 70, 0, 0, 1);
    let (quality, boundary) =
        analyse(&stuffed.positions, &stuffed.tets, &stuffed.surface, &mut |d, n| progress.at("quality", 70, 10, d, n));
    progress.at("second order", 80, 0, 0, 1);
    let quadratic = (job.order == 2)
        .then(|| order2(evaluator, &stuffed.positions, &stuffed.tets, &boundary, &mut |d, n| progress.at("second order", 80, 10, d, n)));
    let linear_volume: f64 = stuffed.tets.iter().map(|t| orient(&t.map(|v| stuffed.positions[v as usize])) / 6.0).sum();
    let volume = match &quadratic {
        None => linear_volume,
        Some(q) => {
            let corners = stuffed.positions.len() as u32;
            q.elements
                .iter()
                .map(|row| {
                    element_volume(&row.map(|v| if v < corners { stuffed.positions[v as usize] } else { q.mids[(v - corners) as usize] }))
                })
                .sum()
        }
    };
    progress.at("targets", 90, 0, 0, 1);
    let (mids, mid_edges): (&[[f64; 3]], &[(u32, u32)]) = match &quadratic {
        Some(q) => (&q.mids, &q.edges),
        None => (&[], &[]),
    };
    let surface = Surface { positions: &stuffed.positions, mids, mid_edges, boundary: &boundary, spacing: grid.voxel, evaluator };
    let (sets, nearest) = match resolve(&surface, &job.targets) {
        Ok(found) => found,
        Err(failure) => return Ok(refusal(failure.code, failure.message, None, None)),
    };
    let scale = job.length_scale;
    let nodes: Vec<f64> = stuffed.positions.iter().chain(mids.iter()).flat_map(|p| p.map(|c| c * scale)).collect();
    let elements: Vec<u32> = match &quadratic {
        Some(q) => q.elements.iter().flatten().copied().collect(),
        None => stuffed.tets.iter().flatten().copied().collect(),
    };
    outputs.push(write_file(folder, "nodes.f64", &f64_bytes(&nodes))?);
    outputs.push(write_file(folder, "elements.u32", &u32_bytes(&elements))?);
    let sets_json: Map<String, Value> = sets
        .iter()
        .map(|s| {
            let faces: Vec<[i64; 2]> = s.faces.iter().map(|&(e, l)| [i64::from(e), i64::from(l)]).collect();
            (s.key.clone(), json!({ "nodes": s.nodes, "faces": faces, "residual": s.residual * scale }))
        })
        .collect();
    let nearest_json: Map<String, Value> =
        nearest.iter().map(|n| (n.key.clone(), json!({ "node": n.node, "distance": n.distance * scale }))).collect();
    Ok(json!({
        "nodes": nodes.len() / 3,
        "elements": stuffed.tets.len(),
        "order": job.order,
        "latticeVertices": vertices,
        "crossingEdges": edges.len(),
        "warpedVertices": warped.len(),
        "steinerVertices": stuffed.steiner,
        "clippedCorners": clipped,
        "boundaryFaces": boundary.len(),
        "volume": volume,
        "linearVolume": linear_volume,
        "quality": quality_json(&quality),
        "curvedMidNodes": quadratic.as_ref().map_or(0, |q| q.curved),
        "revertedMidNodes": quadratic.as_ref().map_or(0, |q| q.reverted),
        "sets": sets_json,
        "nearest": nearest_json,
    }))
}

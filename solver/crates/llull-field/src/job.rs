//! The jobs of `llull-compute field <folder>`: `mesh`, `measure` and `evaluate` (contract in `lib.rs`). A budget refusal is a normal answer
//! (`report.json` with a `refusal`), a malformed folder is a `JobError`.

use crate::components::{components, solid_nodes, Component};
use crate::dual_contour::{dual_contour, OverBudget};
use crate::eval::Evaluator;
use crate::files::{f64_bytes, input_error, read_f64, u32_bytes, write_file, JobError};
use crate::gradient::GradientScratch;
use crate::measure::{quantiles, volume};
use crate::sampling::{fill_plane, Grid, PlaneStats, Tiles};
use crate::tape::{Program, ProgramSpec};
use crate::tetra::{extract, is_closed_manifold, IsoMesh, TriangleBudget};
use llull_protocol::{emit, Event, Output};
use rayon::prelude::*;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::Write;
use std::path::Path;
use std::time::Instant;

/// Nodes of a `components` request and cells of a `quantile` request the native engine holds in memory (flags + queue, sorted samples).
const COMPONENT_NODES: u64 = 1 << 26;
const QUANTILE_CELLS: u64 = 1 << 27;

#[derive(Debug, Deserialize)]
struct GridSpec {
    min: [f64; 3],
    max: [f64; 3],
    voxel: f64,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Request {
    Volume { sampling: String },
    Quantile { probabilities: Vec<f64>, absolute: bool },
    Components,
    Nodes,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Job {
    op: String,
    program: ProgramSpec,
    #[serde(default)]
    region: Option<ProgramSpec>,
    #[serde(default)]
    grid: Option<GridSpec>,
    #[serde(default)]
    max_samples: u64,
    #[serde(default)]
    max_triangles: u64,
    #[serde(default)]
    request: Option<Request>,
    #[serde(default)]
    points: usize,
    #[serde(default)]
    gradient: bool,
    /// `tetra` (default) or `dual_contouring` (a mesh that is not a closed manifold falls back to the tetrahedra).
    #[serde(default)]
    mesher: String,
    /// Grid nodes the dual-contouring sign grid (one byte per node) may hold.
    #[serde(default)]
    max_dual_contouring_samples: u64,
}

fn refusal(code: &str, message: String, samples: Option<u64>, limit: Option<u64>) -> Value {
    json!({ "refusal": { "code": code, "message": message, "samples": samples, "limit": limit } })
}

fn report(folder: &Path, mut body: Value, started: Instant, outputs: &mut Vec<Output>) -> Result<(), JobError> {
    if let Value::Object(map) = &mut body {
        map.insert("threads".to_string(), json!(rayon::current_num_threads()));
        map.insert("ms".to_string(), json!(started.elapsed().as_millis()));
    }
    outputs.push(write_file(folder, "report.json", body.to_string().as_bytes())?);
    Ok(())
}

fn grid_of(spec: &Option<GridSpec>) -> Result<Result<Grid, Value>, JobError> {
    let spec = spec.as_ref().ok_or_else(|| input_error("job.json: the grid is missing"))?;
    Ok(Grid::new(spec.min, spec.max, spec.voxel).ok_or_else(|| {
        refusal("IMP_ENGINE_FAILED", format!("invalid grid: voxel {} over {:?}..{:?}", spec.voxel, spec.min, spec.max), None, None)
    }))
}

fn component_json(c: &Component) -> Value {
    json!({ "voxels": c.voxels, "volume": c.volume, "point": c.point, "enclosed": c.enclosed })
}

/// The refusal when the op needs more samples than the engine holds.
fn over_budget(job: &Job, grid: &Grid) -> Option<Value> {
    let (count, limit) = match (job.op.as_str(), &job.request) {
        ("mesh", _) if job.mesher == "dual_contouring" => (grid.node_count(), job.max_samples.min(job.max_dual_contouring_samples)),
        ("mesh", _) => (grid.node_count(), job.max_samples),
        (_, Some(Request::Components | Request::Nodes)) => (grid.node_count(), job.max_samples.min(COMPONENT_NODES)),
        (_, Some(Request::Quantile { .. })) => (grid.cell_count(), job.max_samples.min(QUANTILE_CELLS)),
        _ => (grid.cell_count(), job.max_samples),
    };
    (count > limit)
        .then(|| refusal("IMP_GRID_BUDGET", format!("{count} samples exceed the llull-field limit of {limit}"), Some(count), Some(limit)))
}

/// The mesh and its figures, written to the folder.
struct Meshed {
    mesh: IsoMesh,
    stats: PlaneStats,
    mesher: &'static str,
    fallback: bool,
    split_cells: usize,
}

fn finish_mesh(folder: &Path, evaluator: &Evaluator, grid: &Grid, meshed: Meshed, outputs: &mut Vec<Output>) -> Result<Value, JobError> {
    let Meshed { mesh, stats, mesher, fallback, split_cells } = meshed;
    let total = grid.node_count();
    let residual = mesh
        .positions
        .par_chunks_exact(3)
        .map_init(
            || vec![0.0; evaluator.instrs.len()],
            |regs, p| {
                let v = evaluator.value_at(regs, p[0], p[1], p[2]);
                if v.is_finite() {
                    v.abs()
                } else {
                    0.0
                }
            },
        )
        .reduce(|| 0.0, f64::max);
    let vertices = mesh.positions.len() / 3;
    let closed = is_closed_manifold(vertices, &mesh.indices);
    outputs.push(write_file(folder, "positions.f64", &f64_bytes(&mesh.positions))?);
    outputs.push(write_file(folder, "indices.u32", &u32_bytes(&mesh.indices))?);
    Ok(json!({
        "vertices": vertices,
        "triangles": mesh.indices.len() / 3,
        "closedManifold": closed,
        "samples": total,
        "evaluatedSamples": stats.evaluated,
        "prunedFraction": if total == 0 { 0.0 } else { 1.0 - stats.evaluated as f64 / total as f64 },
        "maxVertexResidual": residual,
        "nonFiniteSamples": stats.non_finite,
        "mesher": mesher,
        "mesherFallback": fallback,
        "splitCells": split_cells,
    }))
}

fn triangle_refusal(max: u64, reached: u64) -> Value {
    refusal(
        "IMP_TRIANGLE_BUDGET",
        format!("more than {max} triangles (at least {reached}) exceed the budget of {max}"),
        Some(reached),
        Some(max),
    )
}

/// Marching tetrahedra of the whole grid (the `tetra` mesher, and the fallback of a dual-contouring mesh that is not a closed manifold).
fn tetra_mesh(
    job: &Job,
    evaluator: &Evaluator,
    grid: &Grid,
    tiles: &Tiles,
    out: &mut impl Write,
) -> Result<(IsoMesh, PlaneStats), TriangleBudget> {
    let mut planes = |k: usize, plane: &mut [f64]| fill_plane(evaluator, tiles, grid, k, plane);
    let mut last = 0;
    let mut progress = |layer: usize, layers: usize| {
        let percent = layer * 20 / layers.max(1);
        if percent != last {
            last = percent;
            let _ = emit(out, &Event::Progress { step: layer as u64, total: layers as u64, message: "meshing", detail: None });
        }
    };
    extract(grid, job.max_triangles, &mut planes, &mut progress)
}

/// Sign of every node (1 = value < 0, after the zero snap), x fastest, from the interval-pruned planes.
fn sign_grid(evaluator: &Evaluator, tiles: &Tiles, grid: &Grid) -> (Vec<u8>, PlaneStats) {
    let [sx, sy, sz] = grid.nodes();
    let mut signs = vec![0u8; sx * sy * sz];
    let mut plane = vec![0.0; sx * sy];
    let mut stats = PlaneStats::default();
    for (k, slab) in signs.chunks_exact_mut(sx * sy).enumerate().take(sz) {
        stats = stats.add(fill_plane(evaluator, tiles, grid, k, &mut plane));
        slab.par_iter_mut().zip(plane.par_iter()).for_each(|(sign, &value)| *sign = u8::from(value < 0.0));
    }
    (signs, stats)
}

fn mesh_job(
    folder: &Path,
    job: &Job,
    evaluator: &Evaluator,
    grid: &Grid,
    out: &mut impl Write,
    outputs: &mut Vec<Output>,
) -> Result<Value, JobError> {
    let tiles = Tiles::classify(evaluator, grid);
    let meshed = if job.mesher == "dual_contouring" {
        let (signs, stats) = sign_grid(evaluator, &tiles, grid);
        match dual_contour(evaluator, grid, &signs, job.max_triangles) {
            Err(OverBudget(reached)) => return Ok(triangle_refusal(job.max_triangles, reached)),
            Ok(contoured) if is_closed_manifold(contoured.mesh.positions.len() / 3, &contoured.mesh.indices) => {
                Meshed { mesh: contoured.mesh, stats, mesher: "dual_contouring", fallback: false, split_cells: contoured.split_cells }
            }
            Ok(_) => match tetra_mesh(job, evaluator, grid, &tiles, out) {
                Ok((mesh, _)) => Meshed { mesh, stats, mesher: "tetra", fallback: true, split_cells: 0 },
                Err(TriangleBudget(reached)) => return Ok(triangle_refusal(job.max_triangles, reached)),
            },
        }
    } else {
        match tetra_mesh(job, evaluator, grid, &tiles, out) {
            Ok((mesh, stats)) => Meshed { mesh, stats, mesher: "tetra", fallback: false, split_cells: 0 },
            Err(TriangleBudget(reached)) => return Ok(triangle_refusal(job.max_triangles, reached)),
        }
    };
    finish_mesh(folder, evaluator, grid, meshed, outputs)
}

fn measure_job(
    folder: &Path,
    job: &Job,
    evaluator: &Evaluator,
    region: Option<&Evaluator>,
    grid: &Grid,
    outputs: &mut Vec<Output>,
) -> Result<Value, JobError> {
    let Some(request) = &job.request else {
        return Ok(refusal("IMP_ENGINE_FAILED", "job.json: the request is missing".to_string(), None, None));
    };
    let count = if matches!(request, Request::Components | Request::Nodes) { grid.node_count() } else { grid.cell_count() };
    Ok(match request {
        Request::Volume { sampling } => {
            let m = volume(evaluator, region, grid, sampling == "lowdiscrepancy");
            json!({ "kind": "volume", "volume": m.volume, "regionVolume": m.region_volume, "samples": m.samples, "nonFiniteSamples": m.non_finite })
        }
        Request::Quantile { probabilities, absolute } => {
            json!({ "kind": "quantile", "values": quantiles(evaluator, grid, probabilities, *absolute), "samples": count })
        }
        Request::Components => {
            let (solids, voids) = components(evaluator, region, grid);
            json!({
                "kind": "components",
                "solids": solids.iter().map(component_json).collect::<Vec<_>>(),
                "voids": voids.iter().map(component_json).collect::<Vec<_>>(),
                "samples": count,
            })
        }
        Request::Nodes => {
            outputs.push(write_file(folder, "nodes.u8", &solid_nodes(evaluator, region, grid))?);
            json!({ "kind": "nodes", "nodes": grid.nodes(), "samples": count })
        }
    })
}

fn evaluate_job(folder: &Path, job: &Job, evaluator: &Evaluator, outputs: &mut Vec<Output>) -> Result<Value, JobError> {
    let points = read_f64(folder, "points.f64")?;
    if points.len() != job.points * 3 {
        return Err(input_error(format!("points.f64 holds {} numbers, expected {}", points.len(), job.points * 3)));
    }
    let non_finite_of = |values: &[f64]| values.iter().filter(|v| !v.is_finite()).count();
    if job.gradient {
        let both: Vec<(f64, [f64; 3])> = points
            .par_chunks_exact(3)
            .map_init(|| GradientScratch::new(evaluator.instrs.len()), |scratch, p| evaluator.value_gradient_at(scratch, p[0], p[1], p[2]))
            .collect();
        let values: Vec<f64> = both.iter().map(|(v, _)| *v).collect();
        let gradients: Vec<f64> = both.iter().flat_map(|(_, g)| *g).collect();
        outputs.push(write_file(folder, "values.f64", &f64_bytes(&values))?);
        outputs.push(write_file(folder, "gradients.f64", &f64_bytes(&gradients))?);
        return Ok(json!({ "points": job.points, "nonFiniteSamples": non_finite_of(&values) }));
    }
    let values: Vec<f64> = points
        .par_chunks_exact(3)
        .map_init(|| vec![0.0; evaluator.instrs.len()], |regs, p| evaluator.value_at(regs, p[0], p[1], p[2]))
        .collect();
    let non_finite = non_finite_of(&values);
    outputs.push(write_file(folder, "values.f64", &f64_bytes(&values))?);
    Ok(json!({ "points": job.points, "nonFiniteSamples": non_finite }))
}

/// Runs the job of `folder`; returns the output files (`report.json` always).
pub fn run(folder: &Path, out: &mut impl Write) -> Result<Vec<Output>, JobError> {
    let started = Instant::now();
    let _ = llull_jsmath::take_platform_fallback();
    let text = std::fs::read_to_string(folder.join("job.json"))
        .map_err(|error| JobError { code: "NATIVE_JOB_IO", message: format!("job.json: {error}") })?;
    let job: Job = serde_json::from_str(&text).map_err(|error| input_error(format!("job.json: {error}")))?;
    let program = Program::load(folder, "", &job.program)?;
    let region_program = job.region.as_ref().map(|spec| Program::load(folder, "region_", spec)).transpose()?;
    let mut outputs = Vec::new();
    let invalid = program.validate().or_else(|| region_program.as_ref().and_then(Program::validate));
    if let Some(reason) = invalid {
        report(folder, refusal("IMP_ENGINE_FAILED", format!("invalid field program: {reason}"), None, None), started, &mut outputs)?;
        return Ok(outputs);
    }
    let body = match job.op.as_str() {
        "evaluate" => evaluate_job(folder, &job, &Evaluator::new(&program), &mut outputs)?,
        "mesh" | "measure" => match grid_of(&job.grid)? {
            Err(refused) => refused,
            Ok(grid) => match over_budget(&job, &grid) {
                Some(refused) => refused,
                None => {
                    let evaluator = Evaluator::new(&program);
                    if job.op == "mesh" {
                        mesh_job(folder, &job, &evaluator, &grid, out, &mut outputs)?
                    } else {
                        let region = region_program.as_ref().map(Evaluator::new);
                        measure_job(folder, &job, &evaluator, region.as_ref(), &grid, &mut outputs)?
                    }
                }
            },
        },
        other => return Err(input_error(format!("unknown field op '{other}'"))),
    };
    if llull_jsmath::take_platform_fallback() {
        return Err(JobError {
            code: "NATIVE_UNSUPPORTED_ARGUMENT",
            message: "sin or cos of an argument beyond 2^19 pi / 2 (about 8.2e5), where bit parity with V8 is not guaranteed".to_string(),
        });
    }
    report(folder, body, started, &mut outputs)?;
    Ok(outputs)
}

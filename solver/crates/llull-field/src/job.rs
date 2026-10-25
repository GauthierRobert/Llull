//! The jobs of `llull-compute field <folder>`: `mesh`, `measure` and `evaluate` (contract in `lib.rs`). A budget refusal is a normal answer
//! (`report.json` with a `refusal`), a malformed folder is a `JobError`.

use crate::components::{components, solid_nodes, Component};
use crate::eval::Evaluator;
use crate::files::{f64_bytes, input_error, read_f64, u32_bytes, write_file, JobError};
use crate::measure::{quantiles, volume};
use crate::sampling::{fill_plane, Grid, PlaneStats, Tiles};
use crate::tape::{Program, ProgramSpec};
use crate::tetra::{extract, is_closed_manifold, TriangleBudget};
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
        ("mesh", _) => (grid.node_count(), job.max_samples),
        (_, Some(Request::Components | Request::Nodes)) => (grid.node_count(), job.max_samples.min(COMPONENT_NODES)),
        (_, Some(Request::Quantile { .. })) => (grid.cell_count(), job.max_samples.min(QUANTILE_CELLS)),
        _ => (grid.cell_count(), job.max_samples),
    };
    (count > limit)
        .then(|| refusal("IMP_GRID_BUDGET", format!("{count} samples exceed the llull-field limit of {limit}"), Some(count), Some(limit)))
}

fn mesh_job(
    folder: &Path,
    job: &Job,
    evaluator: &Evaluator,
    grid: &Grid,
    out: &mut impl Write,
    outputs: &mut Vec<Output>,
) -> Result<Value, JobError> {
    let total = grid.node_count();
    let tiles = Tiles::classify(evaluator, grid);
    let mut planes = |k: usize, plane: &mut [f64]| fill_plane(evaluator, &tiles, grid, k, plane);
    let mut last = 0;
    let mut progress = |layer: usize, layers: usize| {
        let percent = layer * 20 / layers.max(1);
        if percent != last {
            last = percent;
            let _ = emit(out, &Event::Progress { step: layer as u64, total: layers as u64, message: "meshing", detail: None });
        }
    };
    let (mesh, stats): (_, PlaneStats) = match extract(grid, job.max_triangles, &mut planes, &mut progress) {
        Ok(done) => done,
        Err(TriangleBudget(reached)) => {
            return Ok(refusal(
                "IMP_TRIANGLE_BUDGET",
                format!("more than {} triangles (at least {reached}) exceed the budget of {}", job.max_triangles, job.max_triangles),
                Some(reached),
                Some(job.max_triangles),
            ))
        }
    };
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
    }))
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
    let values: Vec<f64> = points
        .par_chunks_exact(3)
        .map_init(|| vec![0.0; evaluator.instrs.len()], |regs, p| evaluator.value_at(regs, p[0], p[1], p[2]))
        .collect();
    let non_finite = values.iter().filter(|v| !v.is_finite()).count();
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

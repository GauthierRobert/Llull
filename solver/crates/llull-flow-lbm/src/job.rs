//! `llull-compute flow <job-folder>`: the job folder contract (12 CFD TECHNICAL_SPEC §6, as built in §13 M2; host side
//! `server/src/cfd/flowJobFiles.ts`).
//!
//! # Input: `case.json` (camelCase, unknown fields rejected) + `surface.stl` (binary, metres, case frame)
//!
//! ```json
//! {
//!   "version": 1, "caseId": "re100",
//!   "grid": { "cellM": 0.03125, "minM": [-5, -3, -3], "maxM": [10, 3, 3] },
//!   "flow": { "speedMS": 1.0, "direction": [1, 0, 0], "densityKgM3": 1.0, "viscosityPaS": 0.01 },
//!   "reference": { "areaM2": 0.7853981634, "lengthM": 1.0, "momentPointM": [0, 0, 0], "up": [0, 0, 1] },
//!   "faces": { "xMin": "far_field", "xMax": "far_field", "yMin": "slip", "yMax": "slip", "zMin": "ground", "zMax": "slip" },
//!   "bodies": [{ "entityId": "ball", "triangles": [0, 8192] }],
//!   "surface": "surface.stl",
//!   "settings": { "latticeMach": 0.1, "les": true, "smagorinsky": 0.1, "maxSteps": 200000, "startAveragingTol": 0.005,
//!                 "stopTol": 0.001, "sampleEvery": 0, "historyCap": 1000, "device": "cpu", "cellCap": 50000000 },
//!   "outputs": { "probesM": [[2, 0, 0]], "slices": [{ "originM": [0, 0, 0], "normal": [0, 1, 0], "field": "speed" }],
//!                "surfaceFields": ["p", "cp"] }
//! }
//! ```
//!
//! - `grid` is the fluid box in the case frame (x along the free stream at α = β = 0, z up); one layer of face cells is added
//!   around it. The body must lie strictly inside the box. `direction` is the unit free-stream vector (α, β applied by the host).
//! - `faces`: `far_field` becomes an inlet where the free stream enters (`direction · n < 0`), an outlet where it leaves, a
//!   free-slip wall where it is tangential; `slip` a free-slip wall (also a symmetry plane); `ground` a no-slip wall;
//!   `moving_ground` a no-slip wall moving with the free stream.
//! - `bodies` name the STL triangle ranges `[start, count]` of each entity (forces are summed per body); triangles outside
//!   every range are walls without a body.
//! - `settings`: `latticeMach` sets the time step (TECHNICAL_SPEC §5.3); τ below ½ + 1e-3 without LES is `CFD_UNSTABLE_PARAMS`;
//!   `sampleEvery` 0 = one fiftieth of a flow-through; `device` `cpu | gpu | auto` (a GPU request without a usable adapter runs the
//!   CPU twin with the warning `CFD_GPU_UNAVAILABLE`); `cellCap` refuses larger grids on the CPU (`CFD_MEMORY_EXCEEDED`).
//!
//! # Events (stdout NDJSON, `llull-protocol`)
//!
//! One `progress` per drag sample: `{"step":…,"total":maxSteps,"message":…,"cd":…,"dragN":…,"change":…,"phase":"transient|averaging"}`;
//! `warning` `CFD_GPU_UNAVAILABLE` / `CFD_UNSTABLE_PARAMS`; then `done` with the outputs and their sha256, or `error` with
//! `NATIVE_JOB_IO`, `NATIVE_JOB_INPUT`, `CFD_UNSTABLE_PARAMS`, `CFD_MEMORY_EXCEEDED`, `CFD_SOLVER_FAILED`.
//!
//! # Outputs
//!
//! - `result.json`: [`ResultFile`] — status, forces and coefficients, per-body forces, peaks, probes, grid and lattice facts,
//!   history (capped to `historyCap` rows, always ending with the last sample), device / adapter / deterministic, warnings.
//! - `surface.bin`: per-triangle surface fields (`LLSF` header, see `outputs.rs`); `slice-<k>.bin` per requested slice (`LLSL`).

use crate::cpu::CpuSolver;
use crate::domain::{Domain, MOVING_WALL, SLIP_X, SOLID};
use crate::kernel::Params;
use crate::outputs::{
    coefficients, convert_fields, history_rows, peaks, probes, slice_file, surface_file, Coefficients, Fields, HistoryEntry, Peak, Probe,
    WarningEntry,
};
use crate::solver::{run as run_steady, Backend, BackendInfo, Phase, RunOutcome, RunSettings};
use crate::units::{Lattice, DEFAULT_LATTICE_MACH, MIN_TAU_MARGIN};
use llull_flow_core::grid::Grid;
use llull_flow_core::stl::{read_binary_stl, Triangle};
use llull_flow_core::voxel::{voxelise, Voxelisation, NO_BODY};
use llull_protocol::{emit, sha256_hex, Event, Output};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::Instant;

/// A job failure: a stable code and a message.
#[derive(Debug, Clone, PartialEq)]
pub struct JobError {
    pub code: &'static str,
    pub message: String,
}

fn input(message: impl Into<String>) -> JobError {
    JobError { code: "NATIVE_JOB_INPUT", message: message.into() }
}

fn io(message: impl Into<String>) -> JobError {
    JobError { code: "NATIVE_JOB_IO", message: message.into() }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GridSpec {
    pub cell_m: f64,
    pub min_m: [f64; 3],
    pub max_m: [f64; 3],
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowSpec {
    #[serde(rename = "speedMS")]
    pub speed_ms: f64,
    pub direction: [f64; 3],
    pub density_kg_m3: f64,
    pub viscosity_pa_s: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReferenceSpec {
    pub area_m2: f64,
    pub length_m: f64,
    pub moment_point_m: [f64; 3],
    #[serde(default = "up_z")]
    pub up: [f64; 3],
}

fn up_z() -> [f64; 3] {
    [0.0, 0.0, 1.0]
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FaceKind {
    #[default]
    FarField,
    Slip,
    Ground,
    MovingGround,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct FacesSpec {
    pub x_min: FaceKind,
    pub x_max: FaceKind,
    pub y_min: FaceKind,
    pub y_max: FaceKind,
    pub z_min: FaceKind,
    pub z_max: FaceKind,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BodySpec {
    pub entity_id: String,
    /// `[start, count]` into the STL triangles.
    pub triangles: [usize; 2],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceName {
    #[default]
    Cpu,
    Gpu,
    Auto,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct SettingsSpec {
    pub lattice_mach: f64,
    pub les: bool,
    pub smagorinsky: f64,
    pub max_steps: u64,
    pub start_averaging_tol: f64,
    pub stop_tol: f64,
    /// 0 = one fiftieth of a flow-through.
    pub sample_every: u64,
    pub history_cap: usize,
    pub device: DeviceName,
    pub cell_cap: usize,
}

impl Default for SettingsSpec {
    fn default() -> SettingsSpec {
        SettingsSpec {
            lattice_mach: DEFAULT_LATTICE_MACH,
            les: true,
            smagorinsky: 0.1,
            max_steps: 200_000,
            start_averaging_tol: 0.005,
            stop_tol: 0.001,
            sample_every: 0,
            history_cap: 1000,
            device: DeviceName::Cpu,
            cell_cap: 50_000_000,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SliceField {
    Speed,
    P,
    Ux,
    Uy,
    Uz,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SliceSpec {
    pub origin_m: [f64; 3],
    pub normal: [f64; 3],
    pub field: SliceField,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct OutputsSpec {
    pub probes_m: Vec<[f64; 3]>,
    pub slices: Vec<SliceSpec>,
    pub surface_fields: Vec<String>,
}

/// The whole `case.json`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobFile {
    pub version: u32,
    pub case_id: String,
    pub grid: GridSpec,
    pub flow: FlowSpec,
    pub reference: ReferenceSpec,
    #[serde(default)]
    pub faces: FacesSpec,
    #[serde(default)]
    pub bodies: Vec<BodySpec>,
    #[serde(default = "default_surface")]
    pub surface: String,
    #[serde(default)]
    pub settings: SettingsSpec,
    #[serde(default)]
    pub outputs: OutputsSpec,
}

fn default_surface() -> String {
    "surface.stl".to_string()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridInfo {
    pub nx: usize,
    pub ny: usize,
    pub nz: usize,
    pub cell_m: f64,
    pub cells: usize,
    pub fluid_cells: usize,
    pub solid_cells: usize,
    pub odd_rows: usize,
    pub origin_m: [f64; 3],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatticeInfo {
    pub tau: f64,
    pub u_lattice: f64,
    pub nu_lattice: f64,
    pub dt_s: f64,
    pub flow_through_steps: u64,
    pub sample_every: u64,
    pub les: bool,
    pub smagorinsky: f64,
    pub reynolds: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BodyForce {
    pub entity_id: String,
    pub force_n: [f64; 3],
}

/// `result.json`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultFile {
    pub version: u32,
    pub case_id: String,
    pub solver: &'static str,
    pub status: &'static str,
    pub converged: bool,
    pub steps: u64,
    pub averaged_steps: u64,
    pub samples: u32,
    pub time_s: f64,
    pub elapsed_s: f64,
    pub device: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapter: Option<String>,
    pub deterministic: bool,
    pub precision: &'static str,
    pub grid: GridInfo,
    pub lattice: LatticeInfo,
    pub forces: Coefficients,
    pub per_body: Vec<BodyForce>,
    pub peaks: Vec<Peak>,
    pub probes: Vec<Probe>,
    pub history: Vec<HistoryEntry>,
    pub settings: SettingsSpec,
    pub surface: String,
    pub slices: Vec<String>,
    pub not_modelled: Vec<&'static str>,
    pub warnings: Vec<WarningEntry>,
}

fn normalise(v: [f64; 3]) -> Option<[f64; 3]> {
    let length = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    (length > 1e-12).then(|| [v[0] / length, v[1] / length, v[2] / length])
}

fn validate(job: &JobFile) -> Result<[f64; 3], JobError> {
    if job.version != 1 {
        return Err(input(format!("case.json version {} is not 1", job.version)));
    }
    let positive =
        |value: f64, name: &str| if value > 0.0 && value.is_finite() { Ok(()) } else { Err(input(format!("{name} must be > 0"))) };
    positive(job.grid.cell_m, "grid.cellM")?;
    positive(job.flow.speed_ms, "flow.speedMS")?;
    positive(job.flow.density_kg_m3, "flow.densityKgM3")?;
    positive(job.flow.viscosity_pa_s, "flow.viscosityPaS")?;
    positive(job.reference.area_m2, "reference.areaM2")?;
    positive(job.reference.length_m, "reference.lengthM")?;
    if (0..3).any(|axis| !matches!(job.grid.max_m[axis].partial_cmp(&job.grid.min_m[axis]), Some(std::cmp::Ordering::Greater))) {
        return Err(input("grid.maxM must exceed grid.minM on every axis"));
    }
    let settings = &job.settings;
    if !(settings.lattice_mach > 0.0 && settings.lattice_mach <= 0.3) {
        return Err(input("settings.latticeMach must be in (0, 0.3]"));
    }
    if settings.max_steps == 0 {
        return Err(input("settings.maxSteps must be >= 1"));
    }
    normalise(job.flow.direction).ok_or_else(|| input("flow.direction must be a non-zero vector"))
}

/// Builds the domain: the fluid box plus one face layer, the voxelised body strictly inside.
fn build_domain(
    job: &JobFile,
    triangles: &[Triangle],
    body_of_triangle: &[u16],
    direction: [f64; 3],
) -> Result<(Domain, Voxelisation), JobError> {
    let h = job.grid.cell_m;
    let inner = Grid::covering(job.grid.min_m, job.grid.max_m, h);
    let grid = Grid {
        nx: inner.nx + 2,
        ny: inner.ny + 2,
        nz: inner.nz + 2,
        h,
        origin: [inner.origin[0] - h, inner.origin[1] - h, inner.origin[2] - h],
    };
    if grid.cells() > job.settings.cell_cap {
        return Err(JobError {
            code: "CFD_MEMORY_EXCEEDED",
            message: format!(
                "{} cells exceed the cap of {} (settings.cellCap): coarsen the grid (cellM {h}) or shrink the domain",
                grid.cells(),
                job.settings.cell_cap
            ),
        });
    }
    let voxels = voxelise(&grid, triangles, body_of_triangle);
    let n = [grid.nx, grid.ny, grid.nz];
    for (cell, solid) in voxels.solid.iter().enumerate() {
        let (i, j, k) = grid.coords(cell);
        if *solid && [i, j, k].iter().zip(n).any(|(at, count)| *at == 0 || *at + 1 == count) {
            return Err(input("the body reaches the domain boundary: enlarge grid.minM / grid.maxM"));
        }
    }
    let mut domain = Domain::new(grid, [false; 3]);
    let faces = [
        (0, false, job.faces.x_min),
        (0, true, job.faces.x_max),
        (1, false, job.faces.y_min),
        (1, true, job.faces.y_max),
        (2, false, job.faces.z_min),
        (2, true, job.faces.z_max),
    ];
    // Inflow / outflow faces first, then walls, then slip faces: the first flag set wins at edges.
    let flag_of = |axis: usize, high: bool, kind: FaceKind| -> u8 {
        match kind {
            FaceKind::FarField => {
                let outward = if high { direction[axis] } else { -direction[axis] };
                if outward < -1e-9 {
                    crate::domain::INLET
                } else if outward > 1e-9 {
                    crate::domain::OUTLET
                } else {
                    SLIP_X + axis as u8
                }
            }
            FaceKind::Slip => SLIP_X + axis as u8,
            FaceKind::Ground => SOLID,
            FaceKind::MovingGround => MOVING_WALL,
        }
    };
    let priority = |flag: u8| match flag {
        crate::domain::INLET | crate::domain::OUTLET => 0,
        SOLID | MOVING_WALL => 1,
        _ => 2,
    };
    let mut ordered: Vec<(usize, bool, u8)> = faces.iter().map(|(axis, high, kind)| (*axis, *high, flag_of(*axis, *high, *kind))).collect();
    ordered.sort_by_key(|(_, _, flag)| priority(*flag));
    for (axis, high, flag) in ordered {
        domain.set_face(axis, high, flag);
    }
    domain.set_solids(&voxels, job.bodies.len());
    Ok((domain, voxels))
}

fn body_ids(job: &JobFile, triangles: usize) -> Result<Vec<u16>, JobError> {
    let mut ids = vec![NO_BODY; triangles];
    for (b, body) in job.bodies.iter().enumerate() {
        let [start, count] = body.triangles;
        if start + count > triangles {
            return Err(input(format!("bodies[{b}] '{}' names triangles {start}..{} of {triangles}", body.entity_id, start + count)));
        }
        for id in &mut ids[start..start + count] {
            *id = b as u16;
        }
    }
    Ok(ids)
}

/// The backend for `device`, with the fallback warning when a GPU was asked for and the CPU twin answers.
fn backend_for(
    device: DeviceName,
    domain: &Domain,
    params: Params<f64>,
    initial: &dyn Fn(usize) -> (f64, [f64; 3]),
) -> Result<(Box<dyn Backend>, Option<WarningEntry>), JobError> {
    let cpu = |reason: Option<String>| -> Result<(Box<dyn Backend>, Option<WarningEntry>), JobError> {
        let warning = reason.map(|reason| WarningEntry {
            code: "CFD_GPU_UNAVAILABLE".to_string(),
            message: format!("no usable GPU adapter ({reason}): the CPU backend is used (slower)"),
        });
        Ok((Box::new(CpuSolver::<f64>::new(domain.clone(), params, initial)), warning))
    };
    match device {
        DeviceName::Cpu => cpu(None),
        DeviceName::Gpu | DeviceName::Auto => gpu_backend(domain, params, initial).or_else(|reason| {
            if reason.starts_with("CFD_MEMORY_EXCEEDED") {
                Err(JobError { code: "CFD_MEMORY_EXCEEDED", message: reason })
            } else {
                cpu(Some(reason))
            }
        }),
    }
}

#[cfg(feature = "gpu")]
fn gpu_backend(
    domain: &Domain,
    params: Params<f64>,
    initial: &dyn Fn(usize) -> (f64, [f64; 3]),
) -> Result<(Box<dyn Backend>, Option<WarningEntry>), String> {
    let single = |cell: usize| {
        let (rho, u) = initial(cell);
        (rho as f32, [u[0] as f32, u[1] as f32, u[2] as f32])
    };
    crate::gpu::GpuSolver::new(domain, params.cast::<f32>(), single).map(|solver| (Box::new(solver) as Box<dyn Backend>, None))
}

#[cfg(not(feature = "gpu"))]
fn gpu_backend(
    _domain: &Domain,
    _params: Params<f64>,
    _initial: &dyn Fn(usize) -> (f64, [f64; 3]),
) -> Result<(Box<dyn Backend>, Option<WarningEntry>), String> {
    Err("llull-compute was built without the gpu feature".to_string())
}

fn progress_event(out: &mut impl Write, row: &crate::solver::HistoryRow, total: u64, lattice: &Lattice, dynamic_pressure_area: f64) {
    let drag_n = lattice.force_newton(row.drag);
    let mut detail = serde_json::Map::new();
    detail.insert("cd".to_string(), serde_json::json!(drag_n / dynamic_pressure_area));
    detail.insert("dragN".to_string(), serde_json::json!(drag_n));
    detail.insert("change".to_string(), serde_json::json!(if row.change.is_finite() { Some(row.change) } else { None }));
    detail.insert("phase".to_string(), serde_json::json!(if row.phase == Phase::Averaging { "averaging" } else { "transient" }));
    let message = format!(
        "step {}/{total}: drag {drag_n:.6e} N ({})",
        row.step,
        if row.phase == Phase::Averaging { "averaging" } else { "transient" }
    );
    let _ = emit(out, &Event::Progress { step: row.step, total, message: &message, detail: Some(detail) });
}

/// Runs the job in `folder`, streaming events to `out`; returns the outputs with their hashes.
pub fn run(folder: &Path, out: &mut impl Write) -> Result<Vec<Output>, JobError> {
    let started = Instant::now();
    let text = fs::read_to_string(folder.join("case.json")).map_err(|error| io(format!("case.json: {error}")))?;
    let job: JobFile = serde_json::from_str(&text).map_err(|error| input(format!("case.json: {error}")))?;
    let direction = validate(&job)?;
    let stl = fs::read(folder.join(&job.surface)).map_err(|error| io(format!("{}: {error}", job.surface)))?;
    let triangles = read_binary_stl(&stl).map_err(|error| input(format!("{}: {error}", job.surface)))?;
    let body_of_triangle = body_ids(&job, triangles.len())?;
    let (domain, voxels) = build_domain(&job, &triangles, &body_of_triangle, direction)?;

    let settings = job.settings;
    let lattice = Lattice::new(job.grid.cell_m, job.flow.speed_ms, job.flow.viscosity_pa_s, job.flow.density_kg_m3, settings.lattice_mach);
    let mut warnings: Vec<WarningEntry> = Vec::new();
    if lattice.tau < 0.5 + MIN_TAU_MARGIN {
        let message = format!(
            "relaxation time tau {:.6} is within {MIN_TAU_MARGIN} of 0.5 (lattice viscosity {:.3e}): coarsen the grid or raise settings.latticeMach",
            lattice.tau, lattice.nu_lat
        );
        if !settings.les {
            return Err(JobError { code: "CFD_UNSTABLE_PARAMS", message });
        }
        warnings.push(WarningEntry { code: "CFD_UNSTABLE_PARAMS".to_string(), message: format!("{message}; the LES keeps the run going") });
    }
    let u_in = [direction[0] * lattice.u_lat, direction[1] * lattice.u_lat, direction[2] * lattice.u_lat];
    let params = Params {
        tau: lattice.tau,
        smagorinsky: if settings.les { settings.smagorinsky } else { 0.0 },
        u_in,
        u_wall: u_in,
        body_force: [0.0; 3],
    };
    let initial = move |_cell: usize| (1.0f64, u_in);
    let (mut backend, fallback) = backend_for(settings.device, &domain, params, &initial)?;
    warnings.extend(fallback);
    for warning in &warnings {
        let _ = emit(out, &Event::Warning { code: &warning.code, message: &warning.message });
    }

    let length_x = job.grid.max_m[0] - job.grid.min_m[0];
    let flow_through_steps = lattice.flow_through_steps(length_x);
    let sample_every = if settings.sample_every == 0 { (flow_through_steps / 50).max(1) } else { settings.sample_every };
    let h = lattice.h;
    let moment_point = [
        (job.reference.moment_point_m[0] - domain.grid.origin[0]) / h,
        (job.reference.moment_point_m[1] - domain.grid.origin[1]) / h,
        (job.reference.moment_point_m[2] - domain.grid.origin[2]) / h,
    ];
    let run_settings = RunSettings {
        max_steps: settings.max_steps,
        flow_through_steps,
        sample_every,
        start_averaging_tol: settings.start_averaging_tol,
        stop_tol: settings.stop_tol,
        drag_direction: direction,
        moment_point,
    };
    let dynamic_pressure = 0.5 * job.flow.density_kg_m3 * job.flow.speed_ms * job.flow.speed_ms;
    let q_area = dynamic_pressure * job.reference.area_m2;
    let outcome: RunOutcome = run_steady(backend.as_mut(), &domain, &run_settings, &mut |row, total| {
        progress_event(out, row, total, &lattice, q_area);
    })
    .map_err(|message| JobError { code: "CFD_SOLVER_FAILED", message })?;

    let info: BackendInfo = outcome.info.clone();
    let fields: Fields = convert_fields(&domain, &outcome, &lattice);
    let coefficients =
        coefficients(&outcome, &lattice, direction, job.reference.up, dynamic_pressure, job.reference.area_m2, job.reference.length_m);
    let per_body: Vec<BodyForce> = job
        .bodies
        .iter()
        .zip(&outcome.force_per_body)
        .map(|(body, force)| BodyForce {
            entity_id: body.entity_id.clone(),
            force_n: [lattice.force_newton(force[0]), lattice.force_newton(force[1]), lattice.force_newton(force[2])],
        })
        .collect();

    let mut outputs = Vec::new();
    let mut write = |name: &str, bytes: &[u8]| -> Result<(), JobError> {
        fs::write(folder.join(name), bytes).map_err(|error| io(format!("{name}: {error}")))?;
        outputs.push(Output { path: name.to_string(), sha256: sha256_hex(bytes) });
        Ok(())
    };
    let surface_fields: Vec<String> =
        if job.outputs.surface_fields.is_empty() { vec!["p".to_string(), "cp".to_string()] } else { job.outputs.surface_fields.clone() };
    write("surface.bin", &surface_file(&domain, &triangles, &fields, &surface_fields, dynamic_pressure))?;
    let mut slice_names = Vec::new();
    for (k, slice) in job.outputs.slices.iter().enumerate() {
        let name = format!("slice-{k}.bin");
        write(&name, &slice_file(&domain, &fields, slice)?)?;
        slice_names.push(name);
    }
    let converged = outcome.converged;
    let result = ResultFile {
        version: 1,
        case_id: job.case_id.clone(),
        solver: "lbm",
        status: if converged { "converged" } else { "max_steps" },
        converged,
        steps: outcome.steps,
        averaged_steps: outcome.averaged_steps,
        samples: outcome.samples,
        time_s: lattice.time_s(outcome.steps),
        elapsed_s: started.elapsed().as_secs_f64(),
        device: info.device,
        adapter: info.adapter,
        deterministic: info.deterministic,
        precision: info.precision,
        grid: GridInfo {
            nx: domain.grid.nx,
            ny: domain.grid.ny,
            nz: domain.grid.nz,
            cell_m: h,
            cells: domain.grid.cells(),
            fluid_cells: domain.fluid_cells(),
            solid_cells: voxels.solid_cells,
            odd_rows: voxels.odd_rows,
            origin_m: domain.grid.origin,
        },
        lattice: LatticeInfo {
            tau: lattice.tau,
            u_lattice: lattice.u_lat,
            nu_lattice: lattice.nu_lat,
            dt_s: lattice.dt,
            flow_through_steps,
            sample_every,
            les: settings.les,
            smagorinsky: if settings.les { settings.smagorinsky } else { 0.0 },
            reynolds: lattice.reynolds(job.reference.length_m),
        },
        forces: coefficients,
        per_body,
        peaks: peaks(&domain, &fields),
        probes: probes(&domain, &fields, &job.outputs.probes_m),
        history: history_rows(&outcome, &lattice, q_area, settings.history_cap),
        settings,
        surface: "surface.bin".to_string(),
        slices: slice_names,
        not_modelled: vec!["wall-resolved boundary layer (staircase half-way bounce-back walls)", "compressibility beyond O(Ma²)"],
        warnings,
    };
    let json = serde_json::to_vec_pretty(&result).map_err(|error| io(format!("result.json: {error}")))?;
    write("result.json", &json)?;
    Ok(outputs)
}

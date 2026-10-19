//! `llull-compute topopt <job-folder>`: the job folder contract (PHY-17 TECHNICAL_SPEC §13).
//!
//! # Input: `job.json` (camelCase, unknown fields rejected)
//!
//! ```json
//! {
//!   "version": 1,
//!   "dimension": 2,
//!   "grid": { "nx": 60, "ny": 20, "nz": 1, "voxel": 1.0 },
//!   "material": { "e0": 1.0, "nu": 0.3 },
//!   "thickness": 1.0,
//!   "volumeFraction": 0.5,
//!   "active": "active.u8",
//!   "keepIn": "keep_in.u8",
//!   "keepOut": "keep_out.u8",
//!   "fixed": [{ "node": [0, 0], "dofs": [0] }],
//!   "fixedDofs": "fixed.u8",
//!   "loadCases": [{ "name": "lc1", "weight": 1.0, "loads": [{ "node": [0, 20], "force": [0.0, -1.0] }], "forces": "lc1.f64" }],
//!   "settings": {
//!     "penal": 3.0, "eminRatio": 1e-9, "move": 0.2, "changeTol": 0.01, "maxIterations": 300,
//!     "filter": { "kind": "sensitivity", "radius": 1.5 },
//!     "device": "cpu", "solver": "multigrid", "pcgTolerance": 1e-10, "pcgMaxIterations": 10000, "ocTolerance": 1e-3
//!   },
//!   "startDesign": "start.f64",
//!   "startDisplacements": "start_u.f64",
//!   "dofCap": 3000000
//! }
//! ```
//!
//! - Units are consistent and the job does not convert: E0 in MPa (N/mm²), voxel and thickness in mm, forces in N give
//!   compliance in N·mm. Benchmarks use E0 = 1, unit voxel, unit load.
//! - Grid: `nx × ny (× nz)` voxels (`nz` is ignored and may be omitted in 2D). Voxel `(i, j, k)` has index
//!   `i + nx·(j + ny·k)`; node `(i, j, k)`, `0 ≤ i ≤ nx` …, has index `i + (nx+1)·(j + (ny+1)·k)`; DOF `node·dim + c`
//!   (c = 0 x, 1 y, 2 z). y points up (node `[0, ny]` is the top-left corner in 2D). `voxel` scales the 3D element stiffness
//!   (K ∝ E·h) and is echoed in the result; in 2D the in-plane stiffness is size independent and `thickness` scales it.
//! - Masks (`active`, `keepIn`, `keepOut`): optional file names in the job folder, one byte per voxel in voxel order,
//!   non-zero = set. `active` absent = every voxel active. Inactive voxels are removed from the system (no Emin) and their
//!   nodes drop out; keep-in / keep-out on an inactive voxel are ignored; a voxel in both keep masks is an input error.
//! - Supports: `fixed` lists nodes (`[i, j]` in 2D, `[i, j, k]` in 3D) and the components held at 0; `fixedDofs` (optional
//!   file, one byte per DOF, non-zero = fixed) is OR-ed in. Prescribed non-zero displacements are not supported.
//! - Load cases (≥ 1, unique `name`, `weight` ≥ 0, default 1): nodal forces from `loads` (`force` has `dimension` entries)
//!   plus `forces` (optional file of DOF-length little-endian f64). Objective `c = Σ w_lc F_lcᵀ U_lc`.
//! - `settings` (every field optional; defaults are TECHNICAL_SPEC §5.6): `penal` ≥ 1, `eminRatio` ∈ (0, 1) (Emin =
//!   eminRatio·E0), `move` > 0, `changeTol` ≥ 0 (stop when max|Δx| ≤ changeTol), `maxIterations` ≥ 1, `filter.kind`
//!   `sensitivity | density`, `filter.radius` = rmin **in voxels** (> 0), `device` `cpu | gpu | auto`, `solver`
//!   `multigrid | jacobi` (PCG preconditioner), `pcgTolerance` (relative residual), `pcgMaxIterations`, `ocTolerance`.
//! - `startDesign` (optional): design variables x to resume from, little-endian f64 per voxel (a previous run's
//!   `design.f64`); xPhys is recomputed from it.
//! - `startDisplacements` (optional): the warm start of the first solves, little-endian f64, load cases × DOFs in
//!   `loadCases` order (a previous run's `displacements.f64`; zero when absent). With both start files a resumed run
//!   continues the interrupted one bit for bit; with `startDesign` alone it continues it to the PCG tolerance.
//! - `dofCap` (optional): overrides the per-device DOF cap ([`CPU_DOF_CAP`], [`GPU_DOF_CAP`]); above it the job fails with
//!   `TOP_GRID_TOO_LARGE` before allocating. The DOF count is `dim · (nx+1)(ny+1)(nz+1)` (3D) / `2 (nx+1)(ny+1)` (2D).
//!
//! # Events (stdout NDJSON, `llull-protocol`)
//!
//! One `progress` per iteration: `{"type":"progress","step":it,"total":maxIterations,"message":"…","it":it,
//! "compliance":c,"volume":v,"change":Δ}`; `warning` `TOP_GPU_FALLBACK` (GPU asked for but not used, or a GPU solve fell
//! back to the CPU twin); then `done` with the outputs and their sha256, or `error` with a code: `NATIVE_JOB_IO`,
//! `NATIVE_JOB_INPUT`, `TOP_GRID_TOO_LARGE`, `TOP_SOLVER_FAILED` (singular system / PCG not converged).
//!
//! # Outputs
//!
//! - `field.bin`: xPhys as little-endian f32, one per voxel in voxel order (inactive voxels 0).
//! - `design.f64`: the design variables x as little-endian f64 (pass it back as `startDesign` to resume).
//! - `displacements.f64`: per load case (in `loadCases` order) the displacements of the last iteration's solve, which every
//!   solve starts from (warm start), little-endian f64, load cases × DOFs (pass it back as `startDisplacements`).
//! - `result.json`: [`ResultFile`] (camelCase): `version`, `status` (`converged | max_iterations`), `iterations`,
//!   `compliance` (weighted, of the final xPhys), `lastIterationCompliance` (the last history row, top88's printed value),
//!   `perLoadCase` (name → unweighted compliance of the final xPhys), `volumeFraction` (Σ xPhys / active voxels), `grey`
//!   (mean 4x(1−x) over active voxels), `history` (every iteration: `it`, `compliance`, `volume`, `change`), `device`
//!   (`cpu | gpu`, what solved), `deterministic` (true for the CPU twin), `precision` (`f64` | `f32-gpu+f64-refinement`),
//!   `adapter` (GPU only), `solver`, `grid`, `settings` (resolved, with defaults), `field`, `design`, `displacements`,
//!   `fieldSha256`, `warnings`. For the CPU twin every output is byte-identical across runs and thread counts.

use crate::filter::FilterKind;
use crate::simp::{optimise, Device, Engine, HistoryRow, LoadCase, Problem, Settings, Start, TopError, Voxel};
use llull_protocol::{emit, sha256_hex, Event, Output};
use llull_voxfe::{Grid, SolverKind};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::Path;

/// Largest DOF count of a CPU-twin job (VC-TOP-34 measurement, TECHNICAL_SPEC §13).
pub const CPU_DOF_CAP: usize = 1_500_000;
/// Largest DOF count of a GPU job: provisional (no hardware adapter measured yet; bounded by host memory for the f64 refinement).
pub const GPU_DOF_CAP: usize = 10_000_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GridSpec {
    pub nx: usize,
    pub ny: usize,
    #[serde(default = "one_usize")]
    pub nz: usize,
    #[serde(default = "one_f64")]
    pub voxel: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Material {
    pub e0: f64,
    pub nu: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FixedNode {
    pub node: Vec<usize>,
    pub dofs: Vec<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodalLoad {
    pub node: Vec<usize>,
    pub force: Vec<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoadCaseSpec {
    pub name: String,
    #[serde(default = "one_f64")]
    pub weight: f64,
    #[serde(default)]
    pub loads: Vec<NodalLoad>,
    pub forces: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FilterName {
    #[default]
    Sensitivity,
    Density,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceName {
    #[default]
    Cpu,
    Gpu,
    Auto,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SolverName {
    #[default]
    Multigrid,
    Jacobi,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FilterSpec {
    #[serde(default)]
    pub kind: FilterName,
    #[serde(default = "default_radius")]
    pub radius: f64,
}

impl Default for FilterSpec {
    fn default() -> FilterSpec {
        FilterSpec { kind: FilterName::Sensitivity, radius: default_radius() }
    }
}

/// `settings` of `job.json`, echoed resolved in `result.json`.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct SettingsSpec {
    pub penal: f64,
    pub emin_ratio: f64,
    #[serde(rename = "move")]
    pub move_limit: f64,
    pub change_tol: f64,
    pub max_iterations: usize,
    pub filter: FilterSpec,
    pub device: DeviceName,
    pub solver: SolverName,
    pub pcg_tolerance: f64,
    pub pcg_max_iterations: usize,
    pub oc_tolerance: f64,
}

impl Default for SettingsSpec {
    fn default() -> SettingsSpec {
        let s = Settings::default();
        SettingsSpec {
            penal: s.penal,
            emin_ratio: s.emin_ratio,
            move_limit: s.move_limit,
            change_tol: s.change_tol,
            max_iterations: s.max_iterations,
            filter: FilterSpec::default(),
            device: DeviceName::Cpu,
            solver: SolverName::Multigrid,
            pcg_tolerance: s.pcg_tolerance,
            pcg_max_iterations: s.pcg_max_iterations,
            oc_tolerance: s.oc_tolerance,
        }
    }
}

/// The whole `job.json`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobFile {
    pub version: u32,
    pub dimension: usize,
    pub grid: GridSpec,
    pub material: Material,
    #[serde(default = "one_f64")]
    pub thickness: f64,
    pub volume_fraction: f64,
    pub active: Option<String>,
    pub keep_in: Option<String>,
    pub keep_out: Option<String>,
    #[serde(default)]
    pub fixed: Vec<FixedNode>,
    pub fixed_dofs: Option<String>,
    pub load_cases: Vec<LoadCaseSpec>,
    #[serde(default)]
    pub settings: SettingsSpec,
    pub start_design: Option<String>,
    pub start_displacements: Option<String>,
    pub dof_cap: Option<usize>,
}

fn one_usize() -> usize {
    1
}

fn one_f64() -> f64 {
    1.0
}

fn default_radius() -> f64 {
    1.5
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub it: usize,
    pub compliance: f64,
    pub volume: f64,
    pub change: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SolverInfo {
    pub kind: SolverName,
    pub tolerance: f64,
    pub pcg_iterations: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridInfo {
    pub dimension: usize,
    pub nx: usize,
    pub ny: usize,
    pub nz: usize,
    pub voxel: f64,
    pub elements: usize,
    pub active: usize,
    pub keep_in: usize,
    pub keep_out: usize,
    pub dofs: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub path: &'static str,
    pub format: &'static str,
    pub length: usize,
}

#[derive(Debug, Serialize)]
pub struct WarningEntry {
    pub code: &'static str,
    pub message: String,
}

/// `result.json`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultFile {
    pub version: &'static str,
    pub status: &'static str,
    pub iterations: usize,
    pub compliance: f64,
    pub last_iteration_compliance: f64,
    pub per_load_case: BTreeMap<String, f64>,
    pub volume_fraction: f64,
    pub grey: f64,
    pub history: Vec<HistoryEntry>,
    pub device: &'static str,
    pub deterministic: bool,
    pub precision: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapter: Option<String>,
    pub solver: SolverInfo,
    pub grid: GridInfo,
    pub settings: SettingsSpec,
    pub field: FileInfo,
    pub design: FileInfo,
    pub displacements: FileInfo,
    pub field_sha256: String,
    pub warnings: Vec<WarningEntry>,
}

fn input(message: impl Into<String>) -> TopError {
    TopError { code: "NATIVE_JOB_INPUT", message: message.into() }
}

fn read_bytes(folder: &Path, name: &str) -> Result<Vec<u8>, TopError> {
    if name.contains("..") || Path::new(name).is_absolute() {
        return Err(input(format!("{name}: file names must stay inside the job folder")));
    }
    let path = folder.join(name);
    fs::read(&path).map_err(|error| TopError { code: "NATIVE_JOB_IO", message: format!("{}: {error}", path.display()) })
}

fn read_mask(folder: &Path, name: &Option<String>, len: usize) -> Result<Option<Vec<bool>>, TopError> {
    let Some(name) = name else { return Ok(None) };
    let bytes = read_bytes(folder, name)?;
    if bytes.len() != len {
        return Err(input(format!("{name}: {} bytes, expected {len}", bytes.len())));
    }
    Ok(Some(bytes.iter().map(|&b| b != 0).collect()))
}

fn read_f64s(folder: &Path, name: &str, len: usize) -> Result<Vec<f64>, TopError> {
    let bytes = read_bytes(folder, name)?;
    if bytes.len() != len * 8 {
        return Err(input(format!("{name}: {} bytes, expected {len} little-endian f64", bytes.len())));
    }
    Ok(bytes.chunks_exact(8).map(|c| f64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]])).collect())
}

fn node_index(grid: &Grid, node: &[usize]) -> Result<usize, TopError> {
    let [nnx, nny, nnz] = grid.node_dims();
    let (i, j, k) = match (grid.dim, node) {
        (2, [i, j]) | (2, [i, j, 0]) => (*i, *j, 0),
        (3, [i, j, k]) => (*i, *j, *k),
        _ => return Err(input(format!("node {node:?} needs {} indices", grid.dim))),
    };
    if i >= nnx || j >= nny || k >= nnz {
        return Err(input(format!("node {node:?} is outside the {} x {} x {} node grid", nnx, nny, nnz)));
    }
    Ok(grid.node(i, j, k))
}

/// Resolves the grid and checks the DOF cap before anything large is allocated.
pub fn grid_of(job: &JobFile) -> Result<Grid, TopError> {
    let g = &job.grid;
    if job.version != 1 {
        return Err(input(format!("job version {} is not supported (expected 1)", job.version)));
    }
    if g.nx == 0 || g.ny == 0 || g.nz == 0 || !(g.voxel.is_finite() && g.voxel > 0.0) {
        return Err(input("grid sizes must be ≥ 1 and voxel > 0"));
    }
    let (dim, nz) = match job.dimension {
        2 => (2, 1),
        3 => (3, g.nz),
        other => return Err(input(format!("dimension {other} (expected 2 or 3)"))),
    };
    let node_layers = if dim == 3 { nz + 1 } else { 1 };
    let dofs = (g.nx + 1).checked_mul(g.ny + 1).and_then(|v| v.checked_mul(node_layers)).and_then(|v| v.checked_mul(dim));
    let elements = g.nx.checked_mul(g.ny).and_then(|v| v.checked_mul(nz));
    let device = job.settings.device;
    let cap = job.dof_cap.unwrap_or(if device == DeviceName::Cpu { CPU_DOF_CAP } else { GPU_DOF_CAP });
    match (dofs, elements) {
        (Some(dofs), Some(_)) if dofs <= cap => Ok(if dim == 3 { Grid::new_3d(g.nx, g.ny, nz) } else { Grid::new_2d(g.nx, g.ny) }),
        (dofs, _) => Err(TopError {
            code: "TOP_GRID_TOO_LARGE",
            message: format!(
                "{} DOFs exceed the {:?} cap of {cap}; increase the voxel size",
                dofs.map_or_else(|| "too many".to_string(), |d| d.to_string()),
                device
            ),
        }),
    }
}

/// The optional start files of a job: design variables and warm-start displacements.
#[derive(Debug, Clone, Default)]
pub struct StartFiles {
    pub design: Option<Vec<f64>>,
    pub displacements: Option<Vec<f64>>,
}

/// Builds the problem, settings and optional start files from a parsed job.
pub fn problem_of(folder: &Path, job: &JobFile) -> Result<(Problem, Settings, StartFiles), TopError> {
    let grid = grid_of(job)?;
    let (n, dofs, dim) = (grid.elements(), grid.dofs(), grid.dim);
    let active = read_mask(folder, &job.active, n)?.unwrap_or_else(|| vec![true; n]);
    let keep_in = read_mask(folder, &job.keep_in, n)?.unwrap_or_else(|| vec![false; n]);
    let keep_out = read_mask(folder, &job.keep_out, n)?.unwrap_or_else(|| vec![false; n]);
    let mut voxels = Vec::with_capacity(n);
    for e in 0..n {
        voxels.push(match (active[e], keep_in[e], keep_out[e]) {
            (false, _, _) => Voxel::Inactive,
            (true, true, true) => return Err(input(format!("voxel {e} is in both keepIn and keepOut"))),
            (true, true, false) => Voxel::KeepIn,
            (true, false, true) => Voxel::KeepOut,
            (true, false, false) => Voxel::Free,
        });
    }
    let mut fixed = read_mask(folder, &job.fixed_dofs, dofs)?.unwrap_or_else(|| vec![false; dofs]);
    for support in &job.fixed {
        let node = node_index(&grid, &support.node)?;
        for &c in &support.dofs {
            if c >= dim {
                return Err(input(format!("fixed node {:?}: component {c} ≥ dimension {dim}", support.node)));
            }
            fixed[node * dim + c] = true;
        }
    }
    let mut load_cases = Vec::with_capacity(job.load_cases.len());
    for spec in &job.load_cases {
        if load_cases.iter().any(|c: &LoadCase| c.name == spec.name) {
            return Err(input(format!("duplicate load case name '{}'", spec.name)));
        }
        let mut forces = match &spec.forces {
            Some(name) => read_f64s(folder, name, dofs)?,
            None => vec![0.0; dofs],
        };
        for load in &spec.loads {
            let node = node_index(&grid, &load.node)?;
            if load.force.len() != dim || load.force.iter().any(|f| !f.is_finite()) {
                return Err(input(format!("load case '{}': force at {:?} needs {dim} finite components", spec.name, load.node)));
            }
            for (c, f) in load.force.iter().enumerate() {
                forces[node * dim + c] += f;
            }
        }
        load_cases.push(LoadCase { name: spec.name.clone(), weight: spec.weight, forces });
    }
    let s = &job.settings;
    let settings = Settings {
        penal: s.penal,
        emin_ratio: s.emin_ratio,
        move_limit: s.move_limit,
        change_tol: s.change_tol,
        max_iterations: s.max_iterations,
        filter: match s.filter.kind {
            FilterName::Sensitivity => FilterKind::Sensitivity,
            FilterName::Density => FilterKind::Density,
        },
        radius: s.filter.radius,
        oc_tolerance: s.oc_tolerance,
        solver: match s.solver {
            SolverName::Multigrid => SolverKind::Multigrid,
            SolverName::Jacobi => SolverKind::Jacobi,
        },
        pcg_tolerance: s.pcg_tolerance,
        pcg_max_iterations: s.pcg_max_iterations,
        device: match s.device {
            DeviceName::Cpu => Device::Cpu,
            DeviceName::Gpu => Device::Gpu,
            DeviceName::Auto => Device::Auto,
        },
    };
    let problem = Problem {
        grid,
        voxels,
        fixed,
        load_cases,
        e0: job.material.e0,
        nu: job.material.nu,
        thickness: job.thickness,
        voxel: job.grid.voxel,
        volume_fraction: job.volume_fraction,
    };
    let design = match &job.start_design {
        Some(name) => Some(read_f64s(folder, name, n)?),
        None => None,
    };
    let displacements = match &job.start_displacements {
        Some(name) => Some(read_f64s(folder, name, dofs * problem.load_cases.len())?),
        None => None,
    };
    Ok((problem, settings, StartFiles { design, displacements }))
}

fn write(folder: &Path, name: &str, bytes: &[u8]) -> Result<Output, TopError> {
    let path = folder.join(name);
    fs::write(&path, bytes).map_err(|error| TopError { code: "NATIVE_JOB_IO", message: format!("{}: {error}", path.display()) })?;
    Ok(Output { path: name.to_string(), sha256: sha256_hex(bytes) })
}

fn progress_event(out: &mut impl Write, row: &HistoryRow, total: usize) {
    let mut detail = serde_json::Map::new();
    detail.insert("it".to_string(), serde_json::json!(row.it));
    detail.insert("compliance".to_string(), serde_json::json!(row.compliance));
    detail.insert("volume".to_string(), serde_json::json!(row.volume));
    detail.insert("change".to_string(), serde_json::json!(row.change));
    let message = format!("iteration {}: compliance {:.6e}, volume {:.4}, change {:.4}", row.it, row.compliance, row.volume, row.change);
    let _ = emit(out, &Event::Progress { step: row.it as u64, total: total as u64, message: &message, detail: Some(detail) });
}

/// Runs a job folder: reads `job.json`, streams progress and warnings to `out`, writes the outputs and returns them.
pub fn run(folder: &Path, out: &mut impl Write) -> Result<Vec<Output>, TopError> {
    let text = fs::read_to_string(folder.join("job.json"))
        .map_err(|error| TopError { code: "NATIVE_JOB_IO", message: format!("job.json: {error}") })?;
    let job: JobFile = serde_json::from_str(&text).map_err(|error| input(format!("job.json: {error}")))?;
    let (problem, settings, start) = problem_of(folder, &job)?;
    let total = settings.max_iterations;
    // The loop runs on a rayon worker (so its many small parallel steps do not pay a cross-thread injection each) and sends
    // its history rows here, where they are streamed as progress events.
    let (sender, receiver) = std::sync::mpsc::channel::<HistoryRow>();
    let outcome = std::thread::scope(|scope| {
        let worker = scope.spawn(|| {
            let sender = sender;
            rayon::scope(|_| {
                let start = Start { design: start.design.as_deref(), displacements: start.displacements.as_deref() };
                optimise(&problem, &settings, start, &mut |row| {
                    let _ = sender.send(*row);
                })
            })
        });
        for row in receiver {
            progress_event(out, &row, total);
        }
        worker.join().unwrap_or_else(|_| Err(TopError { code: "TOP_SOLVER_FAILED", message: "the solver thread panicked".to_string() }))
    })?;
    let mut warnings: Vec<WarningEntry> =
        outcome.warnings.iter().map(|message| WarningEntry { code: "TOP_GPU_FALLBACK", message: message.clone() }).collect();
    let (device, deterministic, precision, adapter) = match &outcome.engine {
        Engine::Cpu => ("cpu", true, "f64", None),
        Engine::Gpu { adapter } => ("gpu", false, "f32-gpu+f64-refinement", Some(adapter.clone())),
        Engine::CpuFallback { reason } => {
            warnings
                .insert(0, WarningEntry { code: "TOP_GPU_FALLBACK", message: format!("GPU not used ({reason}); solved by the CPU twin") });
            ("cpu", true, "f64", None)
        }
    };
    for warning in &warnings {
        let _ = emit(out, &Event::Warning { code: warning.code, message: &warning.message });
    }
    let field: Vec<u8> = outcome.x_phys.iter().flat_map(|&v| (v as f32).to_le_bytes()).collect();
    let design: Vec<u8> = outcome.x.iter().flat_map(|v| v.to_le_bytes()).collect();
    let displacements: Vec<u8> = outcome.displacements.iter().flatten().flat_map(|v| v.to_le_bytes()).collect();
    let n = problem.grid.elements();
    let count = |kind: Voxel| problem.voxels.iter().filter(|&&v| v == kind).count();
    let result = ResultFile {
        version: env!("CARGO_PKG_VERSION"),
        status: if outcome.converged { "converged" } else { "max_iterations" },
        iterations: outcome.iterations,
        compliance: outcome.compliance,
        last_iteration_compliance: outcome.history.last().map_or(outcome.compliance, |row| row.compliance),
        per_load_case: problem.load_cases.iter().zip(&outcome.per_load_case).map(|(case, c)| (case.name.clone(), *c)).collect(),
        volume_fraction: outcome.volume,
        grey: outcome.grey,
        history: outcome
            .history
            .iter()
            .map(|r| HistoryEntry { it: r.it, compliance: r.compliance, volume: r.volume, change: r.change })
            .collect(),
        device,
        deterministic,
        precision,
        adapter,
        solver: SolverInfo { kind: job.settings.solver, tolerance: settings.pcg_tolerance, pcg_iterations: outcome.pcg_iterations },
        grid: GridInfo {
            dimension: problem.grid.dim,
            nx: problem.grid.nx,
            ny: problem.grid.ny,
            nz: problem.grid.nz,
            voxel: problem.voxel,
            elements: n,
            active: n - count(Voxel::Inactive),
            keep_in: count(Voxel::KeepIn),
            keep_out: count(Voxel::KeepOut),
            dofs: problem.grid.dofs(),
        },
        settings: job.settings,
        field: FileInfo { path: "field.bin", format: "f32le", length: n },
        design: FileInfo { path: "design.f64", format: "f64le", length: n },
        displacements: FileInfo { path: "displacements.f64", format: "f64le", length: displacements.len() / 8 },
        field_sha256: sha256_hex(&field),
        warnings,
    };
    let mut json = serde_json::to_vec_pretty(&result).map_err(|error| input(format!("result.json: {error}")))?;
    json.push(b'\n');
    Ok(vec![
        write(folder, "field.bin", &field)?,
        write(folder, "design.f64", &design)?,
        write(folder, "displacements.f64", &displacements)?,
        write(folder, "result.json", &json)?,
    ])
}

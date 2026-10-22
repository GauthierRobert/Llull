//! `llull-compute flow <job-folder>`: the job folder contract (12 CFD TECHNICAL_SPEC §6, as built in §13 M2; host side
//! `server/src/cfd/flowSolve.ts` runs it, `packages/domain-aero/src/cfd/flowJob.ts` writes the case). Shapes: [`spec`].
//!
//! # Input: `case.json` (camelCase, unknown fields rejected) + `surface.stl` (binary, metres, case frame)
//!
//! ```json
//! {
//!   "version": 1, "caseId": "re100",
//!   "grid": { "cellM": 0.03125, "minM": [-5, -3, -3], "maxM": [10, 3, 3] },
//!   "flow": { "speedMS": 1.0, "direction": [1, 0, 0], "densityKgM3": 1.0, "viscosityPaS": 0.01 },
//!   "reference": { "areaM2": 0.7853981634, "lengthM": 1.0, "momentPointM": [0, 0, 0], "up": [0, 0, 1] },
//!   "faces": { "xMin": "far_field", "xMax": "far_field", "yMin": "symmetry", "yMax": "slip", "zMin": "ground", "zMax": "slip" },
//!   "bodies": [{ "entityId": "ball", "triangles": [0, 8192] }],
//!   "surface": "surface.stl",
//!   "settings": { "latticeMach": 0.1, "les": true, "smagorinsky": 0.1, "maxSteps": 200000, "startAveragingTol": 0.005,
//!                 "stopTol": 0.001, "sampleEvery": 0, "historyCap": 1000, "device": "cpu", "cellCap": 20000000 },
//!   "outputs": { "probesM": [[2, 0, 0]], "slices": [{ "originM": [0, 0, 0], "normal": [0, 1, 0], "field": "speed" }],
//!                "surfaceFields": ["p", "cp"] }
//! }
//! ```
//!
//! - `grid` is the fluid box in the case frame (x along the free stream at α = β = 0, z up); one layer of face cells is added
//!   around it. The body must lie strictly inside the box, except through a `symmetry` face. `direction` is the unit free-stream
//!   vector (α, β applied by the host).
//! - `faces`: `far_field` becomes an inlet where the free stream enters (`direction · n < 0`), an outlet where it leaves, a
//!   free-slip wall where it is tangential; `slip` a free-slip wall; `symmetry` a free-slip plane the body may cross (the STL is
//!   the whole body; only its first row of cells beyond the plane is kept, as the mirror image the fluid next to the plane bounces
//!   off, and the result is mirrored: forces and moments doubled, the force along the plane normal and the moments about the
//!   in-plane axes set to zero, surface fields of the dropped half sampled from their mirror image); `ground` a no-slip wall;
//!   `moving_ground` a no-slip wall moving with the in-plane free stream.
//! - `bodies` name the STL triangle ranges `[start, count]` of each entity (forces are summed per body); triangles outside
//!   every range are walls without a body.
//! - `settings`: `latticeMach` sets the time step (TECHNICAL_SPEC §5.3); τ below ½ + 1e-3 is `CFD_UNSTABLE_PARAMS` without LES
//!   and a warning with it; `sampleEvery` 0 = one fiftieth of a flow-through; `device` `cpu | gpu | auto` (a GPU request without
//!   a usable adapter runs the CPU twin with the warning `CFD_GPU_UNAVAILABLE`); `cellCap` refuses larger grids on the CPU
//!   (`CFD_MEMORY_EXCEEDED`; default 2e7 cells ≈ 8 GB of the f64 twin).
//!
//! # Events (stdout NDJSON, `llull-protocol`)
//!
//! One `progress` per drag sample: `{"step":…,"total":maxSteps,"message":…,"cd":…,"dragN":…,"change":…,"phase":"transient|averaging"}`;
//! `warning` `CFD_GPU_UNAVAILABLE` / `CFD_UNSTABLE_PARAMS`; then `done` with the outputs and their sha256, or `error` with
//! `NATIVE_JOB_IO`, `NATIVE_JOB_INPUT`, `CFD_UNSTABLE_PARAMS`, `CFD_MEMORY_EXCEEDED`, `CFD_SOLVER_FAILED`.
//!
//! # Outputs
//!
//! - `result.json`: [`spec::ResultFile`] — status, forces and coefficients (whole body), per-body forces, peaks, probes, grid,
//!   memory layout (bytes per cell of this run, of the GPU and of the CPU layouts), lattice facts, history (capped to
//!   `historyCap` rows, always ending with the last sample), device / adapter / deterministic / precision, warnings.
//! - `surface.bin`: per-triangle surface fields (`LLSF` header, see `outputs.rs`); `slice-<k>.bin` per requested slice (`LLSL`).

pub mod spec;

use crate::cpu::{bytes_per_cell, CpuSolver};
use crate::domain::{Domain, MOVING_WALL, SLIP_X, SOLID};
use crate::kernel::Params;
use crate::outputs::{coefficients, convert_fields, history_rows, peaks, probes, slice_file, surface_file, Fields, Mirror, WarningEntry};
use crate::solver::{run as run_steady, Backend, BackendInfo, Phase, RunOutcome, RunSettings};
use crate::units::{Lattice, MIN_TAU_MARGIN};
use llull_flow_core::grid::Grid;
use llull_flow_core::stl::{read_binary_stl, Triangle};
use llull_flow_core::voxel::{voxelise, Voxelisation, NO_BODY};
use llull_protocol::{emit, sha256_hex, Event, Output};
use spec::{BodyForce, DeviceName, FaceKind, GridInfo, JobFile, LatticeInfo, MemoryInfo, ResultFile};
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

/// The symmetry faces as `(axis, high)`.
fn symmetry_faces(job: &JobFile) -> Vec<(usize, bool)> {
    job.faces.faces().iter().filter(|(_, _, kind)| *kind == FaceKind::Symmetry).map(|(axis, high, _)| (*axis, *high)).collect()
}

/// Builds the domain: the fluid box plus one face layer, the voxelised body strictly inside except through symmetry faces,
/// whose layer loses its body cells (the mirror image stands there).
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
    let symmetric = symmetry_faces(job);
    // Body cells in a face layer: an error, except in a symmetry layer, where they are the mirror image of the first fluid row's
    // body cells and stay solid (a fluid cell next to the plane then bounces off them exactly as in the whole model).
    for cell in 0..grid.cells() {
        if !voxels.solid[cell] {
            continue;
        }
        let (i, j, k) = grid.coords(cell);
        let at = [i, j, k];
        for axis in 0..3 {
            let (low, high) = (at[axis] == 0, at[axis] + 1 == n[axis]);
            if (low || high) && !symmetric.contains(&(axis, high)) {
                return Err(input("the body reaches the domain boundary: enlarge grid.minM / grid.maxM"));
            }
        }
    }
    let mut domain = Domain::new(grid, [false; 3]);
    // Inflow / outflow faces first, then walls, then slip / symmetry faces: the first flag set wins at edges.
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
            FaceKind::Slip | FaceKind::Symmetry => SLIP_X + axis as u8,
            FaceKind::Ground => SOLID,
            FaceKind::MovingGround => MOVING_WALL,
        }
    };
    let priority = |flag: u8| match flag {
        crate::domain::INLET | crate::domain::OUTLET => 0,
        SOLID | MOVING_WALL => 1,
        _ => 2,
    };
    let mut ordered: Vec<(usize, bool, u8)> =
        job.faces.faces().iter().map(|(axis, high, kind)| (*axis, *high, flag_of(*axis, *high, *kind))).collect();
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

/// Bytes per cell of the GPU layout (every build, so the host can be told without an adapter).
#[cfg(feature = "gpu")]
const GPU_BYTES_PER_CELL: usize = crate::gpu::BYTES_PER_CELL;
#[cfg(not(feature = "gpu"))]
const GPU_BYTES_PER_CELL: usize = (2 * crate::lattice::Q + 1 + 1 + 1 + 3 + 3 + 1 + 3) * 4;

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

/// Mirrors the half model across the plane normal to `axis`: forces and moments doubled, the force along the normal and the
/// moments about the two in-plane axes set to zero (antisymmetric), every history row included.
fn mirror_half_model(outcome: &mut RunOutcome, axis: usize) {
    let mirror_force = |f: &mut [f64; 3]| {
        for (component, value) in f.iter_mut().enumerate() {
            *value = if component == axis { 0.0 } else { 2.0 * *value };
        }
    };
    for force in &mut outcome.force_per_body {
        mirror_force(force);
    }
    for (component, value) in outcome.moment.iter_mut().enumerate() {
        *value = if component == axis { 2.0 * *value } else { 0.0 };
    }
    for row in &mut outcome.history {
        mirror_force(&mut row.force);
        row.drag *= 2.0;
    }
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
        // The moving ground (zMin) slides with the in-plane free stream: a wall-normal component would pump mass through it.
        u_wall: [u_in[0], u_in[1], 0.0],
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
    let symmetric = symmetry_faces(&job);
    let half_model = !symmetric.is_empty();
    let progress_scale = if half_model { 2.0f64.powi(symmetric.len() as i32) } else { 1.0 };
    let mut outcome: RunOutcome = run_steady(backend.as_mut(), &domain, &run_settings, &mut |row, total| {
        let mut whole = *row;
        whole.drag *= progress_scale;
        progress_event(out, &whole, total, &lattice, q_area);
    })
    .map_err(|message| JobError { code: "CFD_SOLVER_FAILED", message })?;
    for (axis, _) in &symmetric {
        mirror_half_model(&mut outcome, *axis);
    }

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
    // Triangles of the dropped half sample their mirror image: the symmetry plane is the fluid box's face on that side.
    let mirrors: Vec<Mirror> =
        symmetric.iter().map(|(axis, high)| (*axis, if *high { job.grid.max_m[*axis] } else { job.grid.min_m[*axis] }, *high)).collect();
    write("surface.bin", &surface_file(&domain, &triangles, &fields, &surface_fields, dynamic_pressure, &mirrors))?;
    let mut slice_names = Vec::new();
    for (k, slice) in job.outputs.slices.iter().enumerate() {
        let name = format!("slice-{k}.bin");
        write(&name, &slice_file(&domain, &fields, slice)?)?;
        slice_names.push(name);
    }
    let converged = outcome.converged;
    let cells = domain.grid.cells();
    let bytes_used = if info.device == "gpu" { GPU_BYTES_PER_CELL } else { bytes_per_cell::<f64>() };
    let mut not_modelled = vec!["wall-resolved boundary layer (staircase half-way bounce-back walls)", "compressibility beyond O(Ma²)"];
    if half_model {
        not_modelled.push("half model: forces and moments doubled by the solver, side force and in-plane moments set to zero (symmetry)");
    }
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
        half_model,
        grid: GridInfo {
            nx: domain.grid.nx,
            ny: domain.grid.ny,
            nz: domain.grid.nz,
            cell_m: h,
            cells,
            fluid_cells: domain.fluid_cells(),
            solid_cells: voxels.solid_cells,
            odd_rows: voxels.odd_rows,
            origin_m: domain.grid.origin,
        },
        memory: MemoryInfo {
            bytes_per_cell: bytes_used,
            gpu_bytes_per_cell: GPU_BYTES_PER_CELL,
            cpu_bytes_per_cell: bytes_per_cell::<f64>(),
            bytes: bytes_used * cells,
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
        not_modelled,
        warnings,
    };
    let json = serde_json::to_vec_pretty(&result).map_err(|error| io(format!("result.json: {error}")))?;
    write("result.json", &json)?;
    Ok(outputs)
}

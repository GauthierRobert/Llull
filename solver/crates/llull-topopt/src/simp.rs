//! The SIMP loop of TECHNICAL_SPEC §5.1 / §5.2 on llull-voxfe.
//!
//! Per iteration: element scales `s_e = (Emin + xPhys_e^p (E0 − Emin)) · g` (g = thickness in 2D, voxel edge in 3D) → one
//! PCG solve per load case from a zero start (so a resumed run continues bit for bit) → `c = Σ_lc w_lc Σ_e s_e u_eᵀk0u_e`,
//! `dc_e = −p (E0 − Emin) xPhys_e^(p−1) g Σ_lc w_lc u_eᵀk0u_e`, `dv_e = 1` → filter → OC → `change = max|x_new − x|`.
//! Stop when `change ≤ changeTol` (converged) or after `maxIterations`. Keep-in / keep-out voxels are pinned to 1 / 0 in
//! both x and xPhys; their sensitivities are dropped before the density-filter chain rule. The volume constraint is
//! `Σ xPhys ≤ volumeFraction · N_active` (keep-in counted).

use crate::filter::{Filter, FilterKind};
use crate::oc::{self, Design, Limits};
use llull_gpu::reduce::{max_abs, sum};
use llull_voxfe::ke::element_matrix;
use llull_voxfe::multigrid::{Multigrid, MultigridSettings};
use llull_voxfe::pcg::{pcg, Jacobi};
use llull_voxfe::MIN_LEN;
use llull_voxfe::{Grid, Operator, SolverKind};
use rayon::prelude::*;

/// What a voxel is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Voxel {
    /// Outside the design domain: removed from the system.
    Inactive,
    Free,
    KeepIn,
    KeepOut,
}

/// One load case: nodal forces (DOF-length) and its objective weight.
#[derive(Debug, Clone, PartialEq)]
pub struct LoadCase {
    pub name: String,
    pub weight: f64,
    pub forces: Vec<f64>,
}

/// A topology optimisation problem on a voxel grid.
#[derive(Debug, Clone, PartialEq)]
pub struct Problem {
    pub grid: Grid,
    pub voxels: Vec<Voxel>,
    /// Dirichlet DOFs (u = 0), DOF-length.
    pub fixed: Vec<bool>,
    pub load_cases: Vec<LoadCase>,
    pub e0: f64,
    pub nu: f64,
    /// Plane-stress thickness (2D only).
    pub thickness: f64,
    /// Voxel edge length (scales the 3D element stiffness).
    pub voxel: f64,
    pub volume_fraction: f64,
}

/// Where the linear solves run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Device {
    Cpu,
    Gpu,
    /// GPU for grids of at least `AUTO_GPU_MIN_DOFS` DOFs on a hardware adapter, else the CPU twin.
    Auto,
}

/// Loop settings (TECHNICAL_SPEC §5.6 named defaults in `Default`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Settings {
    pub penal: f64,
    pub emin_ratio: f64,
    pub move_limit: f64,
    pub change_tol: f64,
    pub max_iterations: usize,
    pub filter: FilterKind,
    /// rmin in voxels.
    pub radius: f64,
    pub oc_tolerance: f64,
    pub solver: SolverKind,
    pub pcg_tolerance: f64,
    pub pcg_max_iterations: usize,
    pub device: Device,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            penal: 3.0,
            emin_ratio: 1e-9,
            move_limit: 0.2,
            change_tol: 0.01,
            max_iterations: 300,
            filter: FilterKind::Sensitivity,
            radius: 1.5,
            oc_tolerance: 1e-3,
            solver: SolverKind::Multigrid,
            pcg_tolerance: 1e-10,
            pcg_max_iterations: 10_000,
            device: Device::Cpu,
        }
    }
}

/// One history row (per iteration, before the OC step: the compliance of the design that was analysed).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HistoryRow {
    pub it: usize,
    pub compliance: f64,
    pub volume: f64,
    pub change: f64,
}

/// Which engine solved the systems.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Engine {
    Cpu,
    Gpu { adapter: String },
    CpuFallback { reason: String },
}

/// Result of a run.
#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    pub x: Vec<f64>,
    pub x_phys: Vec<f64>,
    pub iterations: usize,
    pub converged: bool,
    pub history: Vec<HistoryRow>,
    /// Weighted compliance of the final xPhys (one more solve after the last update).
    pub compliance: f64,
    /// Unweighted compliance of each load case for the final xPhys.
    pub per_load_case: Vec<f64>,
    /// Σ xPhys / N_active.
    pub volume: f64,
    /// mean 4 xPhys (1 − xPhys) over active voxels.
    pub grey: f64,
    pub engine: Engine,
    pub pcg_iterations: usize,
    pub warnings: Vec<String>,
}

/// A failed run: stable code (`TOP_SOLVER_FAILED`, …) and message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TopError {
    pub code: &'static str,
    pub message: String,
}

/// Smallest grid (DOFs) that `device: auto` sends to a hardware GPU.
pub const AUTO_GPU_MIN_DOFS: usize = 500_000;

/// Linear solves on the CPU twin or the GPU.
enum Backend {
    Cpu,
    #[cfg(feature = "gpu")]
    Gpu(Box<llull_voxfe::gpu::GpuOperator>),
}

fn choose_backend(device: Device, op: &Operator) -> (Backend, Engine) {
    match device {
        Device::Cpu => (Backend::Cpu, Engine::Cpu),
        Device::Gpu | Device::Auto => gpu_backend(device, op),
    }
}

#[cfg(feature = "gpu")]
fn gpu_backend(device: Device, op: &Operator) -> (Backend, Engine) {
    if device == Device::Auto && op.grid().dofs() < AUTO_GPU_MIN_DOFS {
        return (Backend::Cpu, Engine::Cpu);
    }
    match llull_gpu::device::acquire("llull-topopt") {
        Ok(gpu) if device == Device::Auto && gpu.software => (Backend::Cpu, Engine::Cpu),
        Ok(gpu) => {
            let adapter = gpu.adapter.clone();
            (Backend::Gpu(Box::new(llull_voxfe::gpu::GpuOperator::new(gpu, op))), Engine::Gpu { adapter })
        }
        Err(_) if device == Device::Auto => (Backend::Cpu, Engine::Cpu),
        Err(reason) => (Backend::Cpu, Engine::CpuFallback { reason }),
    }
}

#[cfg(not(feature = "gpu"))]
fn gpu_backend(device: Device, _op: &Operator) -> (Backend, Engine) {
    match device {
        Device::Auto => (Backend::Cpu, Engine::Cpu),
        _ => (Backend::Cpu, Engine::CpuFallback { reason: "built without the gpu feature".to_string() }),
    }
}

struct Solver<'a> {
    settings: &'a Settings,
    backend: Backend,
    /// The CPU twin's multigrid hierarchy, built on the first CPU solve and updated in place when the scales change.
    multigrid: Option<Multigrid>,
    /// The hierarchy does not match the operator's current scales yet.
    stale: bool,
    pcg_iterations: usize,
    warnings: Vec<String>,
}

impl Solver<'_> {
    fn set_scale(&mut self, op: &Operator) {
        self.stale = true;
        #[cfg(feature = "gpu")]
        if let Backend::Gpu(gpu) = &self.backend {
            gpu.set_scale(op.scale());
        }
        let _ = op;
    }

    fn cpu(&mut self, op: &Operator, b: &[f64]) -> Result<Vec<f64>, TopError> {
        let mut u = vec![0.0; b.len()];
        let (tolerance, cap) = (self.settings.pcg_tolerance, self.settings.pcg_max_iterations);
        let stats = match self.settings.solver {
            SolverKind::Jacobi => pcg(op, &Jacobi::new(op), b, &mut u, tolerance, cap),
            SolverKind::Multigrid => {
                match &mut self.multigrid {
                    Some(multigrid) if self.stale => multigrid.update(op),
                    Some(_) => {}
                    None => self.multigrid = Some(Multigrid::new(op, MultigridSettings::default())),
                }
                self.stale = false;
                let multigrid = self.multigrid.as_ref().unwrap_or_else(|| unreachable!("built above"));
                pcg(op, multigrid, b, &mut u, tolerance, cap)
            }
        }
        .map_err(|error| TopError { code: "TOP_SOLVER_FAILED", message: error.to_string() })?;
        self.pcg_iterations += stats.iterations;
        Ok(u)
    }

    fn solve(&mut self, op: &Operator, b: &[f64]) -> Result<Vec<f64>, TopError> {
        match &self.backend {
            Backend::Cpu => self.cpu(op, b),
            #[cfg(feature = "gpu")]
            Backend::Gpu(gpu) => {
                let mut u = vec![0.0; b.len()];
                match llull_voxfe::gpu::refine(gpu, op, b, &mut u, self.settings.pcg_tolerance, 1e-4, self.settings.pcg_max_iterations) {
                    Ok(stats) => {
                        self.pcg_iterations += stats.inner;
                        Ok(u)
                    }
                    Err(reason) => {
                        if self.warnings.len() < 20 {
                            self.warnings.push(format!("GPU solve failed ({reason}); solved by the CPU twin"));
                        }
                        self.cpu(op, b)
                    }
                }
            }
        }
    }
}

fn element_scales(x_phys: &[f64], voxels: &[Voxel], problem: &Problem, settings: &Settings, geometric: f64) -> Vec<f64> {
    let emin = settings.emin_ratio * problem.e0;
    x_phys
        .par_iter()
        .with_min_len(MIN_LEN)
        .zip(voxels)
        .map(|(&xp, &v)| if v == Voxel::Inactive { 0.0 } else { (emin + xp.powf(settings.penal) * (problem.e0 - emin)) * geometric })
        .collect()
}

/// Weighted compliance, per-case compliances and Σ_lc w_lc u_eᵀk0u_e of the current scales.
fn analyse(op: &Operator, solver: &mut Solver<'_>, problem: &Problem) -> Result<(f64, Vec<f64>, Vec<f64>), TopError> {
    let mut energy = vec![0.0; problem.grid.elements()];
    let mut per_case = Vec::with_capacity(problem.load_cases.len());
    let mut weighted = 0.0;
    for case in &problem.load_cases {
        let u = solver.solve(op, &case.forces)?;
        let ce = op.element_energies(&u);
        let scaled: Vec<f64> = ce.par_iter().with_min_len(MIN_LEN).zip(op.scale()).map(|(c, s)| c * s).collect();
        let c = sum(&scaled);
        per_case.push(c);
        weighted += case.weight * c;
        energy.par_iter_mut().with_min_len(MIN_LEN).zip(&ce).for_each(|(e, c)| *e += case.weight * c);
    }
    Ok((weighted, per_case, energy))
}

/// `value >= min`, false for NaN.
fn at_least(value: f64, min: f64) -> bool {
    value >= min
}

/// Checks sizes and ranges (the job reader reports these as `NATIVE_JOB_INPUT`).
pub fn validate(problem: &Problem, settings: &Settings) -> Result<(), String> {
    let g = problem.grid;
    if problem.voxels.len() != g.elements() || problem.fixed.len() != g.dofs() {
        return Err("voxel / fixed arrays do not match the grid".to_string());
    }
    if problem.load_cases.is_empty() || problem.load_cases.iter().any(|c| c.forces.len() != g.dofs() || !at_least(c.weight, 0.0)) {
        return Err("need at least one load case with DOF-length forces and a weight ≥ 0".to_string());
    }
    let active = problem.voxels.iter().filter(|&&v| v != Voxel::Inactive).count();
    if active == 0 {
        return Err("no active voxel".to_string());
    }
    let positive =
        [problem.e0, problem.thickness, problem.voxel, settings.radius, settings.move_limit, settings.oc_tolerance, settings.pcg_tolerance];
    if positive.iter().any(|v| !(v.is_finite() && *v > 0.0)) {
        return Err("E0, thickness, voxel, filter radius, move, OC and PCG tolerances must be positive".to_string());
    }
    if !(problem.volume_fraction > 0.0 && problem.volume_fraction < 1.0) {
        return Err("volumeFraction must lie in (0, 1)".to_string());
    }
    let max_nu = if g.dim == 3 { 0.5 } else { 1.0 };
    if !(problem.nu > -1.0 && problem.nu < max_nu)
        || !at_least(settings.penal, 1.0)
        || !(settings.emin_ratio > 0.0 && settings.emin_ratio < 1.0)
    {
        return Err("nu out of range, penal < 1, or eminRatio not in (0, 1)".to_string());
    }
    if !at_least(settings.change_tol, 0.0) || settings.max_iterations == 0 || settings.pcg_max_iterations == 0 {
        return Err("changeTol < 0 or a zero iteration cap".to_string());
    }
    Ok(())
}

/// Runs the SIMP loop from `start` (design variables x, element-length; `None` = uniform volume fraction). `progress` sees
/// each history row as it is produced.
pub fn optimise(
    problem: &Problem,
    settings: &Settings,
    start: Option<&[f64]>,
    progress: &mut dyn FnMut(&HistoryRow),
) -> Result<Outcome, TopError> {
    validate(problem, settings).map_err(|message| TopError { code: "NATIVE_JOB_INPUT", message })?;
    let g = problem.grid;
    let n = g.elements();
    let voxels = &problem.voxels;
    let active: Vec<bool> = voxels.iter().map(|&v| v != Voxel::Inactive).collect();
    let active_count = active.iter().filter(|&&a| a).count();
    let design: Vec<Design> = voxels
        .iter()
        .map(|v| match v {
            Voxel::Free => Design::Free,
            Voxel::KeepIn => Design::Pinned(1.0),
            Voxel::KeepOut | Voxel::Inactive => Design::Pinned(0.0),
        })
        .collect();
    let geometric = if g.dim == 3 { problem.voxel } else { problem.thickness };
    let filter = Filter::new(g, &active, settings.radius);
    let pin = |values: Vec<f64>| -> Vec<f64> {
        values.into_iter().zip(&design).map(|(v, d)| if let Design::Pinned(p) = d { *p } else { v }).collect()
    };
    let physical = |x: &[f64]| -> Vec<f64> {
        match settings.filter {
            FilterKind::Sensitivity => pin(x.to_vec()),
            FilterKind::Density => pin(filter.density(x)),
        }
    };
    let mut x: Vec<f64> = match start {
        Some(start) => pin(start.iter().map(|v| v.clamp(0.0, 1.0)).collect()),
        None => pin(vec![problem.volume_fraction; n]),
    };
    // top88 starts from xPhys = x; a resumed run recomputes xPhys from x exactly as the OC step did
    let mut x_phys = if start.is_some() { physical(&x) } else { x.clone() };
    let mut op = Operator::new(
        g,
        element_matrix(g.dim, problem.nu),
        element_scales(&x_phys, voxels, problem, settings, geometric),
        problem.fixed.clone(),
    );
    let (backend, engine) = choose_backend(settings.device, &op);
    let mut solver = Solver { settings, backend, multigrid: None, stale: true, pcg_iterations: 0, warnings: Vec::new() };
    let emin = settings.emin_ratio * problem.e0;
    let target = problem.volume_fraction * active_count as f64;
    let limits = Limits { move_limit: settings.move_limit, tolerance: settings.oc_tolerance, target };
    let mut history = Vec::new();
    let mut change = f64::INFINITY;
    let mut iterations = 0;
    while change > settings.change_tol && iterations < settings.max_iterations {
        iterations += 1;
        if iterations > 1 {
            op.set_scale(element_scales(&x_phys, voxels, problem, settings, geometric));
        }
        solver.set_scale(&op);
        let (compliance, _, energy) = analyse(&op, &mut solver, problem)?;
        let factor = -settings.penal * (problem.e0 - emin) * geometric;
        let mut dc: Vec<f64> = (0..n)
            .into_par_iter()
            .with_min_len(MIN_LEN)
            .map(|e| if design[e] == Design::Free { factor * x_phys[e].powf(settings.penal - 1.0) * energy[e] } else { 0.0 })
            .collect();
        let mut dv: Vec<f64> = design.iter().map(|d| if *d == Design::Free { 1.0 } else { 0.0 }).collect();
        match settings.filter {
            FilterKind::Sensitivity => dc = filter.sensitivity(&x, &dc),
            FilterKind::Density => {
                dc = filter.density_adjoint(&dc);
                dv = filter.density_adjoint(&dv);
            }
        }
        let step = oc::update(&x, &dc, &dv, &design, limits, &physical);
        let difference: Vec<f64> = step.x.iter().zip(&x).map(|(a, b)| a - b).collect();
        change = max_abs(&difference);
        x = step.x;
        x_phys = step.x_phys;
        let row = HistoryRow { it: iterations, compliance, volume: sum(&x_phys) / active_count as f64, change };
        progress(&row);
        history.push(row);
    }
    op.set_scale(element_scales(&x_phys, voxels, problem, settings, geometric));
    solver.set_scale(&op);
    let (compliance, per_load_case, _) = analyse(&op, &mut solver, problem)?;
    let grey_terms: Vec<f64> = x_phys.iter().zip(&active).map(|(x, &a)| if a { 4.0 * x * (1.0 - x) } else { 0.0 }).collect();
    Ok(Outcome {
        volume: sum(&x_phys) / active_count as f64,
        grey: sum(&grey_terms) / active_count as f64,
        x,
        x_phys,
        iterations,
        converged: change <= settings.change_tol,
        history,
        compliance,
        per_load_case,
        engine,
        pcg_iterations: solver.pcg_iterations,
        warnings: solver.warnings,
    })
}

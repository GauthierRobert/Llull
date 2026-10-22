//! The SIMP loop of TECHNICAL_SPEC §5.1 / §5.2 (+ §15 V1) on llull-voxfe.
//!
//! Per iteration: element scales `s_e = (Emin + xPhys_e^p (E0 − Emin)) · g` (g = thickness in 2D, voxel edge in 3D) → one
//! PCG solve per load case (forces `F_fixed + Σ_e xPhys_e f_e` when the case carries gravity), warm-started from that case's
//! previous displacements (zero on the first iteration, or the `Start::displacements` of a resumed run, which then continues
//! bit for bit) → `c = Σ_lc w_lc Σ_e s_e u_eᵀk0u_e`, `dc_e = −p (E0 − Emin) xPhys_e^(p−1) g Σ_lc w_lc u_eᵀk0u_e (+ 2 Σ_lc w_lc
//! u_eᵀf_e)`, `dv_e = 1` → projection chain rule → filter → reduction to the design variables (extrusion) → OC or MMA →
//! `change = max|ξ_new − ξ|`. Stop when `change ≤ changeTol` at the final projection β (converged), after `maxIterations`, or
//! at the wall-clock `deadline_s` (checkpoint: every output is written so the run resumes bit for bit). Keep-in / keep-out
//! voxels are pinned to 1 / 0 in both x and xPhys; their sensitivities are dropped before the chain rule. Objectives:
//! `min_compliance` under `Σ xPhys ≤ volumeFraction · N_active` (keep-in counted), or `min_volume` under `c ≤ maxCompliance`
//! (MMA only).

use crate::design::DesignSpace;
use crate::filter::{Filter, FilterKind};
use crate::loads::{gravity_work, with_gravity};
use crate::mma::{Bounds, Mma};
use crate::oc::{self, Design, Limits};
use crate::projection::Projection;
use crate::solver::{choose_backend, Solver};
use llull_gpu::reduce::{max_abs, sum};
use llull_voxfe::ke::element_matrix;
use llull_voxfe::MIN_LEN;
use llull_voxfe::{Grid, Operator, SolverKind};
use rayon::prelude::*;
use std::time::Instant;

/// What a voxel is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Voxel {
    /// Outside the design domain: removed from the system.
    Inactive,
    Free,
    KeepIn,
    KeepOut,
}

/// One load case: nodal forces (DOF-length), its objective weight and, optionally, gravity as the force per fully solid voxel.
#[derive(Debug, Clone, PartialEq)]
pub struct LoadCase {
    pub name: String,
    pub weight: f64,
    pub forces: Vec<f64>,
    pub gravity: Option<[f64; 3]>,
}

/// What the loop minimises.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Objective {
    MinCompliance,
    /// Minimise the volume fraction with `c ≤ max_compliance` (consistent units, like the compliance).
    MinVolume {
        max_compliance: f64,
    },
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
    pub objective: Objective,
}

/// Where the linear solves run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Device {
    Cpu,
    Gpu,
    /// GPU for grids of at least `AUTO_GPU_MIN_DOFS` DOFs on a hardware adapter, else the CPU twin.
    Auto,
}

/// The design update.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Optimizer {
    Oc,
    Mma,
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
    pub optimizer: Optimizer,
    /// Heaviside projection on the density filter (none = plain filter).
    pub projection: Option<Projection>,
    /// Grid axis (0 = i, 1 = j, 2 = k) the design is uniform along.
    pub extrusion: Option<usize>,
    /// Wall-clock budget; the loop checkpoints when it is reached.
    pub deadline_s: Option<f64>,
    /// Iterations an earlier run already did (continues β continuation and the MMA step count).
    pub start_iteration: usize,
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
            optimizer: Optimizer::Oc,
            projection: None,
            extrusion: None,
            deadline_s: None,
            start_iteration: 0,
        }
    }
}

/// One history row (per iteration, before the design update: the compliance of the design that was analysed).
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

/// How a run ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Converged,
    MaxIterations,
    /// The wall-clock deadline was reached: outputs are a resumable checkpoint.
    Checkpoint,
}

/// A constraint of the final design.
#[derive(Debug, Clone, PartialEq)]
pub struct Constraint {
    pub name: &'static str,
    pub value: f64,
    pub limit: f64,
    pub satisfied: bool,
}

/// What a resumed run needs besides the design and displacements to continue bit for bit.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct OptimizerState {
    /// MMA asymptotes and history (`Mma::state`) with its step count.
    pub mma: Option<(Vec<f64>, usize)>,
    pub projection_level: u32,
    /// The compliance the MMA objective is normalised by (the first iteration's).
    pub objective_scale: Option<f64>,
}

/// Result of a run.
#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    pub x: Vec<f64>,
    pub x_phys: Vec<f64>,
    pub iterations: usize,
    pub status: Status,
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
    /// Per load case, the displacements of the last loop iteration's solve: the warm start a resumed run continues from.
    pub displacements: Vec<Vec<f64>>,
    pub objective_value: f64,
    pub constraints: Vec<Constraint>,
    /// The projection β of the final design.
    pub beta: Option<f64>,
    pub state: OptimizerState,
}

/// A failed run: stable code (`TOP_SOLVER_FAILED`, …) and message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TopError {
    pub code: &'static str,
    pub message: String,
}

/// Smallest grid (DOFs) that `device: auto` sends to a hardware GPU.
pub const AUTO_GPU_MIN_DOFS: usize = 500_000;

fn element_scales(x_phys: &[f64], voxels: &[Voxel], problem: &Problem, settings: &Settings, geometric: f64) -> Vec<f64> {
    let emin = settings.emin_ratio * problem.e0;
    x_phys
        .par_iter()
        .with_min_len(MIN_LEN)
        .zip(voxels)
        .map(|(&xp, &v)| if v == Voxel::Inactive { 0.0 } else { (emin + xp.powf(settings.penal) * (problem.e0 - emin)) * geometric })
        .collect()
}

struct Analysis {
    compliance: f64,
    per_case: Vec<f64>,
    /// Σ_lc w_lc u_eᵀk0u_e.
    energy: Vec<f64>,
    /// Σ_lc w_lc u_eᵀf_e of the gravity cases (empty without gravity).
    gravity: Vec<f64>,
}

/// Weighted compliance, per-case compliances and the element energies of the current scales (forces include gravity).
fn analyse(op: &Operator, solver: &mut Solver<'_>, problem: &Problem, x_phys: &[f64], active: &[bool]) -> Result<Analysis, TopError> {
    let n = problem.grid.elements();
    let has_gravity = problem.load_cases.iter().any(|case| case.gravity.is_some());
    let mut energy = vec![0.0; n];
    let mut gravity = if has_gravity { vec![0.0; n] } else { Vec::new() };
    let mut per_case = Vec::with_capacity(problem.load_cases.len());
    let mut weighted = 0.0;
    for (index, case) in problem.load_cases.iter().enumerate() {
        let u = match case.gravity {
            Some(g) => solver.solve(op, index, &with_gravity(&problem.grid, &case.forces, x_phys, active, g))?,
            None => solver.solve(op, index, &case.forces)?,
        };
        let ce = op.element_energies(&u);
        let scaled: Vec<f64> = ce.par_iter().with_min_len(MIN_LEN).zip(op.scale()).map(|(c, s)| c * s).collect();
        let c = sum(&scaled);
        per_case.push(c);
        weighted += case.weight * c;
        energy.par_iter_mut().with_min_len(MIN_LEN).zip(&ce).for_each(|(e, c)| *e += case.weight * c);
        if let Some(g) = case.gravity {
            let work = gravity_work(&problem.grid, &u, active, g);
            gravity.par_iter_mut().with_min_len(MIN_LEN).zip(&work).for_each(|(e, w)| *e += case.weight * w);
        }
    }
    Ok(Analysis { compliance: weighted, per_case, energy, gravity })
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
    if problem.load_cases.iter().any(|c| c.gravity.is_some_and(|g| g.iter().any(|v| !v.is_finite()))) {
        return Err("gravity needs finite components".to_string());
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
    if let Objective::MinVolume { max_compliance } = problem.objective {
        if !(max_compliance.is_finite() && max_compliance > 0.0) {
            return Err("objective minVolume needs maxCompliance > 0".to_string());
        }
        if settings.optimizer != Optimizer::Mma {
            return Err("objective minVolume needs optimizer mma (OC handles the volume constraint only)".to_string());
        }
    }
    if let Some(projection) = settings.projection {
        if settings.filter != FilterKind::Density {
            return Err("projection needs the density filter".to_string());
        }
        if !(projection.beta_start > 0.0 && projection.beta >= projection.beta_start && projection.beta.is_finite())
            || !(projection.eta > 0.0 && projection.eta < 1.0)
            || projection.beta_every == 0
        {
            return Err("projection needs 0 < betaStart ≤ beta, eta in (0, 1) and betaEvery ≥ 1".to_string());
        }
    }
    if settings.extrusion.is_some_and(|axis| axis >= g.dim) {
        return Err(format!("extrusion axis must be below the dimension {}", g.dim));
    }
    if settings.deadline_s.is_some_and(|d| !(d.is_finite() && d >= 0.0)) {
        return Err("deadlineS must be a finite number ≥ 0".to_string());
    }
    Ok(())
}

/// Where a run starts: design variables x (element-length; `None` = uniform volume fraction), the warm start of the first
/// solves (load cases × DOFs, an earlier run's [`Outcome::displacements`]; `None` = zero) and the optimiser state of the run
/// being continued (`None` = fresh asymptotes / continuation).
#[derive(Debug, Clone, Copy, Default)]
pub struct Start<'a> {
    pub design: Option<&'a [f64]>,
    pub displacements: Option<&'a [f64]>,
    pub state: Option<&'a OptimizerState>,
}

fn warm_starts(start: Start<'_>, dofs: usize, cases: usize) -> Result<Vec<Vec<f64>>, TopError> {
    match start.displacements {
        Some(values) if values.len() == dofs * cases => Ok(values.chunks_exact(dofs).map(<[f64]>::to_vec).collect()),
        Some(values) => Err(TopError {
            code: "NATIVE_JOB_INPUT",
            message: format!("start displacements: {} values, expected {cases} load cases x {dofs} DOFs", values.len()),
        }),
        None => Ok(vec![Vec::new(); cases]),
    }
}

/// Runs the SIMP loop from `start`. `progress` sees each history row as it is produced.
#[allow(clippy::too_many_lines)]
pub fn optimise(
    problem: &Problem,
    settings: &Settings,
    start: Start<'_>,
    progress: &mut dyn FnMut(&HistoryRow),
) -> Result<Outcome, TopError> {
    validate(problem, settings).map_err(|message| TopError { code: "NATIVE_JOB_INPUT", message })?;
    let g = problem.grid;
    let warm = warm_starts(start, g.dofs(), problem.load_cases.len())?;
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
    let pinned: Vec<f64> = design.iter().map(|d| if let Design::Pinned(p) = d { *p } else { 0.0 }).collect();
    let geometric = if g.dim == 3 { problem.voxel } else { problem.thickness };
    let filter = Filter::new(g, &active, settings.radius);
    let space = match settings.extrusion {
        Some(axis) => DesignSpace::extruded(g, &design, axis),
        None => DesignSpace::identity(&design),
    };
    let free = space.free_variables();
    let pin = |values: Vec<f64>| -> Vec<f64> {
        values.into_iter().zip(&design).map(|(v, d)| if let Design::Pinned(p) = d { *p } else { v }).collect()
    };
    let expand = |vars: &[f64]| -> Vec<f64> { pin(space.expand(vars, &pinned)) };
    // the filtered density x̃ of a design; with an extrusion axis the filtered field is averaged along it (the filter stencil is
    // truncated at the grid ends, so the plain convolution of a uniform column is not uniform)
    let filtered = |x: &[f64]| -> Vec<f64> { space.uniform(&filter.density(x)) };
    // design variables → xPhys (filter, projection at the given β, pins)
    let physical = |vars: &[f64], beta: Option<f64>| -> Vec<f64> {
        let x = expand(vars);
        match settings.filter {
            FilterKind::Sensitivity => x,
            FilterKind::Density => {
                let tilde = filtered(&x);
                match (settings.projection, beta) {
                    (Some(projection), Some(beta)) => pin(projection.apply(beta, &tilde)),
                    _ => pin(tilde),
                }
            }
        }
    };
    let initial = start.state.cloned().unwrap_or_default();
    let mut level = initial.projection_level;
    let beta_of = |level: u32| settings.projection.map(|p| p.beta_at(level));
    let mut beta = beta_of(level);
    let mut vars: Vec<f64> = match start.design {
        Some(values) => space.variables_of(&pin(values.iter().map(|v| v.clamp(0.0, 1.0)).collect())),
        None => space.variables_of(&pin(vec![problem.volume_fraction; n])),
    };
    let mut x = expand(&vars);
    // top88 starts from xPhys = x; a resumed or projected run recomputes xPhys from x exactly as the update step does
    let mut x_phys = if start.design.is_some() || settings.projection.is_some() { physical(&vars, beta) } else { x.clone() };
    let mut op = Operator::new(
        g,
        element_matrix(g.dim, problem.nu),
        element_scales(&x_phys, voxels, problem, settings, geometric),
        problem.fixed.clone(),
    );
    let (backend, engine) = choose_backend(settings.device, &op);
    let mut solver = Solver { settings, backend, multigrid: None, stale: true, warm, pcg_iterations: 0, warnings: Vec::new() };
    let emin = settings.emin_ratio * problem.e0;
    let target = problem.volume_fraction * active_count as f64;
    let limits = Limits { move_limit: settings.move_limit, tolerance: settings.oc_tolerance, target };
    let mut mma = match settings.optimizer {
        Optimizer::Oc => None,
        Optimizer::Mma => Some(match &initial.mma {
            Some((values, iteration)) => Mma::restore(free.len(), 1, values, *iteration).unwrap_or_else(|| Mma::new(free.len(), 1)),
            None => Mma::new(free.len(), 1),
        }),
    };
    let mut objective_scale = initial.objective_scale;
    let started = Instant::now();
    let mut history = Vec::new();
    let mut iterations = 0;
    let status = loop {
        if iterations >= settings.max_iterations {
            break Status::MaxIterations;
        }
        iterations += 1;
        if iterations > 1 {
            op.set_scale(element_scales(&x_phys, voxels, problem, settings, geometric));
        }
        solver.set_scale(&op);
        let analysis = analyse(&op, &mut solver, problem, &x_phys, &active)?;
        let compliance = analysis.compliance;
        let factor = -settings.penal * (problem.e0 - emin) * geometric;
        let has_gravity = !analysis.gravity.is_empty();
        let mut dc: Vec<f64> = (0..n)
            .into_par_iter()
            .with_min_len(MIN_LEN)
            .map(|e| {
                if design[e] != Design::Free {
                    return 0.0;
                }
                let stiffness = factor * x_phys[e].powf(settings.penal - 1.0) * analysis.energy[e];
                if has_gravity {
                    stiffness + 2.0 * analysis.gravity[e]
                } else {
                    stiffness
                }
            })
            .collect();
        let mut dv: Vec<f64> = design.iter().map(|d| if *d == Design::Free { 1.0 } else { 0.0 }).collect();
        match settings.filter {
            FilterKind::Sensitivity => dc = filter.sensitivity(&x, &dc),
            FilterKind::Density => {
                if let (Some(projection), Some(beta)) = (settings.projection, beta) {
                    let slope = projection.derivative(beta, &filtered(&x));
                    dc = dc.iter().zip(&slope).map(|(d, s)| d * s).collect();
                    dv = dv.iter().zip(&slope).map(|(d, s)| d * s).collect();
                }
                // chain rule of the column average (its own adjoint), then of the filter
                dc = filter.density_adjoint(&space.uniform(&dc));
                dv = filter.density_adjoint(&space.uniform(&dv));
            }
        }
        let dc_v = space.reduce_sum(&dc);
        let dv_v = space.reduce_sum(&dv);
        let phys = |v: &[f64]| physical(v, beta);
        let (next_vars, next_phys) = match &mut mma {
            None => {
                let step = oc::update(&vars, &dc_v, &dv_v, space.design(), limits, &phys);
                (step.x, step.x_phys)
            }
            Some(mma) => {
                let scale = *objective_scale.get_or_insert(compliance);
                let pick = |values: &[f64]| -> Vec<f64> { free.iter().map(|&v| values[v]).collect() };
                let (xf, dc_f, dv_f) = (pick(&vars), pick(&dc_v), pick(&dv_v));
                let (df0, f, df) = match problem.objective {
                    Objective::MinCompliance => (
                        dc_f.iter().map(|d| d / scale).collect::<Vec<f64>>(),
                        vec![sum(&x_phys) / target - 1.0],
                        vec![dv_f.iter().map(|d| d / target).collect::<Vec<f64>>()],
                    ),
                    Objective::MinVolume { max_compliance } => (
                        dv_f.iter().map(|d| d / active_count as f64).collect::<Vec<f64>>(),
                        vec![compliance / max_compliance - 1.0],
                        vec![dc_f.iter().map(|d| d / max_compliance).collect::<Vec<f64>>()],
                    ),
                };
                let step = mma.step(&xf, &df0, &f, &df, Bounds { xmin: 0.0, xmax: 1.0, move_limit: settings.move_limit });
                let mut next = vars.clone();
                for (k, &v) in free.iter().enumerate() {
                    next[v] = step[k];
                }
                let next_phys = phys(&next);
                (next, next_phys)
            }
        };
        let difference: Vec<f64> = next_vars.iter().zip(&vars).map(|(a, b)| a - b).collect();
        let change = max_abs(&difference);
        vars = next_vars;
        x = expand(&vars);
        x_phys = next_phys;
        let row = HistoryRow { it: iterations, compliance, volume: sum(&x_phys) / active_count as f64, change };
        progress(&row);
        history.push(row);
        // convergence and β continuation first, so a checkpoint carries the level and xPhys the uninterrupted run would have
        let at_final_beta = settings.projection.is_none_or(|p| p.is_final(level));
        let converged = change <= settings.change_tol;
        if converged && at_final_beta {
            break Status::Converged;
        }
        if converged
            || settings
                .projection
                .is_some_and(|p| !p.is_final(level) && (settings.start_iteration + iterations).is_multiple_of(p.beta_every))
        {
            // β continuation: the same design projects sharper from here on
            level += 1;
            beta = beta_of(level);
            x_phys = physical(&vars, beta);
        }
        // the deadline ends the loop only where the cap would not, so a checkpoint never coincides with maxIterations
        if iterations < settings.max_iterations && settings.deadline_s.is_some_and(|deadline| started.elapsed().as_secs_f64() >= deadline) {
            break Status::Checkpoint;
        }
    };
    // the warm start of the next iteration: what a resumed run needs to continue bit for bit
    let displacements = solver.warm.clone();
    op.set_scale(element_scales(&x_phys, voxels, problem, settings, geometric));
    solver.set_scale(&op);
    let final_analysis = analyse(&op, &mut solver, problem, &x_phys, &active)?;
    let compliance = final_analysis.compliance;
    let grey_terms: Vec<f64> = x_phys.iter().zip(&active).map(|(x, &a)| if a { 4.0 * x * (1.0 - x) } else { 0.0 }).collect();
    let volume = sum(&x_phys) / active_count as f64;
    let (objective_value, constraints) = match problem.objective {
        Objective::MinCompliance => (
            compliance,
            vec![Constraint {
                name: "volume",
                value: volume,
                limit: problem.volume_fraction,
                satisfied: volume <= problem.volume_fraction + 1e-9,
            }],
        ),
        Objective::MinVolume { max_compliance } => (
            volume,
            vec![Constraint {
                name: "compliance",
                value: compliance,
                limit: max_compliance,
                satisfied: compliance <= max_compliance * (1.0 + 1e-6),
            }],
        ),
    };
    Ok(Outcome {
        volume,
        grey: sum(&grey_terms) / active_count as f64,
        x,
        x_phys,
        iterations,
        status,
        history,
        compliance,
        per_load_case: final_analysis.per_case,
        engine,
        pcg_iterations: solver.pcg_iterations,
        warnings: solver.warnings,
        displacements,
        objective_value,
        constraints,
        beta,
        state: OptimizerState { mma: mma.as_ref().map(Mma::state), projection_level: level, objective_scale },
    })
}

//! The linear solves of the SIMP loop: the CPU twin (f64 PCG, multigrid or Jacobi preconditioner) or the GPU (f32 PCG inside
//! f64 refinement), with per-load-case warm starts.

use crate::simp::{Device, Engine, Settings, TopError};
use llull_voxfe::multigrid::{Multigrid, MultigridSettings};
use llull_voxfe::pcg::{pcg, Jacobi, SolveError};
use llull_voxfe::{Operator, SolverKind};

/// Prefix of a solver warning that is a `TOP_SOLVER_FALLBACK` (every other solver warning is a `TOP_GPU_FALLBACK`).
pub(crate) const SOLVER_FALLBACK_PREFIX: &str = "solver-fallback: ";

/// Prefix of a `TOP_DESIGN_BACKTRACK` warning (a minVolume step taken back after it disconnected the design).
pub(crate) const BACKTRACK_PREFIX: &str = "design-backtrack: ";

/// Linear solves on the CPU twin or the GPU.
pub(crate) enum Backend {
    Cpu,
    #[cfg(feature = "gpu")]
    Gpu(Box<llull_voxfe::gpu::GpuOperator>),
}

pub(crate) fn choose_backend(device: Device, op: &Operator) -> (Backend, Engine) {
    match device {
        Device::Cpu => (Backend::Cpu, Engine::Cpu),
        Device::Gpu | Device::Auto => gpu_backend(device, op),
    }
}

#[cfg(feature = "gpu")]
fn gpu_backend(device: Device, op: &Operator) -> (Backend, Engine) {
    if device == Device::Auto && op.grid().dofs() < crate::simp::AUTO_GPU_MIN_DOFS {
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

pub(crate) struct Solver<'a> {
    pub(crate) settings: &'a Settings,
    pub(crate) backend: Backend,
    /// The CPU twin's multigrid hierarchy, built on the first CPU solve and updated in place when the scales change.
    pub(crate) multigrid: Option<Multigrid<f32>>,
    /// The hierarchy does not match the operator's current scales yet.
    pub(crate) stale: bool,
    /// Per load case, the displacements of its last solve: the start of its next solve (warm start; empty = zero).
    pub(crate) warm: Vec<Vec<f64>>,
    pub(crate) pcg_iterations: usize,
    pub(crate) warnings: Vec<String>,
}

impl Solver<'_> {
    pub(crate) fn set_scale(&mut self, op: &Operator) {
        self.stale = true;
        #[cfg(feature = "gpu")]
        if let Backend::Gpu(gpu) = &self.backend {
            gpu.set_scale(op.scale());
        }
        let _ = op;
    }

    /// Builds the multigrid hierarchy, or updates it to the operator's current scales, once per scale change (multigrid
    /// solver only) and mirrors it to the GPU (whose PCG then uses the V-cycle instead of Jacobi).
    fn refresh_multigrid(&mut self, op: &Operator) {
        if self.settings.solver != SolverKind::Multigrid || !self.stale {
            return;
        }
        match &mut self.multigrid {
            Some(multigrid) => multigrid.update(op),
            None => self.multigrid = Some(Multigrid::new(op, MultigridSettings::default())),
        }
        self.stale = false;
        #[cfg(feature = "gpu")]
        if let (Backend::Gpu(gpu), Some(multigrid)) = (&mut self.backend, &self.multigrid) {
            gpu.set_multigrid(multigrid);
        }
    }

    /// PCG on the CPU twin from `u` (masked by the solver).
    fn cpu(&mut self, op: &Operator, b: &[f64], mut u: Vec<f64>) -> Result<Vec<f64>, TopError> {
        let (tolerance, cap) = (self.settings.pcg_tolerance, self.settings.pcg_max_iterations);
        let start = u.clone();
        let stats = match self.settings.solver {
            SolverKind::Jacobi => pcg(op, &Jacobi::new(op), b, &mut u, tolerance, cap),
            SolverKind::Multigrid => {
                self.refresh_multigrid(op);
                let multigrid = self.multigrid.as_ref().unwrap_or_else(|| unreachable!("built by refresh_multigrid"));
                match pcg(op, multigrid, b, &mut u, tolerance, cap) {
                    // a near-void design can break the multigrid preconditioner (not the system): solve this system with Jacobi
                    Err(error @ (SolveError::NonFinite { .. } | SolveError::Breakdown { .. } | SolveError::Diverged { .. })) => {
                        if self.warnings.len() < 20 {
                            self.warnings.push(format!(
                                "{SOLVER_FALLBACK_PREFIX}multigrid PCG failed ({error}); this solve used the Jacobi preconditioner"
                            ));
                        }
                        u = start;
                        pcg(op, &Jacobi::new(op), b, &mut u, tolerance, cap)
                    }
                    other => other,
                }
            }
        }
        .map_err(|error| TopError { code: "TOP_SOLVER_FAILED", message: error.to_string() })?;
        self.pcg_iterations += stats.iterations;
        Ok(u)
    }

    /// Solves load case `case` (`K u = b`) from its previous displacements and keeps the result for the next solve.
    pub(crate) fn solve(&mut self, op: &Operator, case: usize, b: &[f64]) -> Result<Vec<f64>, TopError> {
        let u = self.solve_from(op, b, self.start(case, b.len()))?;
        self.warm[case].clone_from(&u);
        Ok(u)
    }

    fn start(&self, case: usize, len: usize) -> Vec<f64> {
        match self.warm.get(case) {
            Some(u) if u.len() == len => u.clone(),
            _ => vec![0.0; len],
        }
    }

    /// Solves `K x = b` from zero (adjoint systems: no warm start, so a resumed run is unaffected).
    pub(crate) fn solve_cold(&mut self, op: &Operator, b: &[f64]) -> Result<Vec<f64>, TopError> {
        self.solve_from(op, b, vec![0.0; b.len()])
    }

    fn solve_from(&mut self, op: &Operator, b: &[f64], start: Vec<f64>) -> Result<Vec<f64>, TopError> {
        self.refresh_multigrid(op);
        match &self.backend {
            Backend::Cpu => self.cpu(op, b, start),
            #[cfg(feature = "gpu")]
            Backend::Gpu(gpu) => {
                let mut u = start.clone();
                match llull_voxfe::gpu::refine(gpu, op, b, &mut u, self.settings.pcg_tolerance, 1e-4, self.settings.pcg_max_iterations) {
                    Ok(stats) => {
                        self.pcg_iterations += stats.inner;
                        Ok(u)
                    }
                    Err(reason) => {
                        if self.warnings.len() < 20 {
                            self.warnings.push(format!("GPU solve failed ({reason}); solved by the CPU twin"));
                        }
                        self.cpu(op, b, start)
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use llull_voxfe::ke::element_matrix;
    use llull_voxfe::Grid;

    /// MBB 30 x 10 half beam on a thin broken-up design (stiffness contrast 1e9, as after a void collapse).
    fn near_void(pattern: impl Fn(usize) -> f64) -> (Operator, Vec<f64>) {
        let grid = Grid::new_2d(30, 10);
        let mut fixed = vec![false; grid.dofs()];
        for j in 0..=10 {
            fixed[2 * (j * 31)] = true;
        }
        fixed[2 * 30 + 1] = true;
        let scales: Vec<f64> = (0..grid.elements()).map(pattern).collect();
        let op = Operator::new(grid, element_matrix(2, 0.3), scales, fixed);
        let mut b = vec![0.0; grid.dofs()];
        b[2 * (10 * 31) + 1] = -1.0;
        (op, b)
    }

    fn solver(settings: &Settings) -> Solver<'_> {
        Solver {
            settings,
            backend: Backend::Cpu,
            multigrid: None,
            stale: true,
            warm: vec![Vec::new()],
            pcg_iterations: 0,
            warnings: Vec::new(),
        }
    }

    /// Pseudo-random thin design: `percent` % of the elements solid, the rest void (1e-9).
    fn thin(seed: u64, percent: u64) -> impl Fn(usize) -> f64 {
        move |e| {
            let h = (e as u64 + 1).wrapping_mul(0x9E37_79B9_7F4A_7C15 ^ seed.wrapping_mul(0x1234_5677)) >> 40;
            if h % 100 < percent {
                1.0
            } else {
                1e-9
            }
        }
    }

    fn solve_with(kind: SolverKind, design: impl Fn(usize) -> f64) -> (Vec<f64>, Vec<String>) {
        let (op, b) = near_void(design);
        let settings = Settings { solver: kind, ..Settings::default() };
        let mut solver = solver(&settings);
        solver.set_scale(&op);
        let u = solver.solve(&op, 0, &b).expect("solved");
        (u, solver.warnings)
    }

    /// A near-void design breaks the multigrid preconditioner (inf in the f32 V-cycle, or a residual growing 1e3-fold): that solve is
    /// redone with Jacobi, names the cause in a `solver-fallback` warning and returns the Jacobi answer.
    #[test]
    fn a_broken_multigrid_falls_back_to_jacobi_with_a_named_warning() {
        for (seed, percent, cause) in [(0, 4, "non-finite"), (3, 7, "diverged")] {
            let (multigrid, warnings) = solve_with(SolverKind::Multigrid, thin(seed, percent));
            let (jacobi, none) = solve_with(SolverKind::Jacobi, thin(seed, percent));
            assert!(none.is_empty(), "{none:?}");
            assert_eq!(warnings.len(), 1, "{warnings:?}");
            assert!(warnings[0].starts_with(SOLVER_FALLBACK_PREFIX) && warnings[0].contains(cause), "{warnings:?}");
            assert_eq!(multigrid, jacobi, "the fallback answer is the Jacobi solve");
        }
    }

    #[test]
    fn a_healthy_design_solves_by_multigrid_without_a_warning() {
        let (u, warnings) = solve_with(SolverKind::Multigrid, |_| 1.0);
        assert!(warnings.is_empty() && u.iter().all(|v| v.is_finite()), "{warnings:?}");
    }
}

//! The linear solves of the SIMP loop: the CPU twin (f64 PCG, multigrid or Jacobi preconditioner) or the GPU (f32 PCG inside
//! f64 refinement), with per-load-case warm starts.

use crate::simp::{Device, Engine, Settings, TopError};
use llull_voxfe::multigrid::{Multigrid, MultigridSettings};
use llull_voxfe::pcg::{pcg, Jacobi};
use llull_voxfe::{Operator, SolverKind};

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
        let stats = match self.settings.solver {
            SolverKind::Jacobi => pcg(op, &Jacobi::new(op), b, &mut u, tolerance, cap),
            SolverKind::Multigrid => {
                self.refresh_multigrid(op);
                let multigrid = self.multigrid.as_ref().unwrap_or_else(|| unreachable!("built by refresh_multigrid"));
                pcg(op, multigrid, b, &mut u, tolerance, cap)
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

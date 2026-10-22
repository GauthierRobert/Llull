//! The CPU twin: two population buffers (AoS, `cell * Q + q`), one fused pull-stream-collide pass per step over chunks of
//! cells in parallel. Each cell writes only its own slots, so the result is bit-identical for any thread count (RS1 §2 rule 3).
//! `CpuSolver<f64>` is the recorded / reference path; `CpuSolver<f32>` mirrors the GPU kernels.

use crate::domain::Domain;
use crate::kernel::{equilibrium_set, step_cell, Params};
use crate::lattice::Q;
use crate::real::Real;
use rayon::prelude::*;

/// Cells per parallel task.
const CELLS_PER_TASK: usize = 512;

/// The lattice state on the CPU.
pub struct CpuSolver<T: Real> {
    domain: Domain,
    params: Params<T>,
    f: Vec<T>,
    f_next: Vec<T>,
    rho: Vec<T>,
    vel: Vec<[T; 3]>,
    force: Vec<[T; 3]>,
    avg_rho: Vec<T>,
    avg_vel: Vec<[T; 3]>,
    samples: u32,
    steps: u64,
}

impl<T: Real> CpuSolver<T> {
    /// Every cell starts at the equilibrium of `initial(cell) -> (ρ, u)`.
    pub fn new(domain: Domain, params: Params<T>, initial: impl Fn(usize) -> (T, [T; 3])) -> CpuSolver<T> {
        let cells = domain.grid.cells();
        let mut f = vec![T::ZERO; cells * Q];
        let mut rho = vec![T::ZERO; cells];
        let mut vel = vec![[T::ZERO; 3]; cells];
        for cell in 0..cells {
            let (density, velocity) = initial(cell);
            f[cell * Q..cell * Q + Q].copy_from_slice(&equilibrium_set(density, velocity));
            if domain.is_fluid(cell) {
                rho[cell] = density;
                vel[cell] = velocity;
            }
        }
        CpuSolver {
            f_next: f.clone(),
            f,
            rho,
            vel,
            force: vec![[T::ZERO; 3]; cells],
            avg_rho: vec![T::ZERO; cells],
            avg_vel: vec![[T::ZERO; 3]; cells],
            samples: 0,
            steps: 0,
            domain,
            params,
        }
    }

    pub fn domain(&self) -> &Domain {
        &self.domain
    }

    pub fn params(&self) -> &Params<T> {
        &self.params
    }

    pub fn set_params(&mut self, params: Params<T>) {
        self.params = params;
    }

    pub fn steps_done(&self) -> u64 {
        self.steps
    }

    /// One lattice step.
    /// @failure a non-finite or non-positive density anywhere -> Err (the run is unstable: `CFD_SOLVER_FAILED`)
    pub fn step(&mut self) -> Result<(), String> {
        let domain = &self.domain;
        let params = &self.params;
        let f_in = &self.f;
        let bad: Vec<Option<usize>> = self
            .f_next
            .par_chunks_mut(CELLS_PER_TASK * Q)
            .zip(self.rho.par_chunks_mut(CELLS_PER_TASK))
            .zip(self.vel.par_chunks_mut(CELLS_PER_TASK))
            .zip(self.force.par_chunks_mut(CELLS_PER_TASK))
            .enumerate()
            .map(|(task, (((f_out, rho), vel), force))| {
                let first = task * CELLS_PER_TASK;
                let mut failed = None;
                for local in 0..rho.len() {
                    let cell = first + local;
                    if !domain.is_fluid(cell) {
                        continue;
                    }
                    let out = step_cell(domain, f_in, cell, params);
                    f_out[local * Q..local * Q + Q].copy_from_slice(&out.f);
                    rho[local] = out.rho;
                    vel[local] = out.u;
                    force[local] = out.force;
                    if !(out.rho.is_finite() && out.rho > T::ZERO) && failed.is_none() {
                        failed = Some(cell);
                    }
                }
                failed
            })
            .collect();
        std::mem::swap(&mut self.f, &mut self.f_next);
        self.steps += 1;
        match bad.into_iter().flatten().next() {
            Some(cell) => {
                let (i, j, k) = self.domain.grid.coords(cell);
                Err(format!("non-finite or non-positive density at cell ({i}, {j}, {k}) after {} steps", self.steps))
            }
            None => Ok(()),
        }
    }

    pub fn run(&mut self, steps: u64) -> Result<(), String> {
        for _ in 0..steps {
            self.step()?;
        }
        Ok(())
    }

    /// Density per cell after the last step (0 in non-fluid cells).
    pub fn rho(&self) -> &[T] {
        &self.rho
    }

    pub fn vel(&self) -> &[[T; 3]] {
        &self.vel
    }

    /// Momentum given to the bodies by each cell's wall links in the last step.
    pub fn force(&self) -> &[[T; 3]] {
        &self.force
    }

    /// Adds the current density and velocity to the time averages.
    pub fn accumulate(&mut self) {
        self.avg_rho.par_iter_mut().zip(self.rho.par_iter()).for_each(|(avg, value)| *avg += *value);
        self.avg_vel.par_iter_mut().zip(self.vel.par_iter()).for_each(|(avg, value)| {
            for (sum, component) in avg.iter_mut().zip(value) {
                *sum += *component;
            }
        });
        self.samples += 1;
    }

    pub fn reset_averages(&mut self) {
        self.avg_rho.iter_mut().for_each(|v| *v = T::ZERO);
        self.avg_vel.iter_mut().for_each(|v| *v = [T::ZERO; 3]);
        self.samples = 0;
    }

    /// Time-averaged density and velocity (the instantaneous fields when nothing was accumulated) and the sample count.
    pub fn averages(&self) -> (Vec<T>, Vec<[T; 3]>, u32) {
        if self.samples == 0 {
            return (self.rho.clone(), self.vel.clone(), 0);
        }
        let n = T::of(f64::from(self.samples));
        (self.avg_rho.iter().map(|v| *v / n).collect(), self.avg_vel.iter().map(|v| [v[0] / n, v[1] / n, v[2] / n]).collect(), self.samples)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Domain, SOLID};
    use llull_flow_core::grid::Grid;

    #[test]
    fn a_periodic_uniform_flow_is_conserved_and_thread_independent() {
        let grid = Grid::covering([0.0; 3], [6.0, 4.0, 4.0], 1.0);
        let params = Params { tau: 0.7f64, smagorinsky: 0.1, u_in: [0.0; 3], u_wall: [0.0; 3], body_force: [0.0; 3] };
        let run = |threads: usize| {
            rayon::ThreadPoolBuilder::new().num_threads(threads).build().unwrap().install(|| {
                let mut domain = Domain::new(grid.clone(), [true; 3]);
                let solid = grid.index(3, 2, 2);
                domain.flags[solid] = SOLID;
                domain.body[solid] = 0;
                domain.bodies = 1;
                let mut solver = CpuSolver::new(domain, params, |_| (1.0, [0.05, 0.0, 0.0]));
                solver.run(40).unwrap();
                solver.accumulate();
                (solver.rho().to_vec(), solver.force().to_vec(), solver.averages())
            })
        };
        let one = run(1);
        let mass: f64 = one.0.iter().sum();
        assert!((mass - (6.0 * 4.0 * 4.0 - 1.0)).abs() < 1e-9, "{mass}");
        assert!(one.1.iter().any(|f| f[0] != 0.0), "the obstacle feels a force");
        let other = run(3);
        assert_eq!(one.0, other.0);
        assert_eq!(one.1, other.1);
        assert_eq!(one.2, other.2);
    }

    #[test]
    fn the_f32_twin_tracks_the_f64_reference() {
        let grid = Grid::covering([0.0; 3], [8.0, 4.0, 4.0], 1.0);
        let mut domain = Domain::new(grid.clone(), [true; 3]);
        let solid = grid.index(4, 2, 2);
        domain.flags[solid] = SOLID;
        domain.body[solid] = 0;
        domain.bodies = 1;
        let params = Params { tau: 0.7f64, smagorinsky: 0.1, u_in: [0.0; 3], u_wall: [0.0; 3], body_force: [0.0; 3] };
        let mut double = CpuSolver::new(domain.clone(), params, |_| (1.0, [0.05, 0.0, 0.0]));
        let mut single = CpuSolver::new(domain, params.cast::<f32>(), |_| (1.0, [0.05, 0.0, 0.0]));
        double.run(30).unwrap();
        single.run(30).unwrap();
        let worst = double.rho().iter().zip(single.rho()).map(|(a, b)| (a - f64::from(*b)).abs()).fold(0.0, f64::max);
        assert!(worst < 1e-5, "{worst}");
    }
}

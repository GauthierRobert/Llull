//! The steady-state run (TECHNICAL_SPEC §5.3 "steady state") over a [`Backend`]: the drag is sampled every `sample_every`
//! steps; its mean over one flow-through time (window W) is compared with the previous window; time averaging starts when
//! the change falls below `start_averaging_tol` (named default 0.5 %); the run stops when it falls below `stop_tol` (0.1 %)
//! after at least two windows of averaging, or at `max_steps` (`converged: false`). Forces and moments are reduced per body
//! in a fixed order on the host, so a run is reproducible on one device.

use crate::cpu::CpuSolver;
use crate::domain::Domain;
use crate::real::Real;
use llull_flow_core::reduce::{sum3, sum_per_body, CHUNK};
use llull_flow_core::voxel::NO_BODY;
use rayon::prelude::*;

/// Time-averaged density and velocity per cell with the sample count.
pub type Averages = (Vec<f32>, Vec<[f32; 3]>, u32);

/// What the run needs from a lattice implementation (the CPU twin, or the GPU kernels).
pub trait Backend {
    /// Advances `steps` lattice steps.
    fn advance(&mut self, steps: u64) -> Result<(), String>;
    fn steps_done(&self) -> u64;
    /// Per-cell momentum given to the bodies in the last step.
    fn force(&mut self) -> Result<Vec<[f32; 3]>, String>;
    /// Adds the current density and velocity to the time averages.
    fn accumulate(&mut self) -> Result<(), String>;
    /// Time-averaged density and velocity (instantaneous when nothing was accumulated) and the sample count.
    fn averages(&mut self) -> Result<Averages, String>;
    fn info(&self) -> BackendInfo;
}

/// Provenance of a backend.
#[derive(Debug, Clone, PartialEq)]
pub struct BackendInfo {
    pub device: &'static str,
    pub adapter: Option<String>,
    pub deterministic: bool,
    /// `f64` for the CPU reference, `f32` for the GPU kernels (and the f32 twin).
    pub precision: &'static str,
}

impl<T: Real> Backend for CpuSolver<T> {
    fn advance(&mut self, steps: u64) -> Result<(), String> {
        self.run(steps)
    }
    fn steps_done(&self) -> u64 {
        CpuSolver::steps_done(self)
    }
    fn force(&mut self) -> Result<Vec<[f32; 3]>, String> {
        Ok(CpuSolver::force(self).iter().map(|f| [f[0].to_f32(), f[1].to_f32(), f[2].to_f32()]).collect())
    }
    fn accumulate(&mut self) -> Result<(), String> {
        CpuSolver::accumulate(self);
        Ok(())
    }
    fn averages(&mut self) -> Result<Averages, String> {
        let (rho, vel, samples) = CpuSolver::averages(self);
        Ok((rho.iter().map(|v| v.to_f32()).collect(), vel.iter().map(|u| [u[0].to_f32(), u[1].to_f32(), u[2].to_f32()]).collect(), samples))
    }
    fn info(&self) -> BackendInfo {
        BackendInfo { device: "cpu", adapter: None, deterministic: true, precision: T::NAME }
    }
}

/// Run control (lattice units).
#[derive(Debug, Clone, PartialEq)]
pub struct RunSettings {
    pub max_steps: u64,
    /// Steps of one flow-through: the averaging window.
    pub flow_through_steps: u64,
    /// Steps between two drag samples (≥ 1).
    pub sample_every: u64,
    pub start_averaging_tol: f64,
    pub stop_tol: f64,
    /// Unit vector the drag is measured along.
    pub drag_direction: [f64; 3],
    /// Point the moment is taken about, in lattice cell coordinates (cell `(i, j, k)` has its centre at `i + ½, …`).
    pub moment_point: [f64; 3],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Transient,
    Averaging,
}

/// One drag sample.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HistoryRow {
    pub step: u64,
    /// Total momentum exchange with the bodies in that step, lattice units.
    pub force: [f64; 3],
    pub drag: f64,
    /// Relative change of the window mean (NaN before two windows exist).
    pub change: f64,
    pub phase: Phase,
}

/// The run's result in lattice units.
#[derive(Debug, Clone, PartialEq)]
pub struct RunOutcome {
    pub steps: u64,
    pub converged: bool,
    pub phase: Phase,
    pub history: Vec<HistoryRow>,
    /// Time-averaged momentum exchange per body (over the averaging phase, else the last window).
    pub force_per_body: Vec<[f64; 3]>,
    /// Time-averaged moment about `moment_point` (all bodies).
    pub moment: [f64; 3],
    pub rho: Vec<f32>,
    pub vel: Vec<[f32; 3]>,
    pub samples: u32,
    pub averaged_steps: u64,
    pub info: BackendInfo,
}

/// Fixed-order moment `Σ (x_cell − p) × F_cell` over the cells with a linked body.
pub fn moment_about(domain: &Domain, force: &[[f32; 3]], link_body: &[u16], point: [f64; 3]) -> [f64; 3] {
    let grid = &domain.grid;
    let partials: Vec<[f64; 3]> = force
        .par_chunks(CHUNK)
        .zip(link_body.par_chunks(CHUNK))
        .enumerate()
        .map(|(chunk, (forces, owners))| {
            let mut sum = [0.0f64; 3];
            for (local, (f, owner)) in forces.iter().zip(owners).enumerate() {
                if *owner == NO_BODY {
                    continue;
                }
                let (i, j, k) = grid.coords(chunk * CHUNK + local);
                let r = [i as f64 + 0.5 - point[0], j as f64 + 0.5 - point[1], k as f64 + 0.5 - point[2]];
                let f = [f64::from(f[0]), f64::from(f[1]), f64::from(f[2])];
                sum[0] += r[1] * f[2] - r[2] * f[1];
                sum[1] += r[2] * f[0] - r[0] * f[2];
                sum[2] += r[0] * f[1] - r[1] * f[0];
            }
            sum
        })
        .collect();
    partials.iter().fold([0.0; 3], |acc, v| [acc[0] + v[0], acc[1] + v[1], acc[2] + v[2]])
}

fn mean(values: &[f64]) -> f64 {
    if values.is_empty() {
        0.0
    } else {
        values.iter().sum::<f64>() / values.len() as f64
    }
}

/// Relative change between the means of the last two windows of `n` samples (NaN with fewer than `2n` samples).
fn window_change(drags: &[f64], n: usize) -> f64 {
    if drags.len() < 2 * n {
        return f64::NAN;
    }
    let last = mean(&drags[drags.len() - n..]);
    let previous = mean(&drags[drags.len() - 2 * n..drags.len() - n]);
    (last - previous).abs() / last.abs().max(1e-300)
}

struct Accumulated {
    per_body: Vec<[f64; 3]>,
    moment: [f64; 3],
    samples: u64,
}

impl Accumulated {
    fn add(&mut self, per_body: &[[f64; 3]], moment: [f64; 3]) {
        for (sum, value) in self.per_body.iter_mut().zip(per_body) {
            for axis in 0..3 {
                sum[axis] += value[axis];
            }
        }
        for (sum, value) in self.moment.iter_mut().zip(moment) {
            *sum += value;
        }
        self.samples += 1;
    }

    fn mean(&self) -> (Vec<[f64; 3]>, [f64; 3]) {
        let n = self.samples.max(1) as f64;
        (
            self.per_body.iter().map(|v| [v[0] / n, v[1] / n, v[2] / n]).collect(),
            [self.moment[0] / n, self.moment[1] / n, self.moment[2] / n],
        )
    }
}

/// Runs `backend` to steady state; `progress(row, max_steps)` is called at every drag sample.
/// @failure an unstable lattice (non-finite density) -> Err with the backend's message
pub fn run(
    backend: &mut dyn Backend,
    domain: &Domain,
    settings: &RunSettings,
    progress: &mut dyn FnMut(&HistoryRow, u64),
) -> Result<RunOutcome, String> {
    let link_body = domain.link_body();
    let bodies = domain.bodies.max(1);
    let sample_every = settings.sample_every.max(1);
    let window = (settings.flow_through_steps.max(1)).div_ceil(sample_every).max(1) as usize;
    let mut drags: Vec<f64> = Vec::new();
    let mut history: Vec<HistoryRow> = Vec::new();
    let mut phase = Phase::Transient;
    let mut averaging_since: Option<u64> = None;
    let mut averaged = Accumulated { per_body: vec![[0.0; 3]; bodies], moment: [0.0; 3], samples: 0 };
    let mut last_window = Accumulated { per_body: vec![[0.0; 3]; bodies], moment: [0.0; 3], samples: 0 };
    let mut converged = false;
    let total = settings.max_steps;
    while backend.steps_done() < total {
        let remaining = total - backend.steps_done();
        backend.advance(sample_every.min(remaining))?;
        let force = backend.force()?;
        let per_body = sum_per_body(&force, &link_body, bodies);
        let moment = moment_about(domain, &force, &link_body, settings.moment_point);
        let total_force = sum3(&force);
        let drag = total_force[0] * settings.drag_direction[0]
            + total_force[1] * settings.drag_direction[1]
            + total_force[2] * settings.drag_direction[2];
        drags.push(drag);
        let change = window_change(&drags, window);
        if phase == Phase::Averaging {
            backend.accumulate()?;
            averaged.add(&per_body, moment);
        } else if change.is_finite() && change < settings.start_averaging_tol {
            phase = Phase::Averaging;
            averaging_since = Some(backend.steps_done());
            backend.accumulate()?;
            averaged.add(&per_body, moment);
        }
        // The last window's mean stands in for the average of a run that never settled.
        if drags.len().is_multiple_of(window) {
            last_window = Accumulated { per_body: vec![[0.0; 3]; bodies], moment: [0.0; 3], samples: 0 };
        }
        last_window.add(&per_body, moment);
        let row = HistoryRow { step: backend.steps_done(), force: total_force, drag, change, phase };
        history.push(row);
        progress(&row, total);
        if let Some(since) = averaging_since {
            let two_windows = 2 * window as u64 * sample_every;
            if backend.steps_done() - since >= two_windows && change.is_finite() && change < settings.stop_tol {
                converged = true;
                break;
            }
        }
    }
    let (rho, vel, samples) = backend.averages()?;
    let (force_per_body, moment) = if averaged.samples > 0 { averaged.mean() } else { last_window.mean() };
    Ok(RunOutcome {
        steps: backend.steps_done(),
        converged,
        phase,
        history,
        force_per_body,
        moment,
        rho,
        vel,
        samples,
        averaged_steps: averaging_since.map_or(0, |since| backend.steps_done() - since),
        info: backend.info(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_change_compares_the_last_two_windows() {
        assert!(window_change(&[1.0, 2.0, 3.0], 2).is_nan());
        let change = window_change(&[1.0, 1.0, 2.0, 2.0], 2);
        assert!((change - 0.5).abs() < 1e-12);
        assert_eq!(window_change(&[0.0, 0.0, 0.0, 0.0], 2), 0.0);
    }
}

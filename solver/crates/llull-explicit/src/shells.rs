//! The shells of a model in the time loop: their nodal masses and rotary inertias, angular velocities, and one step of every shell
//! (parallel per shell, assembled in shell order so the result is deterministic). Formulation: `shell.rs`.

use crate::model::Model;
use crate::shell::{masses, step, ShellState};
use rayon::prelude::*;

pub struct Shells {
    corners: Vec<[usize; 4]>,
    material: Vec<usize>,
    thickness: Vec<f64>,
    states: Vec<ShellState>,
    /// Rotary inertia per node (0 for nodes without a shell).
    pub inertia: Vec<f64>,
    /// Angular velocity at n−½, 3 per node.
    pub omega: Vec<f64>,
    /// Internal moments, 3 per node.
    pub moments: Vec<f64>,
}

/// One cycle of the shells: internal forces to add (3 per node), the work and the smallest stable step.
pub struct ShellCycle {
    pub forces: Vec<f64>,
    pub internal_work: f64,
    pub hourglass_work: f64,
    pub dt: f64,
}

fn corners_of(corners: &[usize; 4], x: &[f64]) -> [[f64; 3]; 4] {
    std::array::from_fn(|k| [x[3 * corners[k]], x[3 * corners[k] + 1], x[3 * corners[k] + 2]])
}

impl Shells {
    /// The shells of `model` (None without any); adds their translational masses to `masses` and returns their total mass too.
    pub fn new(model: &Model, x: &[f64], masses_by_node: &mut [f64]) -> Option<(Shells, f64)> {
        if model.shell4.is_empty() {
            return None;
        }
        let solids = model.hex_count() + model.tet_count();
        let nodes = model.node_count();
        let mut shells = Shells {
            corners: model.shell4.chunks_exact(4).map(|c| [c[0] as usize, c[1] as usize, c[2] as usize, c[3] as usize]).collect(),
            material: (0..model.shell4.len() / 4).map(|s| model.element_material[solids + s] as usize).collect(),
            thickness: model.shell_thickness.clone(),
            states: (0..model.shell4.len() / 4)
                .map(|s| ShellState::new(model.shell_points, model.initial_temperature_of(model.element_material[solids + s] as usize)))
                .collect(),
            inertia: vec![0.0; nodes],
            omega: vec![0.0; 3 * nodes],
            moments: vec![0.0; 3 * nodes],
        };
        let mut total = 0.0;
        for s in 0..shells.corners.len() {
            let density = model.materials[shells.material[s]].density;
            let (mass, inertia) = masses(&corners_of(&shells.corners[s], x), shells.thickness[s], density);
            for &node in &shells.corners[s] {
                masses_by_node[node] += mass;
                shells.inertia[node] += inertia;
            }
            total += 4.0 * mass;
        }
        Some((shells, total))
    }

    /// Smallest stable step of the shells at `x` (no deformation).
    pub fn initial_step(&self, model: &Model, x: &[f64]) -> f64 {
        let zero = [[0.0; 3]; 4];
        (0..self.corners.len())
            .map(|s| {
                let c = corners_of(&self.corners[s], x);
                step(&model.materials[self.material[s]], self.thickness[s], &self.states[s], &c, &c, &zero, &zero, 1e-30).dt
            })
            .fold(f64::INFINITY, f64::min)
    }

    /// Updates the angular velocities to n+½ from the moments of the last cycle (central difference, lumped scalar inertia).
    pub fn kick(&mut self, dt_prev: f64, dt: f64, fixed_rotation: &[bool]) {
        for (k, omega) in self.omega.iter_mut().enumerate() {
            let inertia = self.inertia[k / 3];
            if inertia > 0.0 {
                *omega -= 0.5 * (dt_prev + dt) * self.moments[k] / inertia;
            }
            if fixed_rotation.get(k).copied().unwrap_or(false) {
                *omega = 0.0;
            }
        }
    }

    /// Rotational kinetic energy at the integer step between `previous` and the current angular velocities.
    pub fn kinetic(&self, previous: &[f64]) -> f64 {
        (0..self.omega.len()).map(|k| 0.5 * self.inertia[k / 3] * (0.5 * (previous[k] + self.omega[k])).powi(2)).sum()
    }

    /// One step of every shell from `x0` to `x1` with translational velocities `v` (n+½); stores the new moments.
    pub fn cycle(&mut self, model: &Model, x0: &[f64], x1: &[f64], v: &[f64], dt: f64) -> ShellCycle {
        let omega = &self.omega;
        let steps: Vec<_> = (0..self.corners.len())
            .into_par_iter()
            .map(|s| {
                let corners = &self.corners[s];
                let at = |values: &[f64]| corners_of(corners, values);
                step(&model.materials[self.material[s]], self.thickness[s], &self.states[s], &at(x0), &at(x1), &at(v), &at(omega), dt)
            })
            .collect();
        let mut forces = vec![0.0; x0.len()];
        self.moments.iter_mut().for_each(|value| *value = 0.0);
        let (mut internal_work, mut hourglass_work, mut smallest) = (0.0, 0.0, f64::INFINITY);
        for (s, result) in steps.into_iter().enumerate() {
            for (k, &node) in self.corners[s].iter().enumerate() {
                for i in 0..3 {
                    forces[3 * node + i] += result.forces[k][i];
                    self.moments[3 * node + i] += result.moments[k][i];
                }
            }
            internal_work += result.internal_work;
            hourglass_work += result.hourglass_work;
            smallest = smallest.min(result.dt);
            self.states[s] = result.state;
        }
        ShellCycle { forces, internal_work, hourglass_work, dt: smallest }
    }

    /// Per-shell fields `[von Mises, plastic strain, failed, temperature, centroid x, y, z]` (largest over the thickness points; failed
    /// when every point failed).
    pub fn fields(&self, x: &[f64]) -> Vec<f64> {
        let mut fields = Vec::with_capacity(crate::solver::FIELD_STRIDE * self.corners.len());
        for (s, corners) in self.corners.iter().enumerate() {
            let c = corners_of(corners, x);
            let centre: [f64; 3] = std::array::from_fn(|i| (c[0][i] + c[1][i] + c[2][i] + c[3][i]) / 4.0);
            let vm = self.states[s].points.iter().map(|p| crate::material::von_mises(&p.stress)).fold(0.0, f64::max);
            let eps = self.states[s].points.iter().map(|p| p.plastic_strain).fold(0.0, f64::max);
            let temperature = self.states[s].points.iter().map(|p| p.temperature).fold(f64::NEG_INFINITY, f64::max);
            let failed = if self.states[s].points.iter().all(|p| p.failed) { 1.0 } else { 0.0 };
            fields.extend_from_slice(&[vm, eps, failed, temperature, centre[0], centre[1], centre[2]]);
        }
        fields
    }
}

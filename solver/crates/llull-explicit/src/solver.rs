//! Central-difference explicit integration with lumped mass (Rust CPU path, deterministic).
//!
//! Sources (PHY-19 TECHNICAL_SPEC §13):
//! - Update: Sierra/SolidMechanics 4.50 Theory Manual (SAND2018-10680) Eqs. 12.8–12.11: `a^n = M⁻¹(F_ext − F_int)`,
//!   `v^{n+½} = v^{n−½} + ½(Δt^{n−½} + Δt^{n+½}) a^n`, `d^{n+1} = d^n + Δt^{n+½} v^{n+½}` (same scheme as LS-DYNA R14 Theory Manual §27.2).
//!   Start-up with `Δt^{−½} = 0`, i.e. `v^{½} = v^0 + ½Δt a^0`.
//! - Stable step: LS-DYNA R14 Theory Manual §25.1 Eqs. 25.1–25.3: `Δt = α min_e L_e / (Q + √(Q² + c²))`, `Q = C_lin c + C_quad L_e |ε̇_kk|`
//!   for `ε̇_kk < 0` (else 0), `c` the dilatational speed (Eq. 25.8).
//! - Bulk viscosity: LS-DYNA R14 Theory Manual §24.2 Eq. 24.15: `q = ρ l (C_quad l ε̇_kk² − C_lin c ε̇_kk)` for `ε̇_kk < 0`, `l = V^{1/3}`,
//!   added to the pressure in the momentum and energy equations.
//! - Rigid walls: LS-DYNA R14 Theory Manual §29.15 Eq. 29.102 (stonewall): a node whose next position would cross the plane while moving
//!   into it loses its normal velocity; the kinetic energy removed is the wall ("stonewall") energy. The wall force is the removed normal
//!   momentum per step (derived from momentum balance, not quoted).
//! - Energies: internal by the midpoint rule on the stress power (incl. bulk viscosity), hourglass as the dissipated power, kinetic at
//!   integer steps with `v^n = ½(v^{n−½} + v^{n+½})`, external work of gravity as `m g·Δx`.
//!
//! Determinism: element work runs in parallel (rayon) but every reduction and every nodal assembly runs sequentially in element order, so
//! the outputs are bit-identical across runs and thread counts.

use crate::hex8;
use crate::material::{split, update, von_mises, PointState, Sym};
use crate::model::{Material, Model};
use crate::stability::omega_squared;
use crate::tet4;
use rayon::prelude::*;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Progress {
    pub cycle: u64,
    pub time: f64,
    pub dt: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EnergyRow {
    pub time: f64,
    pub kinetic: f64,
    pub internal: f64,
    pub hourglass: f64,
    pub wall: f64,
    pub external_work: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WallHistory {
    pub name: String,
    pub times: Vec<f64>,
    /// Normal force on the wall averaged over each history interval (impulse / interval).
    pub forces: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    pub normal: bool,
    pub message: String,
    pub cycles: u64,
    pub final_time: f64,
    pub min_time_step: f64,
    pub initial_mass: f64,
    pub added_mass: f64,
    pub energy: Vec<EnergyRow>,
    pub walls: Vec<WallHistory>,
    /// Per element `[von Mises, plastic strain, failed, centroid x, y, z]`.
    pub fields: Vec<f64>,
    /// Final nodal coordinates (3 per node).
    pub coordinates: Vec<f64>,
    /// Final nodal velocities (3 per node, at the last half step).
    pub velocities: Vec<f64>,
}

/// One element's constant data.
#[derive(Debug, Clone)]
pub(crate) struct Element {
    pub(crate) nodes: Vec<usize>,
    pub(crate) material: usize,
    /// Mass after mass scaling (density = mass / current volume).
    pub(crate) mass: f64,
    /// The element's lumped (row-sum) contribution to each of its nodes, after mass scaling.
    pub(crate) node_masses: Vec<f64>,
}

/// What one element contributes in a step.
struct ElementStep {
    state: PointState,
    forces: Vec<[f64; 3]>,
    internal_work: f64,
    hourglass_work: f64,
    dt: f64,
}

fn node_coordinates<const N: usize>(nodes: &[usize], x: &[f64]) -> [[f64; 3]; N] {
    std::array::from_fn(|k| [x[3 * nodes[k]], x[3 * nodes[k] + 1], x[3 * nodes[k] + 2]])
}

/// Gradients (unnormalised) and volume of an element at coordinates `x`.
pub(crate) fn kinematics(nodes: &[usize], x: &[f64]) -> (Vec<[f64; 3]>, f64) {
    if nodes.len() == 8 {
        let (b, volume) = hex8::gradients(&node_coordinates(nodes, x));
        (b.to_vec(), volume)
    } else {
        let (b, volume) = tet4::gradients(&node_coordinates(nodes, x));
        (b.to_vec(), volume)
    }
}

/// Undamped stable step 2/ω_max of an element (stability.rs).
pub(crate) fn eigen_step(b: &[[f64; 3]], volume: f64, node_masses: &[f64], material: &Material) -> f64 {
    2.0 / omega_squared(b, volume, node_masses, material).sqrt()
}

fn velocity_gradient(nodes: &[usize], b: &[[f64; 3]], volume: f64, v: &[f64]) -> [[f64; 3]; 3] {
    let mut l = [[0.0; 3]; 3];
    for (k, &node) in nodes.iter().enumerate() {
        for (i, row) in l.iter_mut().enumerate() {
            for (j, entry) in row.iter_mut().enumerate() {
                *entry += v[3 * node + i] * b[k][j] / volume;
            }
        }
    }
    l
}

/// LS-DYNA Eq. 25.2 with the effective length `h = 2c/ω = c · eigen_step` (SIERRA Eq. 12.13).
fn stable_step(eigen_step: f64, speed: f64, trace: f64, linear: f64, quadratic: f64) -> f64 {
    let length = speed * eigen_step;
    let q = if trace < 0.0 { linear * speed + quadratic * length * trace.abs() } else { 0.0 };
    length / (q + (q * q + speed * speed).sqrt())
}

struct Settings {
    hourglass: f64,
    linear: f64,
    quadratic: f64,
}

/// The configuration of one step: positions at n and n+1, velocities at n+1/2, the step length.
struct Motion<'a> {
    x0: &'a [f64],
    x1: &'a [f64],
    v: &'a [f64],
    dt: f64,
}

/// Advances one element from `x0` to `x1` with velocities `v` over `dt`.
fn step_element(
    model: &Model,
    element: &Element,
    state: &PointState,
    motion: &Motion<'_>,
    settings: &Settings,
) -> Result<ElementStep, String> {
    let Motion { x0, x1, v, dt } = *motion;
    if state.failed {
        // Eroded (Johnson–Cook damage reached 1): the element is gone; its nodes keep their mass and move freely.
        return Ok(ElementStep {
            state: *state,
            forces: vec![[0.0; 3]; element.nodes.len()],
            internal_work: 0.0,
            hourglass_work: 0.0,
            dt: f64::INFINITY,
        });
    }
    let material = &model.materials[element.material];
    let mid: Vec<f64> = x0.iter().zip(x1).map(|(a, b)| 0.5 * (a + b)).collect();
    let (b_mid, volume_mid) = kinematics(&element.nodes, &mid);
    if !(volume_mid > 0.0) {
        return Err("an element inverted (non-positive volume)".to_string());
    }
    let l = velocity_gradient(&element.nodes, &b_mid, volume_mid, v);
    let (d, w) = split(&l);
    let next = update(material, state, &d, &w, dt);
    let (b, volume) = kinematics(&element.nodes, x1);
    if !(volume > 0.0) {
        return Err("an element inverted (non-positive volume)".to_string());
    }
    let density = element.mass / volume;
    let speed = material.dilatational_speed(density);
    let trace = d[0] + d[1] + d[2];
    let bulk = if trace < 0.0 {
        let l_bulk = volume.cbrt();
        density * l_bulk * (settings.quadratic * l_bulk * trace * trace - settings.linear * speed * trace)
    } else {
        0.0
    };
    let mut force_stress: Sym = next.stress;
    for value in force_stress.iter_mut().take(3) {
        *value -= bulk;
    }
    let s = [
        [force_stress[0], force_stress[3], force_stress[5]],
        [force_stress[3], force_stress[1], force_stress[4]],
        [force_stress[5], force_stress[4], force_stress[2]],
    ];
    let mut forces: Vec<[f64; 3]> =
        b.iter().map(|bk| std::array::from_fn(|i| -(s[i][0] * bk[0] + s[i][1] * bk[1] + s[i][2] * bk[2]))).collect();
    let mut hourglass_work = 0.0;
    if element.nodes.len() == 8 && settings.hourglass > 0.0 {
        let coords: [[f64; 3]; 8] = node_coordinates(&element.nodes, x1);
        let b8: [[f64; 3]; 8] = std::array::from_fn(|k| b[k]);
        let gamma = hex8::hourglass_vectors(&coords, &b8, volume);
        let velocities: [[f64; 3]; 8] =
            std::array::from_fn(|k| [v[3 * element.nodes[k]], v[3 * element.nodes[k] + 1], v[3 * element.nodes[k] + 2]]);
        let a_h = settings.hourglass * density * volume.powf(2.0 / 3.0) * speed / 4.0;
        let (hg, power) = hex8::hourglass_forces(&gamma, &velocities, a_h);
        for (force, extra) in forces.iter_mut().zip(hg.iter()) {
            for i in 0..3 {
                force[i] += extra[i];
            }
        }
        hourglass_work = power * dt;
    }
    let mean: Sym = std::array::from_fn(|k| 0.5 * (state.stress[k] + next.stress[k]));
    let power = mean[0] * d[0] + mean[1] * d[1] + mean[2] * d[2] + 2.0 * (mean[3] * d[3] + mean[4] * d[4] + mean[5] * d[5]) - bulk * trace;
    Ok(ElementStep {
        state: next,
        forces,
        internal_work: power * volume_mid * dt,
        hourglass_work,
        dt: stable_step(eigen_step(&b, volume, &element.node_masses, material), speed, trace, settings.linear, settings.quadratic),
    })
}

pub(crate) fn elements_of(model: &Model, coordinates: &[f64]) -> Result<(Vec<Element>, f64, f64), String> {
    let mut elements = Vec::with_capacity(model.element_count());
    let mut initial_mass = 0.0;
    let mut added_mass = 0.0;
    let scale = model.controls.time_step_scale;
    let all = model.hex8.chunks_exact(8).chain(model.tet4.chunks_exact(4));
    for (index, nodes) in all.enumerate() {
        let nodes: Vec<usize> = nodes.iter().map(|&node| node as usize).collect();
        let material_index = model.element_material[index] as usize;
        let material = &model.materials[material_index];
        let (b, volume) = kinematics(&nodes, coordinates);
        if !(volume > 0.0) {
            return Err(format!("element {index} has a non-positive volume (inverted or degenerate)"));
        }
        let mut node_masses = element_masses(&nodes, coordinates, material.density, volume);
        initial_mass += material.density * volume;
        let mut mass = material.density * volume;
        if let Some(scaling) = model.controls.mass_scaling {
            // The eigen step grows with the square root of the density: scale it so that scale x step reaches the target.
            let step = scale * eigen_step(&b, volume, &node_masses, material);
            if step < scaling.target_time_step {
                let factor = (scaling.target_time_step / step).powi(2);
                added_mass += (factor - 1.0) * mass;
                mass *= factor;
                node_masses.iter_mut().for_each(|value| *value *= factor);
            }
        }
        elements.push(Element { nodes, material: material_index, mass, node_masses });
    }
    Ok((elements, initial_mass, added_mass))
}

/// Lumped (row-sum) nodal masses of one element: Gauss row sums for hex8, a quarter each for tet4 (exact row sums).
fn element_masses(nodes: &[usize], coordinates: &[f64], density: f64, volume: f64) -> Vec<f64> {
    if nodes.len() == 8 {
        hex8::lumped_masses(&node_coordinates(nodes, coordinates), density).to_vec()
    } else {
        vec![density * volume / 4.0; 4]
    }
}

/// Nodal lumped masses assembled in element order.
pub(crate) fn nodal_masses(model: &Model, elements: &[Element]) -> Vec<f64> {
    let mut masses = vec![0.0; model.node_count()];
    for element in elements {
        for (&node, &mass) in element.nodes.iter().zip(&element.node_masses) {
            masses[node] += mass;
        }
    }
    masses
}

pub(crate) fn centroid(nodes: &[usize], x: &[f64]) -> [f64; 3] {
    let count = nodes.len() as f64;
    std::array::from_fn(|i| nodes.iter().map(|&node| x[3 * node + i]).sum::<f64>() / count)
}

/// Integrates `model` to its end time. `progress` is called once per cycle.
pub fn run(model: &Model, progress: &mut impl FnMut(Progress)) -> Result<Outcome, String> {
    let controls = &model.controls;
    let settings = Settings { hourglass: controls.hourglass_coefficient, linear: controls.bulk_linear, quadratic: controls.bulk_quadratic };
    let mut x = model.coordinates.clone();
    let (elements, initial_mass, added_mass) = elements_of(model, &x)?;
    let masses = nodal_masses(model, &elements);
    if masses.iter().any(|&mass| !(mass > 0.0)) {
        return Err("a node belongs to no element (zero mass)".to_string());
    }
    let nodes = model.node_count();
    let mut states = vec![PointState::default(); elements.len()];
    let mut v_half = model.initial_velocity.clone();
    let mut f_int = vec![0.0; 3 * nodes];
    let external: Vec<f64> = (0..3 * nodes).map(|k| masses[k / 3] * model.gravity[k % 3]).collect();
    let mut internal = 0.0;
    let mut hourglass = 0.0;
    let mut wall_energy = 0.0;
    let mut external_work = 0.0;
    let initial_kinetic: f64 = (0..3 * nodes).map(|k| 0.5 * masses[k / 3] * v_half[k] * v_half[k]).sum();
    let mut energy = vec![EnergyRow { time: 0.0, kinetic: initial_kinetic, internal: 0.0, hourglass: 0.0, wall: 0.0, external_work: 0.0 }];
    let mut walls: Vec<WallHistory> =
        model.walls.iter().map(|wall| WallHistory { name: wall.name.clone(), times: vec![], forces: vec![] }).collect();
    let mut wall_impulse = vec![0.0; model.walls.len()];
    let mut last_sample = 0.0;
    let mut next_sample = controls.history_interval;
    let mut element_dt = f64::INFINITY;
    for element in &elements {
        let (b, volume) = kinematics(&element.nodes, &x);
        element_dt = element_dt.min(eigen_step(&b, volume, &element.node_masses, &model.materials[element.material]));
    }
    let mut dt_prev = 0.0;
    let mut time = 0.0;
    let mut cycles = 0u64;
    let mut min_dt = f64::INFINITY;
    let mut message = String::new();
    let mut normal = true;
    let end = controls.end_time;
    while time < end * (1.0 - 1e-12) {
        let mut dt = controls.time_step_scale * element_dt;
        if let Some(limit) = controls.min_time_step {
            if dt < limit {
                normal = false;
                message = format!("the stable time step {dt:e} s fell below minTimeStep {limit:e} s at t = {time:e} s");
                break;
            }
        }
        if cycles >= controls.max_cycles {
            normal = false;
            message = format!("maxCycles {} reached at t = {time:e} s", controls.max_cycles);
            break;
        }
        min_dt = min_dt.min(dt);
        dt = dt.min(end - time);
        let mut v_new: Vec<f64> =
            (0..3 * nodes).map(|k| v_half[k] + 0.5 * (dt_prev + dt) * (external[k] - f_int[k]) / masses[k / 3]).collect();
        for (index, wall) in model.walls.iter().enumerate() {
            let n = wall.normal;
            for node in 0..nodes {
                let at = 3 * node;
                let normal_speed = v_new[at] * n[0] + v_new[at + 1] * n[1] + v_new[at + 2] * n[2];
                if normal_speed >= 0.0 {
                    continue;
                }
                let gap = (0..3).map(|i| (x[at + i] + dt * v_new[at + i] - wall.point[i]) * n[i]).sum::<f64>();
                if gap < 0.0 {
                    let previous_speed = v_half[at] * n[0] + v_half[at + 1] * n[1] + v_half[at + 2] * n[2];
                    for i in 0..3 {
                        v_new[at + i] -= normal_speed * n[i];
                    }
                    wall_impulse[index] += -masses[node] * normal_speed;
                    // Work of the wall reaction R = m (v_pred·n)/Δt over the central-difference step, R·½(Δx^{n-½} + Δx^{n+½}),
                    // with the corrected normal velocity zero: a node resting on the wall dissipates nothing.
                    wall_energy += 0.5 * masses[node] * normal_speed * previous_speed;
                }
            }
        }
        if cycles > 0 && time >= next_sample * (1.0 - 1e-12) {
            let kinetic: f64 = (0..3 * nodes).map(|k| 0.5 * masses[k / 3] * (0.5 * (v_half[k] + v_new[k])).powi(2)).sum();
            energy.push(EnergyRow { time, kinetic, internal, hourglass, wall: wall_energy, external_work });
            sample_walls(&mut walls, &mut wall_impulse, time, last_sample);
            last_sample = time;
            next_sample = (((time / controls.history_interval) + 1e-9).floor() + 1.0) * controls.history_interval;
        }
        let x_new: Vec<f64> = (0..3 * nodes).map(|k| x[k] + dt * v_new[k]).collect();
        external_work += (0..3 * nodes).map(|k| external[k] * (x_new[k] - x[k])).sum::<f64>();
        let motion = Motion { x0: &x, x1: &x_new, v: &v_new, dt };
        let steps: Vec<Result<ElementStep, String>> = elements
            .par_iter()
            .zip(states.par_iter())
            .map(|(element, state)| step_element(model, element, state, &motion, &settings))
            .collect();
        f_int.iter_mut().for_each(|value| *value = 0.0);
        element_dt = f64::INFINITY;
        for (index, step) in steps.into_iter().enumerate() {
            let step = step.map_err(|error| format!("{error} at t = {time:e} s (element {index})"))?;
            for (k, &node) in elements[index].nodes.iter().enumerate() {
                for i in 0..3 {
                    f_int[3 * node + i] -= step.forces[k][i];
                }
            }
            internal += step.internal_work;
            hourglass += step.hourglass_work;
            element_dt = element_dt.min(step.dt);
            states[index] = step.state;
        }
        time += dt;
        dt_prev = dt;
        x = x_new;
        v_half = v_new;
        cycles += 1;
        if !(internal.is_finite() && element_dt.is_finite()) {
            normal = false;
            message = format!("the solution became non-finite at t = {time:e} s");
            break;
        }
        progress(Progress { cycle: cycles, time, dt });
    }
    // Final kinetic energy at the last integer step: half kick with the last forces.
    let v_end: Vec<f64> = (0..3 * nodes).map(|k| v_half[k] + 0.5 * dt_prev * (external[k] - f_int[k]) / masses[k / 3]).collect();
    let kinetic: f64 = (0..3 * nodes).map(|k| 0.5 * masses[k / 3] * v_end[k] * v_end[k]).sum();
    energy.push(EnergyRow { time, kinetic, internal, hourglass, wall: wall_energy, external_work });
    if time > last_sample {
        sample_walls(&mut walls, &mut wall_impulse, time, last_sample);
    }
    let mut fields = Vec::with_capacity(6 * elements.len());
    for (element, state) in elements.iter().zip(&states) {
        let c = centroid(&element.nodes, &x);
        let failed = if state.failed { 1.0 } else { 0.0 };
        fields.extend_from_slice(&[von_mises(&state.stress), state.plastic_strain, failed, c[0], c[1], c[2]]);
    }
    Ok(Outcome {
        normal,
        message,
        cycles,
        final_time: time,
        min_time_step: if min_dt.is_finite() { min_dt } else { 0.0 },
        initial_mass,
        added_mass,
        energy,
        walls,
        fields,
        coordinates: x,
        velocities: v_half,
    })
}

pub(crate) fn sample_walls(walls: &mut [WallHistory], impulse: &mut [f64], time: f64, last: f64) {
    let span = time - last;
    for (wall, accumulated) in walls.iter_mut().zip(impulse.iter_mut()) {
        wall.times.push(time);
        wall.forces.push(if span > 0.0 { *accumulated / span } else { 0.0 });
        *accumulated = 0.0;
    }
}

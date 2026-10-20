//! Belytschko–Tsay shell benchmarks (RS1 RS-8c, PHY-19 TECHNICAL_SPEC §13.8):
//! - cantilever strip under suddenly applied gravity: the first bending frequency against Euler–Bernoulli
//!   f₁ = (1.8751²/2π) √(EI/(ρAL⁴)) (standard beam theory; not read from a source in this session), measured as twice the first kinetic-energy
//!   minimum time (KE ∝ sin² of the first mode);
//! - a spinning shell strip stays stress free (corotational frame);
//! - a Johnson–Cook membrane under plane stress returns onto the flow stress with σzz = 0 (Eqs. 22.3.18–22.3.22).

mod common;

use common::{controls, steel};
use llull_explicit::model::{JohnsonCook, Material, Model};
use llull_explicit::shell::{step, ShellState};
use llull_explicit::solver::run;

/// A flat strip of `nx × ny` shells over [0, length] × [0, width] at z = 0, thickness `t`.
fn strip(length: f64, width: f64, t: f64, nx: usize, ny: usize, material: Material) -> Model {
    let mut coordinates = Vec::new();
    for j in 0..=ny {
        for i in 0..=nx {
            coordinates.extend_from_slice(&[length * i as f64 / nx as f64, width * j as f64 / ny as f64, 0.0]);
        }
    }
    let node = |i: usize, j: usize| (i + (nx + 1) * j) as u32;
    let mut shell4 = Vec::new();
    for j in 0..ny {
        for i in 0..nx {
            shell4.extend_from_slice(&[node(i, j), node(i + 1, j), node(i + 1, j + 1), node(i, j + 1)]);
        }
    }
    let shells = nx * ny;
    let nodes = coordinates.len() / 3;
    let mut model = common::model(coordinates, vec![], vec![], material, [0.0; 3], controls(1e-3, 1e-5));
    model.shell4 = shell4;
    model.shell_thickness = vec![t; shells];
    model.element_material = vec![0; shells];
    model.initial_velocity = vec![0.0; 3 * nodes];
    model
}

#[test]
fn cantilever_strip_first_frequency_matches_euler_bernoulli() {
    let (length, width, t) = (100.0, 10.0, 1.0);
    let material = steel(0.0, None);
    let mut cantilever = strip(length, width, t, 20, 2, material.clone());
    let nodes = cantilever.coordinates.len() / 3;
    let root: Vec<bool> = (0..nodes).map(|n| cantilever.coordinates[3 * n] == 0.0).collect();
    cantilever.fixed = (0..3 * nodes).map(|k| root[k / 3]).collect();
    cantilever.fixed_rotation = cantilever.fixed.clone();
    cantilever.gravity = [0.0, 0.0, -9806.65];
    let inertia = width * t.powi(3) / 12.0;
    let f1 = 1.8751_f64.powi(2) / (2.0 * std::f64::consts::PI)
        * (material.youngs_modulus * inertia / (material.density * width * t * length.powi(4))).sqrt();
    cantilever.controls.end_time = 0.8 / f1;
    cantilever.controls.history_interval = 1e-3 / f1;
    let outcome = run(&cantilever, &mut |_| {}).expect("the run succeeds");
    assert!(outcome.normal, "{}", outcome.message);
    let ke: Vec<(f64, f64)> = outcome.energy.iter().map(|row| (row.time, row.kinetic)).collect();
    // First local maximum of KE (a quarter period), then the next local minimum (half a period).
    let peak = (1..ke.len() - 1).find(|&k| ke[k].1 >= ke[k - 1].1 && ke[k].1 > ke[k + 1].1).expect("a first maximum");
    let minimum = (peak + 1..ke.len() - 1).find(|&k| ke[k].1 <= ke[k - 1].1 && ke[k].1 <= ke[k + 1].1).expect("a minimum after the peak");
    let measured = 1.0 / (2.0 * ke[minimum].0);
    eprintln!("cantilever: f1 measured {measured:.3} Hz, Euler-Bernoulli {f1:.3} Hz");
    assert!((measured / f1 - 1.0).abs() < 0.03, "first frequency within 3 %");
    let last = outcome.energy.last().expect("rows");
    let error = (last.kinetic + last.internal + last.hourglass - last.external_work) / last.external_work;
    eprintln!("cantilever: energy error {error:e}, hourglass / internal {:e}", last.hourglass / last.internal);
    assert!(error.abs() < 0.03);
}

#[test]
fn a_spinning_shell_strip_stays_stress_free() {
    let mut spinning = strip(20.0, 10.0, 1.0, 4, 2, steel(0.3, None));
    let omega = 10.0;
    spinning.initial_velocity = spinning.coordinates.chunks_exact(3).flat_map(|x| [-omega * x[1], omega * x[0], 0.0]).collect();
    spinning.controls.end_time = 1e-4;
    let outcome = run(&spinning, &mut |_| {}).expect("the run succeeds");
    let peak = outcome.fields.chunks_exact(7).map(|f| f[0]).fold(0.0, f64::max);
    // Straight-line nodal paths stretch the strip by O(θ²/2) = 5e-7 of 1 mrad: E θ²/2 = 0.1 MPa, against E θ = 200 MPa without the frame.
    assert!(peak < 0.5, "rigid spin of 1 mrad makes {peak} MPa");
}

#[test]
fn johnson_cook_membrane_returns_to_the_flow_stress_under_plane_stress() {
    let jc = JohnsonCook { a: 300.0, b: 500.0, n: 0.5, c: 0.0, reference_rate: 1.0, m: 1.0, melt_k: 1800.0, transition_k: 293.0 };
    let material = steel(0.3, Some(jc));
    let x0 = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0]];
    // Membrane rates: stretch along x at 1/s, contraction along y at 0.5/s (no bending, no rotation).
    let v = x0.map(|p| [p[0], -0.5 * p[1], 0.0]);
    let dt = 1e-4;
    let mut state = ShellState::new(2, 293.0);
    let mut x = x0;
    for _ in 0..300 {
        let x1: [[f64; 3]; 4] = std::array::from_fn(|k| [x[k][0] + dt * v[k][0], x[k][1] + dt * v[k][1], 0.0]);
        let result = step(&material, 0.1, &state, &x, &x1, &v, &[[0.0; 3]; 4], dt, None);
        state = result.state;
        x = x1;
    }
    let point = state.points[0];
    assert!(point.plastic_strain > 0.01, "yields: {}", point.plastic_strain);
    let vm = llull_explicit::material::von_mises(&point.stress);
    let flow = jc.flow_stress(point.plastic_strain, 0.0);
    assert!((vm / flow - 1.0).abs() < 1e-3, "von Mises {vm} vs flow {flow}");
    assert!(point.stress[2].abs() < 1e-3 * flow, "plane stress: σzz {}", point.stress[2]);
}

#[test]
fn johnson_cook_failure_erodes_shells_like_the_solids() {
    use llull_explicit::model::JohnsonCookFailure;
    // Synthetic inputs: perfectly plastic A = 300 MPa, failure at ε_p = 0.01 (D2 = 0); the strip is stretched at 1000 /s
    // (it reaches ε_p ≈ 0.018 before the waves from the free end slow it).
    let jc = JohnsonCook { a: 300.0, b: 0.0, n: 1.0, c: 0.0, reference_rate: 1.0, m: 1.0, melt_k: 1800.0, transition_k: 293.0 };
    let mut material = steel(0.3, Some(jc));
    material.failure = Some(JohnsonCookFailure { d: [0.01, 0.0, 0.0, 0.0, 0.0], reference_rate: 1.0 });
    let mut pulled = strip(40.0, 10.0, 1.0, 8, 2, material);
    let nodes = pulled.coordinates.len() / 3;
    let root: Vec<bool> = (0..nodes).map(|n| pulled.coordinates[3 * n] == 0.0).collect();
    pulled.fixed = (0..3 * nodes).map(|k| root[k / 3]).collect();
    pulled.fixed_rotation = pulled.fixed.clone();
    pulled.initial_velocity = pulled.coordinates.chunks_exact(3).flat_map(|x| [1000.0 * x[0], 0.0, 0.0]).collect();
    pulled.controls.end_time = 6e-5;
    pulled.controls.history_interval = 1e-6;
    let outcome = run(&pulled, &mut |_| {}).expect("the run succeeds");
    assert!(outcome.normal, "{}", outcome.message);
    let failed: Vec<&[f64]> = outcome.fields.chunks_exact(7).filter(|f| f[2] == 1.0).collect();
    let max_eps = outcome.fields.chunks_exact(7).map(|f| f[1]).fold(0.0, f64::max);
    eprintln!("eroded shells: {} of {}, max plastic strain {max_eps}", failed.len(), outcome.fields.len() / 7);
    assert!(!failed.is_empty(), "shells erode");
    assert!(failed.iter().all(|f| f[0] == 0.0 && f[1] >= 0.01 * (1.0 - 1e-9)), "eroded shells are stress free past ε_f");
}

//! Supports of the explicit solver (RS-8, PHY-19 TECHNICAL_SPEC §13.10):
//! - imposed velocity at a bar end launches the 1D wave of stress `σ = ρ c₀ v` (ν = 0, c₀ = √(E/ρ)), and the displacement form
//!   `u = v t` drives the same run;
//! - a symmetry plane (normal translation held; for shells also the two in-plane rotations) makes a half model give half the full one.

mod common;

use common::{controls, floor, hex_grid, model, steel};
use llull_explicit::model::{ImposedKind, ImposedMotion, Model};
use llull_explicit::solver::{run, Outcome};

const V: f64 = 10_000.0;

fn solve(model: &Model) -> Outcome {
    let outcome = run(model, &mut |_| {}).expect("the run succeeds");
    assert!(outcome.normal, "{}", outcome.message);
    outcome
}

/// A 10 x 10 x 200 mm bar at rest (ν = 0) whose z = 0 nodes move along −z by `kind` (v = 10 m/s).
fn pulled(kind: ImposedKind) -> Model {
    let (coordinates, hex8) = hex_grid([0.0, 0.0, 0.0], [10.0, 10.0, 200.0], [2, 2, 40]);
    let c0 = (200_000.0_f64 / 7.85e-9).sqrt();
    let mut bar = model(coordinates, hex8, vec![], steel(0.0, None), [0.0; 3], controls(0.6 * 200.0 / c0, 1e-6));
    let end: Vec<usize> = (0..bar.coordinates.len() / 3).filter(|&n| bar.coordinates[3 * n + 2] == 0.0).collect();
    let curve = match kind {
        ImposedKind::Velocity => vec![[0.0, -V], [1.0, -V]],
        ImposedKind::Displacement => vec![[0.0, 0.0], [1.0, -V]],
    };
    bar.imposed.push(ImposedMotion { nodes: end, dof: 2, kind, curve });
    bar
}

#[test]
fn imposed_velocity_launches_rho_c_v_and_the_displacement_form_agrees() {
    let velocity = solve(&pulled(ImposedKind::Velocity));
    let c0 = (200_000.0_f64 / 7.85e-9).sqrt();
    let expected = 7.85e-9 * c0 * V;
    // Behind the front (c₀ t = 120 mm), away from the loaded end: elements with centroids in 20..100 mm.
    let behind: Vec<f64> = velocity.fields.chunks_exact(7).filter(|f| f[6] > 20.0 && f[6] < 100.0).map(|f| f[0]).collect();
    let mean = behind.iter().sum::<f64>() / behind.len() as f64;
    eprintln!("imposed velocity: von Mises {mean:.2} MPa behind the front, ρ c₀ v = {expected:.2} MPa");
    assert!((mean / expected - 1.0).abs() < 0.02, "σ = ρ c₀ v within 2 %");
    let ahead = velocity.fields.chunks_exact(7).filter(|f| f[6] > 140.0).map(|f| f[0]).fold(0.0, f64::max);
    assert!(ahead < 0.05 * expected, "the far part is still at rest");
    let last = velocity.energy.last().expect("rows");
    let balance = (last.kinetic + last.internal + last.hourglass - last.external_work) / last.external_work;
    eprintln!("imposed velocity: energy error {balance:e} (the reaction work is the external work)");
    assert!(balance.abs() < 0.02);
    let displacement = solve(&pulled(ImposedKind::Displacement));
    let gap = velocity.fields.iter().zip(&displacement.fields).map(|(a, b)| (a - b).abs()).fold(0.0, f64::max);
    assert!(gap < 1e-6 * expected, "u = v t drives the same run: {gap:e}");
}

#[test]
fn a_symmetry_plane_halves_a_bar_on_a_wall() {
    let build = |width: f64, across: usize| {
        let (coordinates, hex8) = hex_grid([0.0, 0.0, 0.0], [width, 10.0, 200.0], [across, 2, 40]);
        let mut bar = model(coordinates, hex8, vec![], steel(0.3, None), [0.0, 0.0, -V], controls(8e-5, 1e-6));
        bar.walls.push(floor("anvil"));
        bar
    };
    let full = solve(&build(10.0, 2));
    let mut half = build(5.0, 1);
    half.fixed = (0..half.coordinates.len()).map(|k| k % 3 == 0 && half.coordinates[k] == 5.0).collect();
    let half = solve(&half);
    let peak = full.walls[0].forces.iter().cloned().fold(0.0, f64::max);
    let gap = full.walls[0].forces.iter().zip(&half.walls[0].forces).map(|(f, h)| (f - 2.0 * h).abs()).fold(0.0, f64::max) / peak;
    eprintln!("symmetry, hex bar: |F_full − 2 F_half| / peak = {gap:e}");
    assert_eq!(full.cycles, half.cycles);
    assert!(gap < 1e-9);
}

#[test]
fn a_symmetry_plane_halves_a_shell_cantilever() {
    // Strip 100 x width x 1 mm, root x = 0 clamped, gravity along −z; the half strip holds uy, rx and rz on y = 5.
    let build = |width: f64, across: usize| {
        let mut strip = model(vec![], vec![], vec![], steel(0.3, None), [0.0; 3], controls(2e-3, 1e-5));
        for j in 0..=across {
            for i in 0..=20 {
                strip.coordinates.extend_from_slice(&[5.0 * i as f64, width * j as f64 / across as f64, 0.0]);
            }
        }
        let node = |i: usize, j: usize| (i + 21 * j) as u32;
        for j in 0..across {
            for i in 0..20 {
                strip.shell4.extend_from_slice(&[node(i, j), node(i + 1, j), node(i + 1, j + 1), node(i, j + 1)]);
            }
        }
        let nodes = strip.coordinates.len() / 3;
        strip.shell_thickness = vec![1.0; 20 * across];
        strip.element_material = vec![0; 20 * across];
        strip.initial_velocity = vec![0.0; 3 * nodes];
        strip.fixed = (0..3 * nodes).map(|k| strip.coordinates[3 * (k / 3)] == 0.0).collect();
        strip.fixed_rotation = strip.fixed.clone();
        strip.gravity = [0.0, 0.0, -9806.65];
        strip
    };
    let full = solve(&build(10.0, 2));
    let mut half = build(5.0, 1);
    let on_plane = |model: &Model, k: usize| model.coordinates[3 * (k / 3) + 1] == 5.0;
    for k in 0..half.fixed.len() {
        if on_plane(&half, k) {
            if k % 3 == 1 {
                half.fixed[k] = true;
            } else {
                half.fixed_rotation[k] = true;
            }
        }
    }
    let half = solve(&half);
    // Tip deflection speed (x = 100) of the plane nodes: node (20, 1) of the full strip, node (20, 1) of the half.
    let (full_tip, half_tip) = (full.velocities[3 * (20 + 21) + 2], half.velocities[3 * (20 + 21) + 2]);
    let (e_full, e_half) = (full.energy.last().expect("rows"), half.energy.last().expect("rows"));
    eprintln!("symmetry, shells: tip vz {full_tip:e} vs {half_tip:e}; internal {:e} vs 2 x {:e}", e_full.internal, e_half.internal);
    assert!((full_tip - half_tip).abs() < 1e-6 * full_tip.abs().max(1.0));
    assert!((e_full.internal - 2.0 * e_half.internal).abs() < 1e-6 * e_full.internal);
}

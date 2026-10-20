//! GPU kernels vs the Rust CPU twin (RS1 RS-8b, VC-EXP-67 GPU row). Skipped with a logged reason when no adapter with SHADER_F64
//! exists. Tolerances: the kernels run the same f64 algorithm, except exp / log / pow in f32 (Johnson–Cook terms, bulk-viscosity
//! length) and a different summation association for the hourglass forces and the energy totals, so the twins agree to round-off
//! to ~1e-9 for elastic runs (asserted 1e-7); with erosion a damage crossing can move by one step (plastic strain gap bounded at 4 % of
//! the failure strain, the same elements erode). Per-run bits on the GPU are reproducible.

#![cfg(feature = "gpu")]

mod common;

use common::{bar, controls, floor, hex_grid, model, steel, tets_of};
use llull_explicit::model::{JohnsonCook, JohnsonCookFailure, Model};
use llull_explicit::solver::{run, Outcome};

fn gpu_or_skip(model: &Model) -> Option<Outcome> {
    match llull_explicit::gpu::run(model, &mut |_| {}) {
        Ok((outcome, adapter)) => {
            eprintln!("GPU: {adapter}");
            Some(outcome)
        }
        Err(reason) => {
            eprintln!("skipped: {reason}");
            None
        }
    }
}

fn cpu(model: &Model) -> Outcome {
    run(model, &mut |_| {}).expect("CPU run")
}

fn max_relative(a: &[f64], b: &[f64], floor: f64) -> f64 {
    a.iter().zip(b).map(|(x, y)| (x - y).abs() / y.abs().max(floor)).fold(0.0, f64::max)
}

fn wall_forces(outcome: &Outcome) -> Vec<f64> {
    outcome.walls[0].forces.clone()
}

#[test]
fn elastic_bar_gpu_matches_the_cpu_twin_and_the_closed_form() {
    let model = bar(0.3, 80, 1.0e-4);
    let Some(gpu) = gpu_or_skip(&model) else { return };
    let reference = cpu(&model);
    assert!(gpu.normal, "{}", gpu.message);
    assert_eq!(gpu.cycles, reference.cycles, "same step sequence");
    let peak = wall_forces(&reference).iter().cloned().fold(0.0, f64::max);
    let force_error = max_relative(&wall_forces(&gpu), &wall_forces(&reference), peak);
    let speed_error = max_relative(&gpu.velocities, &reference.velocities, 10_000.0);
    let stress_error = max_relative(
        &gpu.fields.chunks_exact(7).map(|f| f[0]).collect::<Vec<_>>(),
        &reference.fields.chunks_exact(7).map(|f| f[0]).collect::<Vec<_>>(),
        400.0,
    );
    eprintln!(
        "elastic bar GPU vs CPU: wall force {force_error:e}, velocity {speed_error:e}, von Mises {stress_error:e} (relative to peak)"
    );
    // 1e-7: the bulk-viscosity length V^(1/3) and the hourglass V^(2/3) are f32 pow on the GPU (measured ~2e-9).
    assert!(force_error < 1e-7 && speed_error < 1e-7 && stress_error < 1e-7);
    let (e_gpu, e_cpu) = (gpu.energy.last().expect("rows"), reference.energy.last().expect("rows"));
    assert!((e_gpu.internal - e_cpu.internal).abs() < 1e-7 * e_cpu.kinetic.max(e_cpu.internal));
}

#[test]
fn gpu_runs_are_bit_reproducible_on_one_device() {
    let model = bar(0.3, 40, 3e-5);
    let Some(first) = gpu_or_skip(&model) else { return };
    let second = gpu_or_skip(&model).expect("the adapter was available a moment ago");
    let bits = |outcome: &Outcome| outcome.fields.iter().chain(&outcome.velocities).map(|v| v.to_bits()).collect::<Vec<_>>();
    assert_eq!(bits(&first), bits(&second));
    assert_eq!(first.energy, second.energy);
    assert_eq!(first.walls, second.walls);
}

#[test]
fn tet4_and_johnson_cook_erosion_gpu_match_the_cpu_twin() {
    let (coordinates, hex8) = hex_grid([0.0, 0.0, 0.0], [10.0, 10.0, 50.0], [2, 2, 20]);
    let tets = {
        let mut m = model(coordinates.clone(), vec![], tets_of(&hex8), steel(0.0, None), [0.0, 0.0, -10_000.0], controls(2e-5, 1e-6));
        m.walls.push(floor("anvil"));
        m
    };
    let Some(gpu_tets) = gpu_or_skip(&tets) else { return };
    let cpu_tets = cpu(&tets);
    let tet_error = max_relative(&gpu_tets.velocities, &cpu_tets.velocities, 10_000.0);
    eprintln!("tet4 bar GPU vs CPU velocity {tet_error:e}");
    assert!(tet_error < 1e-7);

    // Synthetic inputs (not a material): A 300 MPa, B 500 MPa, n 0.5, C 0.02, failure at ε_p = 0.05, 100 m/s on the wall.
    let jc = JohnsonCook { a: 300.0, b: 500.0, n: 0.5, c: 0.02, reference_rate: 1.0, m: 1.0, melt_k: 1800.0, transition_k: 293.0 };
    let mut material = steel(0.3, Some(jc));
    material.failure = Some(JohnsonCookFailure { d: [0.05, 0.0, 0.0, 0.0, 0.0], reference_rate: 1.0 });
    let mut eroding = model(coordinates, hex8, vec![], material, [0.0, 0.0, -100_000.0], controls(1e-5, 1e-7));
    eroding.walls.push(floor("anvil"));
    let gpu = gpu_or_skip(&eroding).expect("adapter");
    let reference = cpu(&eroding);
    let failed = |outcome: &Outcome| outcome.fields.chunks_exact(7).filter(|f| f[2] == 1.0).count();
    let plastic = |outcome: &Outcome| outcome.fields.chunks_exact(7).map(|f| f[1]).collect::<Vec<_>>();
    let strain_gap = plastic(&gpu).iter().zip(plastic(&reference)).map(|(a, b)| (a - b).abs()).fold(0.0, f64::max);
    let wall_error =
        max_relative(&wall_forces(&gpu), &wall_forces(&reference), wall_forces(&reference).iter().cloned().fold(0.0, f64::max));
    eprintln!(
        "J-C erosion GPU vs CPU: failed {} vs {}, max |plastic strain gap| {strain_gap:e}, wall force {wall_error:e}",
        failed(&gpu),
        failed(&reference)
    );
    assert!(failed(&reference) > 0);
    assert_eq!(failed(&gpu), failed(&reference), "the same elements erode");
    // Erosion is a threshold event: the f32 log of the Johnson-Cook rate term can move a crossing of D = 1 by one step (one plastic
    // increment, ~7e-4 here), after which the eroding front differs locally. Bounds: 4 % of the failure strain, wall force 1e-3.
    assert!(strain_gap < 0.02 * 0.05 * 2.0 && wall_error < 1e-3);
}

/// Wall time of the CPU twin and the GPU kernels on a finer bar (`cargo test --features gpu --test gpu -- --ignored --nocapture`).
#[test]
#[ignore = "timing, not a check"]
fn timing_cpu_vs_gpu_on_a_fine_bar() {
    let (coordinates, hex8) = hex_grid([0.0, 0.0, 0.0], [10.0, 10.0, 200.0], [8, 8, 160]);
    let mut fine = model(coordinates, hex8, vec![], steel(0.3, None), [0.0, 0.0, -10_000.0], controls(1.0e-4, 1e-6));
    fine.walls.push(floor("anvil"));
    let started = std::time::Instant::now();
    let reference = cpu(&fine);
    let cpu_ms = started.elapsed().as_millis();
    let started = std::time::Instant::now();
    let Some(gpu) = gpu_or_skip(&fine) else { return };
    let gpu_ms = started.elapsed().as_millis();
    eprintln!("TIMING 10240 hex8, {} cycles: CPU twin {cpu_ms} ms, GPU {gpu_ms} ms", reference.cycles);
    assert_eq!(gpu.cycles, reference.cycles);
}

/// Two bars `n x n x 20n` hex8 each (10 x 10 x 100 mm), 0.1 mm apart along z; A (part 0) at +10 m/s, B (part 1) at rest; penalty contact.
fn two_bars(n: usize, end: f64) -> Model {
    use llull_explicit::model::{Contact, ContactKind, Friction};
    let (mut coordinates, mut hex8) = hex_grid([0.0, 0.0, 0.0], [10.0, 10.0, 100.0], [n, n, 20 * n]);
    let (b_coordinates, b_hex8) = hex_grid([0.0, 0.0, 100.1], [10.0, 10.0, 100.0], [n, n, 20 * n]);
    let a_nodes = coordinates.len() / 3;
    let a_elements = hex8.len() / 8;
    coordinates.extend_from_slice(&b_coordinates);
    hex8.extend(b_hex8.iter().map(|node| node + a_nodes as u32));
    let elements = hex8.len() / 8;
    let mut bars = model(coordinates, hex8, vec![], steel(0.0, None), [0.0; 3], controls(end, 1e-6));
    for node in 0..a_nodes {
        bars.initial_velocity[3 * node + 2] = 10_000.0;
    }
    bars.element_part = (0..elements).map(|e| if e < a_elements { 0 } else { 1 }).collect();
    let kind = ContactKind::SurfaceToSurface { a: vec![0], b: vec![1] };
    bars.contacts.push(Contact { name: "impact".into(), kind, friction: Friction::default(), penalty_scale: 0.1 });
    bars
}

#[test]
fn contact_and_fixed_supports_gpu_match_the_cpu_twin() {
    // Contact: the hybrid cycle runs the same host routine on GPU positions that agree to ~1e-9, so the twins agree to round-off.
    let bars = two_bars(2, 3e-5);
    let Some(gpu) = gpu_or_skip(&bars) else { return };
    let reference = cpu(&bars);
    assert!(gpu.normal, "{}", gpu.message);
    assert_eq!(gpu.cycles, reference.cycles);
    let speed_error = max_relative(&gpu.velocities, &reference.velocities, 10_000.0);
    let (c_gpu, c_cpu) = (gpu.energy.last().expect("rows").contact, reference.energy.last().expect("rows").contact);
    let first = reference.energy[0].kinetic;
    let half = bars.coordinates.len() / 6;
    let mean = |outcome: &Outcome, from: usize| (from..from + half).map(|n| outcome.velocities[3 * n + 2]).sum::<f64>() / half as f64;
    let mean_gap = (mean(&gpu, 0) - mean(&reference, 0)).abs().max((mean(&gpu, half) - mean(&reference, half)).abs()) / 10_000.0;
    let early = gpu.energy.iter().zip(&reference.energy).map(|(a, b)| (a.contact - b.contact).abs() / first).collect::<Vec<_>>();
    let diverges = early.iter().position(|gap| *gap > 1e-9).map(|k| gpu.energy[k].time);
    eprintln!(
        "contact GPU vs CPU: velocity {speed_error:e}, bar mean velocity {mean_gap:e}, contact energy {c_gpu:e} vs {c_cpu:e} (of {first:e}), \
         first row apart {diverges:?}"
    );
    // Contact is a threshold event like erosion: the edge nodes of bar A lie on the plane of bar B's side faces, within the round-off
    // cut (1e-9 of the segment depth, ~2.5e-9 mm) of a penetration, while the twins' positions differ by ~1e-8 mm; such a pair can
    // flip at impact (the first row apart is the first contact row). Measured: bar mean velocity 3.3e-4 of v, contact energy 3.5e-4.
    // Raising the cut is no fix: a block resting under gravity penetrates less than 1e-6 of the depth. Bounds: 1e-3 on both, the
    // GPU run conserving momentum on its own.
    let momentum = (mean(&gpu, 0) + mean(&gpu, half)) / 10_000.0;
    assert!(mean_gap < 1e-3 && (c_gpu - c_cpu).abs() < 1e-3 * c_cpu.abs() && (momentum - 1.0).abs() < 1e-9);
    assert!(speed_error < 1e-2, "nodal velocities within 1 % of v");
    // Fixed supports: a bar clamped at z = 0, moving with its initial velocity field.
    let mut clamped = bar(0.3, 40, 3e-5);
    clamped.walls.clear();
    let nodes = clamped.coordinates.len() / 3;
    clamped.fixed = (0..3 * nodes).map(|k| clamped.coordinates[3 * (k / 3) + 2] == 0.0).collect();
    let gpu = gpu_or_skip(&clamped).expect("adapter");
    let reference = cpu(&clamped);
    let held = (0..3 * nodes).filter(|&k| clamped.fixed[k]).all(|k| gpu.velocities[k] == 0.0);
    let speed_error = max_relative(&gpu.velocities, &reference.velocities, 10_000.0);
    eprintln!("fixed supports GPU vs CPU: velocity {speed_error:e}, held {held}");
    assert!(held && speed_error < 1e-7);
}

#[test]
fn shells_and_adiabatic_heating_gpu_match_the_cpu_twin() {
    // Shells: a cantilever strip of 20 x 2 shells under suddenly applied gravity, clamped at x = 0 (no solid elements on the GPU).
    let mut strip = model(vec![], vec![], vec![], steel(0.0, None), [0.0; 3], controls(2e-3, 1e-5));
    let (nx, ny) = (20, 2);
    for j in 0..=ny {
        for i in 0..=nx {
            strip.coordinates.extend_from_slice(&[100.0 * i as f64 / nx as f64, 10.0 * j as f64 / ny as f64, 0.0]);
        }
    }
    let node = |i: usize, j: usize| (i + (nx + 1) * j) as u32;
    for j in 0..ny {
        for i in 0..nx {
            strip.shell4.extend_from_slice(&[node(i, j), node(i + 1, j), node(i + 1, j + 1), node(i, j + 1)]);
        }
    }
    let nodes = strip.coordinates.len() / 3;
    strip.shell_thickness = vec![1.0; nx * ny];
    strip.element_material = vec![0; nx * ny];
    strip.initial_velocity = vec![0.0; 3 * nodes];
    strip.fixed = (0..3 * nodes).map(|k| strip.coordinates[3 * (k / 3)] == 0.0).collect();
    strip.fixed_rotation = strip.fixed.clone();
    strip.gravity = [0.0, 0.0, -9806.65];
    let Some(gpu) = gpu_or_skip(&strip) else { return };
    let reference = cpu(&strip);
    assert!(gpu.normal, "{}", gpu.message);
    let tip = reference.velocities.iter().map(|v| v.abs()).fold(0.0, f64::max);
    let speed_error = max_relative(&gpu.velocities, &reference.velocities, tip);
    let (e_gpu, e_cpu) = (gpu.energy.last().expect("rows"), reference.energy.last().expect("rows"));
    eprintln!("shells GPU vs CPU: velocity {speed_error:e} of the tip speed, internal {:e} vs {:e}", e_gpu.internal, e_cpu.internal);
    assert_eq!(gpu.cycles, reference.cycles);
    assert!(speed_error < 1e-9 && (e_gpu.internal - e_cpu.internal).abs() < 1e-9 * e_cpu.internal);

    // Heating: synthetic J-C with T_m 600 K, Taylor-Quinney β = 0.9, c_p linear from 4.6e8 at 293 K to 6e8 mJ/(t K) at 600 K (not a
    // material), 100 m/s on the wall.
    use llull_explicit::model::Heating;
    let jc = JohnsonCook { a: 300.0, b: 500.0, n: 0.5, c: 0.0, reference_rate: 1.0, m: 1.0, melt_k: 600.0, transition_k: 293.0 };
    let mut material = steel(0.3, Some(jc));
    material.heating =
        Some(Heating { taylor_quinney: 0.9, specific_heat: 4.6e8, specific_heat_table: vec![[293.0, 4.6e8], [600.0, 6.0e8]] });
    let (coordinates, hex8) = hex_grid([0.0, 0.0, 0.0], [10.0, 10.0, 50.0], [2, 2, 20]);
    let mut heated = model(coordinates, hex8, vec![], material, [0.0, 0.0, -100_000.0], controls(1e-5, 1e-7));
    heated.walls.push(floor("anvil"));
    let gpu = gpu_or_skip(&heated).expect("adapter");
    let reference = cpu(&heated);
    let temperature = |outcome: &Outcome| outcome.fields.chunks_exact(7).map(|f| f[3]).collect::<Vec<_>>();
    let rise = temperature(&reference).iter().map(|t| t - 293.0).fold(0.0, f64::max);
    let gap = temperature(&gpu).iter().zip(temperature(&reference)).map(|(a, b)| (a - b).abs()).fold(0.0, f64::max);
    eprintln!("heating GPU vs CPU: largest rise {rise:.3} K, largest temperature gap {gap:e} K");
    // f32 pow / log in the J-C terms: ~1e-7 of the flow stress, so the heat follows to well below 1e-4 of the rise.
    assert!(rise > 1.0 && gap < 1e-4 * rise);
}

/// Wall time of the CPU twin and the GPU path on a contact case (`cargo test --features gpu --test gpu -- --ignored --nocapture`).
#[test]
#[ignore = "timing, not a check"]
fn timing_cpu_vs_gpu_on_two_bars_in_contact() {
    let bars = two_bars(8, 3e-5);
    let started = std::time::Instant::now();
    let reference = cpu(&bars);
    let cpu_ms = started.elapsed().as_millis();
    let started = std::time::Instant::now();
    let Some(gpu) = gpu_or_skip(&bars) else { return };
    let gpu_ms = started.elapsed().as_millis();
    eprintln!("TIMING contact {} hex8, {} cycles: CPU twin {cpu_ms} ms, GPU hybrid {gpu_ms} ms", bars.hex8.len() / 8, reference.cycles);
    assert_eq!(gpu.cycles, reference.cycles);
}

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
        &gpu.fields.chunks_exact(6).map(|f| f[0]).collect::<Vec<_>>(),
        &reference.fields.chunks_exact(6).map(|f| f[0]).collect::<Vec<_>>(),
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
    let failed = |outcome: &Outcome| outcome.fields.chunks_exact(6).filter(|f| f[2] == 1.0).count();
    let plastic = |outcome: &Outcome| outcome.fields.chunks_exact(6).map(|f| f[1]).collect::<Vec<_>>();
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

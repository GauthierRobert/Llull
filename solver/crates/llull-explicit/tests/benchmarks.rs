//! Verification benchmarks of `llull-explicit` with closed-form answers (PHY-19 validation pack; TECHNICAL_SPEC §13.4):
//! VC-EXP-67a elastic bar on a rigid wall (σ = ρ c₀ v, t_c = 2L/c₀, elastic rebound), VC-EXP-67b free fall onto a floor (v = √(2gh)),
//! patch tests (rigid translation and rotation are stress free), tet4 vs hex8, Johnson–Cook plastic impact, energy balance, determinism.

mod common;

use common::{bar, controls, floor, hex_grid, model, steel, tets_of};
use llull_explicit::model::JohnsonCook;
use llull_explicit::solver::{run, Outcome};

fn solve(model: &llull_explicit::model::Model) -> Outcome {
    run(model, &mut |_| {}).expect("the run succeeds")
}

/// 1D bar speed and the closed-form wall stress / contact duration of the validation bar (10 m/s, L = 200 mm).
fn bar_answers() -> (f64, f64) {
    let c0 = (200_000.0_f64 / 7.85e-9).sqrt();
    (7.85e-9 * c0 * 10_000.0 * 100.0, 2.0 * 200.0 / c0)
}

/// Contact start, contact end (force above 1 % of its peak) and the mean force over the middle 70 % of the contact.
fn contact(outcome: &Outcome) -> (f64, f64, f64) {
    let wall = &outcome.walls[0];
    let peak = wall.forces.iter().cloned().fold(0.0, f64::max);
    let on: Vec<usize> = (0..wall.forces.len()).filter(|&k| wall.forces[k] > 0.01 * peak).collect();
    let (first, last) = (on[0], on[on.len() - 1]);
    let start = if first == 0 { 0.0 } else { wall.times[first - 1] };
    let end = wall.times[last];
    let span = end - start;
    let window: Vec<f64> = (first..=last)
        .filter(|&k| wall.times[k] > start + 0.15 * span && wall.times[k] < start + 0.85 * span)
        .map(|k| wall.forces[k])
        .collect();
    (start, end, window.iter().sum::<f64>() / window.len() as f64)
}

fn relative(actual: f64, expected: f64) -> f64 {
    (actual / expected - 1.0).abs()
}

fn energy_error(outcome: &Outcome) -> f64 {
    let first = outcome.energy[0];
    outcome
        .energy
        .iter()
        .map(|row| (row.kinetic + row.internal + row.hourglass + row.wall - first.kinetic - row.external_work) / first.kinetic)
        .fold(0.0, |worst: f64, error| worst.max(error.abs()))
}

#[test]
fn vc_exp_67a_elastic_bar_on_a_rigid_wall_nu_zero() {
    let outcome = solve(&bar(0.0, 80, 1.2e-4));
    let (force, duration) = bar_answers();
    let (start, end, plateau) = contact(&outcome);
    assert!(outcome.normal, "{}", outcome.message);
    assert!(relative(plateau, force) < 0.03, "plateau {plateau} N vs {force} N");
    assert!(relative(end - start, duration) < 0.03, "contact {} s vs {duration} s", end - start);
    // Elastic rebound: after separation the bar flies back at ~10 m/s.
    let mean_vz: f64 = outcome.velocities.chunks_exact(3).map(|v| v[2]).sum::<f64>() / (outcome.velocities.len() / 3) as f64;
    assert!(relative(mean_vz, 10_000.0) < 0.03, "rebound {mean_vz} mm/s");
    assert!(energy_error(&outcome) < 0.02, "energy error {}", energy_error(&outcome));
}

#[test]
fn vc_exp_67a_validation_plan_bar_nu_0_3_within_the_pack_tolerance() {
    let outcome = solve(&bar(0.3, 80, 1.0e-4));
    let (force, duration) = bar_answers();
    let (start, end, plateau) = contact(&outcome);
    assert!(relative(plateau, force) < 0.03, "plateau {plateau} N vs {force} N (VC-EXP-50: 3 %)");
    assert!(relative(end - start, duration) < 0.03, "contact {} s vs {duration} s", end - start);
    let last = outcome.energy.last().expect("rows");
    assert!(last.hourglass < 0.1 * last.internal.max(last.kinetic), "hourglass energy {}", last.hourglass);
}

#[test]
fn tet4_bar_matches_the_closed_form() {
    let (coordinates, hex8) = hex_grid([0.0, 0.0, 0.0], [10.0, 10.0, 200.0], [2, 2, 80]);
    let mut tets = model(coordinates, vec![], tets_of(&hex8), steel(0.0, None), [0.0, 0.0, -10_000.0], controls(1.0e-4, 1e-6));
    tets.walls.push(floor("anvil"));
    let outcome = solve(&tets);
    let (force, duration) = bar_answers();
    let (start, end, plateau) = contact(&outcome);
    assert!(relative(plateau, force) < 0.05, "tet4 plateau {plateau} N vs {force} N");
    assert!(relative(end - start, duration) < 0.05, "tet4 contact {} s vs {duration} s", end - start);
}

#[test]
fn vc_exp_67b_free_fall_reaches_the_floor_at_the_closed_form_time_and_speed() {
    let g = 9806.65;
    let height = 10.0;
    let (coordinates, hex8) = hex_grid([0.0, 0.0, height], [20.0, 20.0, 20.0], [2, 2, 2]);
    let mut drop = model(coordinates, hex8, vec![], steel(0.3, None), [0.0; 3], controls((2.0 * height / g).sqrt() * 0.999, 1e-4));
    drop.gravity = [0.0, 0.0, -g];
    drop.walls.push(floor("floor"));
    let outcome = solve(&drop);
    let expected = -(2.0 * g * height).sqrt() * 0.999;
    for v in outcome.velocities.chunks_exact(3) {
        assert!(relative(v[2], expected) < 0.005, "v_z {} vs {expected} (VC-EXP-51: 0.5 %)", v[2]);
    }
    assert!(outcome.walls[0].forces.iter().all(|&force| force == 0.0), "no contact before t = sqrt(2h/g)");
    let last = outcome.energy.last().expect("rows");
    assert!(relative(last.kinetic, last.external_work) < 1e-6, "kinetic {} = gravity work {}", last.kinetic, last.external_work);
}

#[test]
fn rigid_translation_and_spin_are_stress_free() {
    let (coordinates, hex8) = hex_grid([0.0, 0.0, 0.0], [3.0, 2.0, 1.0], [3, 2, 1]);
    let mut moving = model(coordinates.clone(), hex8.clone(), vec![], steel(0.3, None), [1000.0, -500.0, 250.0], controls(1e-5, 1e-6));
    moving.controls.hourglass_coefficient = 0.1;
    let outcome = solve(&moving);
    assert!(outcome.fields.chunks_exact(6).all(|f| f[0] < 1e-9), "translation is stress free");
    // Small rigid spin about z: v = ω × x. Jaumann keeps it stress free to O(Δθ²).
    let omega = 10.0;
    let velocity: Vec<f64> = coordinates.chunks_exact(3).flat_map(|x| [-omega * x[1], omega * x[0], 0.0]).collect();
    let mut spinning = model(coordinates, hex8, vec![], steel(0.3, None), [0.0; 3], controls(1e-4, 1e-5));
    spinning.initial_velocity = velocity;
    let spun = solve(&spinning);
    let peak = spun.fields.chunks_exact(6).map(|f| f[0]).fold(0.0, f64::max);
    // Straight-line nodal paths stretch the body by O(θ²/2) = 5e-7: E θ²/2 = 0.1 MPa, against E θ = 200 MPa for a small-strain update.
    assert!(peak < 0.5, "rigid rotation of {} rad makes {peak} MPa", omega * 1e-4);
}

#[test]
fn johnson_cook_bar_yields_at_the_wall_and_caps_the_elastic_wave() {
    // Synthetic Johnson-Cook constants (test inputs, not a material): A 300 MPa, B 500 MPa, n 0.5, no rate term.
    let jc = JohnsonCook { a: 300.0, b: 500.0, n: 0.5, c: 0.0, reference_rate: 1.0, m: 1.0, melt_k: 1800.0, transition_k: 293.0 };
    let (coordinates, hex8) = hex_grid([0.0, 0.0, 0.0], [10.0, 10.0, 100.0], [2, 2, 40]);
    let mut plastic = model(coordinates, hex8, vec![], steel(0.0, Some(jc)), [0.0, 0.0, -50_000.0], controls(2e-5, 2e-7));
    plastic.walls.push(floor("anvil"));
    let outcome = solve(&plastic);
    // v = 50 m/s exceeds the yield velocity A/(ρc₀) = 7.6 m/s: the elements at the wall deform plastically, the far end stays elastic.
    let near = outcome.fields.chunks_exact(6).filter(|f| f[5] < 5.0).map(|f| f[1]).fold(0.0, f64::max);
    let far = outcome.fields.chunks_exact(6).filter(|f| f[5] > 80.0).map(|f| f[1]).fold(0.0, f64::max);
    assert!(near > 1e-3, "plastic strain at the wall {near}");
    assert_eq!(far, 0.0);
    for f in outcome.fields.chunks_exact(6) {
        let flow = jc.flow_stress(f[1], 0.0);
        assert!(f[0] <= flow * (1.0 + 1e-9) + 1e-9, "von Mises {} above the flow stress {flow}", f[0]);
    }
}

#[test]
fn selective_mass_scaling_raises_every_element_to_the_target_step() {
    // No wall: the bar flies undeformed, so bulk viscosity never shortens the step.
    let mut free = bar(0.3, 20, 2e-6);
    free.walls.clear();
    // The linear bulk-viscosity term switches on for any negative trace, round-off included (LS-DYNA Eq. 25.3): off here.
    free.controls.bulk_linear = 0.0;
    let unscaled = solve(&free);
    let mut scaled = free.clone();
    let target = 4.0 * unscaled.min_time_step;
    scaled.controls.mass_scaling = Some(llull_explicit::model::MassScaling { target_time_step: target, max_added_mass_ratio: 100.0 });
    let outcome = solve(&scaled);
    // The step grows with the square root of the density: four times the step needs sixteen times the mass on a uniform mesh.
    assert!(relative(outcome.min_time_step, target) < 1e-9, "step {} vs target {target}", outcome.min_time_step);
    assert!(
        relative(outcome.added_mass / outcome.initial_mass, 15.0) < 1e-9,
        "added mass ratio {}",
        outcome.added_mass / outcome.initial_mass
    );
    assert!(relative(outcome.initial_mass, 7.85e-9 * 20_000.0) < 1e-12);
}

#[test]
fn runs_are_bit_identical_across_repeats_and_thread_counts() {
    let model = bar(0.3, 40, 2e-5);
    let first = solve(&model);
    let second = solve(&model);
    let single = rayon::ThreadPoolBuilder::new().num_threads(1).build().expect("pool").install(|| solve(&model));
    for other in [&second, &single] {
        assert_eq!(
            first.fields.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            other.fields.iter().map(|v| v.to_bits()).collect::<Vec<_>>()
        );
        assert_eq!(first.energy, other.energy);
        assert_eq!(first.walls, other.walls);
    }
}

#[test]
fn min_time_step_and_inverted_elements_end_abnormally_or_refuse() {
    let mut tight = bar(0.3, 20, 1e-5);
    tight.controls.min_time_step = Some(1.0);
    let outcome = solve(&tight);
    assert!(!outcome.normal && outcome.message.contains("minTimeStep"));
    let mut inverted = bar(0.3, 2, 1e-6);
    inverted.hex8.swap(0, 4);
    inverted.hex8.swap(1, 5);
    inverted.hex8.swap(2, 6);
    inverted.hex8.swap(3, 7);
    assert!(run(&inverted, &mut |_| {}).is_err());
}

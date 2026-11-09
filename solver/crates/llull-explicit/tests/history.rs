//! Time histories (PHY-19 `add_time_history`, src/history.rs): sampling at exact multiples of the interval, free flight, a rigid-wall bounce.

#![allow(clippy::needless_range_loop)]

mod common;

use common::{bar, controls, hex_grid, model, steel};
use llull_explicit::history::{Quantity, Request, Series, Target};
use llull_explicit::solver::{run, Outcome};

fn solve(model: &llull_explicit::model::Model) -> Outcome {
    run(model, &mut |_| {}).expect("the run succeeds")
}

fn series<'a>(outcome: &'a Outcome, name: &str, quantity: Quantity) -> &'a Series {
    outcome.histories.iter().find(|series| series.name == name && series.quantity == quantity).expect("the series was recorded")
}

fn request(name: &str, target: Target, quantities: &[Quantity], interval: Option<f64>) -> Request {
    Request { name: name.to_string(), target, quantities: quantities.to_vec(), interval }
}

/// A 10 mm cube flying free at `velocity` mm/s (no wall, no gravity).
fn flyer(velocity: [f64; 3], end: f64, histories: Vec<Request>) -> llull_explicit::model::Model {
    let (coordinates, hex8) = hex_grid([0.0; 3], [10.0; 3], [2, 2, 2]);
    let mut flying = model(coordinates, hex8, vec![], steel(0.3, None), velocity, controls(end, 1e-4));
    flying.histories = histories;
    flying
}

#[test]
fn free_flight_displacement_is_v_t_acceleration_zero_energy_constant() {
    let v = [100.0, -50.0, 20.0];
    let interval = 1e-4; // not a multiple of the stable step: the samples are interpolated between steps
    let outcome = solve(&flyer(
        v,
        1e-3,
        vec![
            request(
                "tip",
                Target::Nodes(vec![0, 13, 26]),
                &[Quantity::Displacement, Quantity::Velocity, Quantity::Acceleration],
                Some(interval),
            ),
            request(
                "cube",
                Target::Part(0),
                &[Quantity::KineticEnergy, Quantity::Momentum, Quantity::Mass, Quantity::InternalEnergy],
                None,
            ),
        ],
    ));
    assert!(outcome.normal, "{}", outcome.message);
    let displacement = series(&outcome, "tip", Quantity::Displacement);
    assert_eq!(displacement.times.len(), 11);
    for (k, &t) in displacement.times.iter().enumerate() {
        assert!((t - k as f64 * interval).abs() < 1e-15, "sample {k} at {t}");
        for i in 0..3 {
            let expected = v[i] * t;
            assert!((displacement.values[3 * k + i] - expected).abs() < 1e-9, "u[{i}] at {t}: {}", displacement.values[3 * k + i]);
        }
    }
    let velocity = series(&outcome, "tip", Quantity::Velocity);
    let acceleration = series(&outcome, "tip", Quantity::Acceleration);
    for k in 0..11 {
        for i in 0..3 {
            assert!((velocity.values[3 * k + i] - v[i]).abs() < 1e-6, "v at sample {k}");
            assert!(acceleration.values[3 * k + i].abs() < 1e-3, "a at sample {k}: {}", acceleration.values[3 * k + i]);
        }
    }
    let mass = 7.85e-9 * 1000.0;
    let kinetic = 0.5 * mass * (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    let energy = series(&outcome, "cube", Quantity::KineticEnergy);
    let momentum = series(&outcome, "cube", Quantity::Momentum);
    // The default interval is the controls' history interval (1e-4 s): 11 samples again.
    assert_eq!(energy.times.len(), 11);
    for k in 0..11 {
        assert!((energy.values[k] / kinetic - 1.0).abs() < 1e-9, "kinetic energy {} vs {kinetic}", energy.values[k]);
        for i in 0..3 {
            assert!((momentum.values[3 * k + i] / (mass * v[i]) - 1.0).abs() < 1e-9);
        }
    }
    assert!((series(&outcome, "cube", Quantity::Mass).values[0] / mass - 1.0).abs() < 1e-12);
    assert!(series(&outcome, "cube", Quantity::InternalEnergy).values.iter().all(|value| value.abs() < 1e-6 * kinetic));
}

#[test]
fn bar_bouncing_off_a_rigid_wall_gives_the_wall_two_m_v() {
    let mut bouncing = bar(0.0, 40, 1.2e-4);
    bouncing.histories = vec![
        request("anvil", Target::Wall(0), &[Quantity::NormalImpulse, Quantity::NormalForce, Quantity::Energy], None),
        request("bar", Target::Part(0), &[Quantity::Momentum, Quantity::InternalEnergy, Quantity::KineticEnergy], None),
    ];
    let outcome = solve(&bouncing);
    assert!(outcome.normal, "{}", outcome.message);
    let m_v = 7.85e-9 * 10.0 * 10.0 * 200.0 * 10_000.0;
    let impulse = series(&outcome, "anvil", Quantity::NormalImpulse);
    let force = series(&outcome, "anvil", Quantity::NormalForce);
    let energy = series(&outcome, "anvil", Quantity::Energy);
    let momentum = series(&outcome, "bar", Quantity::Momentum);
    let last = impulse.times.len() - 1;
    // Default interval = history interval 1e-6: exact multiples, from t = 0 to the end.
    assert_eq!(last, 120);
    assert!((impulse.times[last] - 1.2e-4).abs() < 1e-12);
    // Elastic bounce: the wall received m v (stopping) + m v (rebound) = Δ momentum = 2 m v.
    let total = impulse.values[last];
    assert!((total / (2.0 * m_v) - 1.0).abs() < 0.03, "impulse {total} vs {}", 2.0 * m_v);
    let delta = momentum.values[3 * last + 2] - momentum.values[2];
    assert!((total / delta - 1.0).abs() < 0.01, "impulse {total} vs Δp {delta}");
    assert!((momentum.values[2] + m_v).abs() < 1e-9 * m_v, "p(0) = -m v");
    // Cumulative impulse never decreases and the force series integrates back to it.
    assert!(impulse.values.windows(2).all(|pair| pair[1] >= pair[0] - 1e-12));
    let integral: f64 = (1..=last).map(|k| force.values[k] * (force.times[k] - force.times[k - 1])).sum();
    // The impulse of the very first step (a bar that starts on the wall) is already in the t = 0 sample, whose force is defined as 0.
    let gained = total - impulse.values[0];
    assert!((integral / gained - 1.0).abs() < 1e-9, "integral {integral} vs {gained}");
    assert_eq!(force.values[0], 0.0);
    // Stonewall energy: non-negative and non-decreasing.
    assert!(energy.values.iter().all(|&value| value >= -1e-12));
    assert!(energy.values.windows(2).all(|pair| pair[1] >= pair[0] - 1e-9));
    // Internal energy peaks near the initial kinetic energy and is released by the rebound.
    let internal = series(&outcome, "bar", Quantity::InternalEnergy);
    let initial = 0.5 * m_v * 10_000.0;
    let peak = internal.values.iter().cloned().fold(0.0, f64::max);
    assert!((peak / initial - 1.0).abs() < 0.05, "peak internal {peak} vs {initial}");
    assert!(internal.values[last] < 0.05 * initial, "released: {}", internal.values[last]);
}

#[test]
fn an_interval_longer_than_one_step_and_a_multiple_inside_a_step_both_land_on_the_grid() {
    let fine = solve(&flyer([10.0, 0.0, 0.0], 1e-4, vec![request("n", Target::Nodes(vec![0]), &[Quantity::Displacement], Some(1e-9))]));
    let coarse = solve(&flyer([10.0, 0.0, 0.0], 1e-4, vec![request("n", Target::Nodes(vec![0]), &[Quantity::Displacement], Some(1e-4))]));
    let fine = series(&fine, "n", Quantity::Displacement);
    // 1e-9 s is far below the stable step: several samples fall inside one step, each still exactly v t.
    assert_eq!(fine.times.len(), 100_001);
    assert!((fine.values[3 * 54_321] - 10.0 * 54_321.0 * 1e-9).abs() < 1e-9);
    let coarse = series(&coarse, "n", Quantity::Displacement);
    assert_eq!(coarse.times.len(), 2);
    assert!((coarse.values[3] - 1e-3).abs() < 1e-12);
}

#[test]
fn no_request_records_nothing() {
    assert!(solve(&flyer([10.0, 0.0, 0.0], 1e-5, vec![])).histories.is_empty());
}

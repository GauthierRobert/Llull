//! Penalty contact benchmarks with closed forms (RS1 RS-8c, PHY-19 TECHNICAL_SPEC §13.7):
//! - two identical elastic bars (ν = 0) colliding at v: 1D wave theory gives an interface stress ρc₀v/2, a contact time 2L/c₀ and an
//!   exchange of velocities; momentum is conserved exactly by equal and opposite penalty forces;
//! - a block sliding on a fixed plate under gravity with Coulomb friction μ: deceleration μg, stopping distance v₀²/(2μg) (the classical
//!   result the Abaqus "Friction models in Abaqus/Explicit" verification problem checks);
//! - self contact gives the two-surface answer and never acts inside one body.

mod common;

use common::{controls, hex_grid, model, steel};
use llull_explicit::model::{Contact, ContactKind, Friction, Model};
use llull_explicit::solver::{run, Outcome};

fn solve(model: &Model) -> Outcome {
    run(model, &mut |_| {}).expect("the run succeeds")
}

/// Two 10 x 10 x 100 mm bars, 2 x 2 x 40 hex8 each, 0.1 mm apart along z; bar A (part 0) moves at +10 m/s, bar B (part 1) is at rest.
fn two_bars(kind: ContactKind) -> (Model, usize) {
    let (mut coordinates, mut hex8) = hex_grid([0.0, 0.0, 0.0], [10.0, 10.0, 100.0], [2, 2, 40]);
    let (b_coordinates, b_hex8) = hex_grid([0.0, 0.0, 100.1], [10.0, 10.0, 100.0], [2, 2, 40]);
    let a_nodes = coordinates.len() / 3;
    let a_elements = hex8.len() / 8;
    coordinates.extend_from_slice(&b_coordinates);
    hex8.extend(b_hex8.iter().map(|node| node + a_nodes as u32));
    let elements = hex8.len() / 8;
    let mut bars = model(coordinates, hex8, vec![], steel(0.0, None), [0.0; 3], controls(6.5e-5, 1e-6));
    for node in 0..a_nodes {
        bars.initial_velocity[3 * node + 2] = 10_000.0;
    }
    bars.element_part = (0..elements).map(|e| if e < a_elements { 0 } else { 1 }).collect();
    bars.contacts.push(Contact { name: "impact".into(), kind, friction: Friction::default(), penalty_scale: 0.1 });
    (bars, a_nodes)
}

fn mean_vz(outcome: &Outcome, nodes: std::ops::Range<usize>) -> f64 {
    let count = nodes.len() as f64;
    nodes.map(|node| outcome.velocities[3 * node + 2]).sum::<f64>() / count
}

#[test]
fn two_identical_bars_exchange_velocities_and_conserve_momentum() {
    let (bars, a_nodes) = two_bars(ContactKind::SurfaceToSurface { a: vec![0], b: vec![1] });
    let outcome = solve(&bars);
    let nodes = bars.coordinates.len() / 3;
    let (a, b) = (mean_vz(&outcome, 0..a_nodes), mean_vz(&outcome, a_nodes..nodes));
    eprintln!("two bars: A {a:.1} mm/s, B {b:.1} mm/s (expected 0 and 10000)");
    assert!(a.abs() < 0.05 * 10_000.0 && (b - 10_000.0).abs() < 0.05 * 10_000.0, "velocities exchange within 5 %");
    // Every node of a bar has the same lumped mass here, so momentum conservation reads as mean velocities adding up.
    assert!(((a + b) - 10_000.0).abs() < 1e-6 * 10_000.0, "momentum is conserved: {}", a + b);
    let first = outcome.energy[0];
    let last = outcome.energy.last().expect("rows");
    let error = (last.kinetic + last.internal + last.hourglass + last.contact - first.kinetic) / first.kinetic;
    eprintln!("two bars: energy error {error:e}, contact energy left {:e}", last.contact / first.kinetic);
    assert!(error.abs() < 0.03 && last.contact.abs() < 0.02 * first.kinetic, "elastic impact: energy recovered, springs unloaded");
}

#[test]
fn self_contact_gives_the_two_surface_answer() {
    let (pair, a_nodes) = two_bars(ContactKind::SurfaceToSurface { a: vec![0], b: vec![1] });
    let (mut single, _) = two_bars(ContactKind::SelfContact { parts: vec![0] });
    single.element_part = vec![0; single.element_count()];
    let (two, one) = (solve(&pair), solve(&single));
    let nodes = pair.coordinates.len() / 3;
    for range in [0..a_nodes, a_nodes..nodes] {
        let (x, y) = (mean_vz(&two, range.clone()), mean_vz(&one, range));
        assert!((x - y).abs() < 1e-6 * 10_000.0, "self {y} vs two-surface {x}");
    }
}

#[test]
fn self_contact_never_acts_inside_one_body() {
    let (coordinates, hex8) = hex_grid([0.0, 0.0, 0.0], [10.0, 10.0, 2.0], [4, 4, 1]);
    let mut plate = model(coordinates, hex8, vec![], steel(0.3, None), [1000.0, 0.0, 0.0], controls(2e-5, 1e-6));
    plate.contacts.push(Contact {
        name: "self".into(),
        kind: ContactKind::SelfContact { parts: vec![0] },
        friction: Friction { static_coefficient: 0.5, dynamic_coefficient: 0.5, decay: 0.0 },
        penalty_scale: 0.1,
    });
    let outcome = solve(&plate);
    assert!(outcome.fields.chunks_exact(7).all(|f| f[0] < 1e-6), "a translating one-element-thick plate stays stress free");
    assert!(outcome.energy.iter().all(|row| row.contact == 0.0));
}

#[test]
fn coulomb_block_stops_at_v0_squared_over_two_mu_g() {
    let (g, mu, v0) = (9806.65, 0.5, 150.0);
    // Fixed plate 80 x 30 x 5 mm (part 1) and a 10 mm block (part 0) resting on it, sliding at 0.15 m/s along x.
    let (mut coordinates, mut hex8) = hex_grid([5.0, 10.0, 5.0], [10.0, 10.0, 10.0], [2, 2, 2]);
    let block_nodes = coordinates.len() / 3;
    let block_elements = hex8.len() / 8;
    let (p_coordinates, p_hex8) = hex_grid([0.0, 0.0, 0.0], [80.0, 30.0, 5.0], [16, 6, 1]);
    coordinates.extend_from_slice(&p_coordinates);
    hex8.extend(p_hex8.iter().map(|node| node + block_nodes as u32));
    let elements = hex8.len() / 8;
    let nodes = coordinates.len() / 3;
    let stop_time = v0 / (mu * g);
    let mut sliding = model(coordinates, hex8, vec![], steel(0.3, None), [0.0; 3], controls(1.3 * stop_time, 1e-3));
    sliding.gravity = [0.0, 0.0, -g];
    for node in 0..block_nodes {
        sliding.initial_velocity[3 * node] = v0;
    }
    sliding.element_part = (0..elements).map(|e| if e < block_elements { 0 } else { 1 }).collect();
    sliding.fixed = (0..3 * nodes).map(|k| k / 3 >= block_nodes).collect();
    sliding.contacts.push(Contact {
        name: "slide".into(),
        // One way, block nodes on plate segments: the usual choice for a body sliding on a surface (symmetric contact lets plate nodes
        // lying in the block bottom plane catch its leading face, TECHNICAL_SPEC §13.7).
        kind: ContactKind::NodesToSurface { slave: vec![0], master: vec![1] },
        friction: Friction { static_coefficient: mu, dynamic_coefficient: mu, decay: 0.0 },
        penalty_scale: 0.1,
    });
    let outcome = solve(&sliding);
    assert!(outcome.normal, "{}", outcome.message);
    let travel =
        (0..block_nodes).map(|node| outcome.coordinates[3 * node] - sliding.coordinates[3 * node]).sum::<f64>() / block_nodes as f64;
    let speed = (0..block_nodes).map(|node| outcome.velocities[3 * node]).sum::<f64>() / block_nodes as f64;
    let expected = v0 * v0 / (2.0 * mu * g);
    eprintln!("Coulomb block: travel {travel:.3} mm (closed form {expected:.3} mm), final speed {speed:.2} mm/s");
    assert!((travel / expected - 1.0).abs() < 0.05, "stopping distance within 5 %");
    assert!(speed.abs() < 0.02 * v0, "the block has stopped (static friction holds)");
    let sunk = (0..block_nodes).map(|node| outcome.coordinates[3 * node + 2] - sliding.coordinates[3 * node + 2]).fold(0.0, f64::min);
    assert!(sunk > -1.0, "the block rests on the plate (penetration {sunk} mm)");
}

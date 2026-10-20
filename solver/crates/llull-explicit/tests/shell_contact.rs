//! Shells in contact (RS-8, PHY-19 TECHNICAL_SPEC §13.9): shell segments as slave and master, offset by half their thickness (LS-DYNA
//! R14 Theory Manual §29.8.2, Figs. 29.11–29.13) with the shell penalty stiffness of Eq. 29.19. Closed forms: two bodies approaching at
//! v with a centre gap d first touch at `t_c = (d − Σ h)/v`, `h` = half the shell thickness (0 for a solid face); the penalty forces are
//! equal and opposite, so the momentum `Σ m v` is conserved; two identical plates exchange their velocities.

mod common;

use common::{controls, hex_grid, steel};
use llull_explicit::model::{Contact, ContactKind, Friction, Model};
use llull_explicit::solver::{run, Outcome};

const V: f64 = 10_000.0;

/// A 10 x 10 mm plate of 2 x 2 shells at height z, thickness t; returns (coordinates, shell4).
fn plate(z: f64, first: u32) -> (Vec<f64>, Vec<u32>) {
    let mut coordinates = Vec::new();
    for j in 0..3 {
        for i in 0..3 {
            coordinates.extend_from_slice(&[5.0 * i as f64, 5.0 * j as f64, z]);
        }
    }
    let node = |i: u32, j: u32| first + i + 3 * j;
    let mut shell4 = Vec::new();
    for j in 0..2 {
        for i in 0..2 {
            shell4.extend_from_slice(&[node(i, j), node(i + 1, j), node(i + 1, j + 1), node(i, j + 1)]);
        }
    }
    (coordinates, shell4)
}

fn contact(model: &mut Model) {
    model.contacts.push(Contact {
        name: "touch".into(),
        kind: ContactKind::SurfaceToSurface { a: vec![0], b: vec![1] },
        friction: Friction::default(),
        penalty_scale: 0.1,
    });
}

/// Nodal masses: every element shares its mass equally among its nodes (row-sum lumping of hex8 and of the shells' translations).
fn nodal_masses(model: &Model) -> Vec<f64> {
    let density = model.materials[0].density;
    let mut masses = vec![0.0; model.coordinates.len() / 3];
    let x = |n: u32, i: usize| model.coordinates[3 * n as usize + i];
    for hex in model.hex8.chunks_exact(8) {
        let volume = (0..3).map(|i| x(hex[6], i) - x(hex[0], i)).product::<f64>();
        hex.iter().for_each(|&n| masses[n as usize] += density * volume / 8.0);
    }
    for (s, quad) in model.shell4.chunks_exact(4).enumerate() {
        let area = (x(quad[2], 0) - x(quad[0], 0)) * (x(quad[2], 1) - x(quad[0], 1));
        quad.iter().for_each(|&n| masses[n as usize] += density * area * model.shell_thickness[s] / 4.0);
    }
    masses
}

fn momentum(masses: &[f64], outcome: &Outcome, nodes: std::ops::Range<usize>) -> f64 {
    nodes.map(|n| masses[n] * outcome.velocities[3 * n + 2]).sum()
}

/// First history time with contact energy (the contact springs loaded).
fn onset(outcome: &Outcome) -> f64 {
    outcome.energy.iter().find(|row| row.contact.abs() > 0.0).map(|row| row.time).expect("contact happens")
}

#[test]
fn two_shell_plates_touch_at_the_offset_surfaces_and_exchange_momentum() {
    let (t, d) = (1.0, 3.0);
    let (mut coordinates, mut shell4) = plate(0.0, 0);
    let (upper, upper_shells) = plate(d, 9);
    coordinates.extend_from_slice(&upper);
    shell4.extend_from_slice(&upper_shells);
    let mut model = common::model(coordinates, vec![], vec![], steel(0.3, None), [0.0; 3], controls(4.5e-4, 1e-6));
    model.shell4 = shell4;
    model.shell_thickness = vec![t; 8];
    model.element_material = vec![0; 8];
    model.element_part = vec![0, 0, 0, 0, 1, 1, 1, 1];
    model.initial_velocity = (0..18).flat_map(|n| [0.0, 0.0, if n < 9 { V } else { 0.0 }]).collect();
    contact(&mut model);
    let outcome = run(&model, &mut |_| {}).expect("the run succeeds");
    assert!(outcome.normal, "{}", outcome.message);
    let expected = (d - t) / V;
    let touched = onset(&outcome);
    eprintln!("two plates: onset {touched:e} s, offset surfaces {expected:e} s, mid-surfaces {:e} s", d / V);
    assert!(touched >= expected && touched <= expected + 2e-6, "contact starts at the offset surfaces");
    let masses = nodal_masses(&model);
    let (a, b) = (momentum(&masses, &outcome, 0..9), momentum(&masses, &outcome, 9..18));
    let total = masses[..9].iter().sum::<f64>() * V;
    eprintln!("two plates: momentum A {:.4}, B {:.4} of {total:.4}", a / total, b / total);
    assert!(((a + b) / total - 1.0).abs() < 1e-9, "momentum conserved");
    assert!(b / total > 0.9 && a / total < 0.1, "the velocities exchange");
}

#[test]
fn a_shell_plate_lands_on_a_solid_block_at_half_its_thickness() {
    let (t, d) = (1.0, 2.0);
    let (mut coordinates, hex8) = hex_grid([0.0, 0.0, -10.0], [10.0, 10.0, 10.0], [2, 2, 2]);
    let block_nodes = coordinates.len() / 3;
    let (upper, shells) = plate(d, block_nodes as u32);
    coordinates.extend_from_slice(&upper);
    let solids = hex8.len() / 8;
    let mut model = common::model(coordinates, hex8, vec![], steel(0.3, None), [0.0; 3], controls(3e-4, 1e-6));
    model.shell4 = shells;
    model.shell_thickness = vec![t; 4];
    model.element_material = vec![0; solids + 4];
    model.element_part = (0..solids + 4).map(|e| if e < solids { 0 } else { 1 }).collect();
    let nodes = block_nodes + 9;
    model.initial_velocity = (0..nodes).flat_map(|n| [0.0, 0.0, if n < block_nodes { 0.0 } else { -V }]).collect();
    contact(&mut model);
    let outcome = run(&model, &mut |_| {}).expect("the run succeeds");
    assert!(outcome.normal, "{}", outcome.message);
    let expected = (d - 0.5 * t) / V;
    let touched = onset(&outcome);
    eprintln!("plate on block: onset {touched:e} s, offset surface {expected:e} s");
    assert!(touched >= expected && touched <= expected + 2e-6, "the plate touches at half its thickness");
    let masses = nodal_masses(&model);
    let (block, plate_momentum) = (momentum(&masses, &outcome, 0..block_nodes), momentum(&masses, &outcome, block_nodes..nodes));
    let total = -masses[block_nodes..].iter().sum::<f64>() * V;
    eprintln!("plate on block: momentum plate {:.4}, block {:.4} of the initial", plate_momentum / total, block / total);
    assert!(((block + plate_momentum) / total - 1.0).abs() < 1e-9, "momentum conserved");
    assert!(plate_momentum / total < 0.5, "the block took the plate's momentum");
}

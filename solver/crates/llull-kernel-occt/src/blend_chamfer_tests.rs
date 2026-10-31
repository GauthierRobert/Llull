//! BLD M5: the variable chamfer (`features::chamfer_variable`, `cpp/blend_chamfer.cxx`). Every tolerance is relative to the part.

use crate::features::{chamfer, chamfer_variable, chamfer_variable_reason};
use crate::queries::topology;
use crate::{boolean, make_box, make_cylinder, mass_properties, BooleanOp, Shape};
use serde_json::Value;

const SCALES: [f64; 4] = [1.0, 10.0, 100.0, 1000.0];

fn num(value: &Value) -> f64 {
    value.as_f64().unwrap()
}

fn volume_of(shape: &Shape) -> f64 {
    mass_properties(shape).unwrap().volume
}

/// The unique edge whose mid point is `at` (within 1e-6 of the part scale).
fn edge_at(shape: &Shape, at: [f64; 3], scale: f64) -> u32 {
    let topo = topology(shape).unwrap();
    let edges = topo["edges"].as_array().unwrap();
    let found = edges.iter().position(|edge| (0..3).all(|axis| (num(&edge["mid"][axis]) - at[axis]).abs() < 1e-6 * scale)).expect("edge");
    found as u32
}

fn block(scale: f64) -> Shape {
    make_box([0.0; 3], [20.0 * scale, 10.0 * scale, 5.0 * scale]).unwrap().unwrap()
}

/// Volume a right-angle edge of length `length` loses to a distance running linearly from `first` to `last`: 1/2 integral d(s)^2 ds.
fn removed(length: f64, first: f64, last: f64) -> f64 {
    0.5 * length * (first * first + first * last + last * last) / 3.0
}

#[test]
fn a_variable_chamfer_removes_half_the_integral_of_the_squared_distance_at_every_size() {
    let _serial = crate::serial_blends();
    for scale in SCALES {
        let part = block(scale);
        let edge = edge_at(&part, [10.0 * scale, 0.0, 5.0 * scale], scale);
        for (first, last) in [(1.0, 2.0), (2.0, 1.0), (1.5, 1.5)] {
            let shape = chamfer_variable(&part, &[edge], &[], first * scale, last * scale, f64::NAN, f64::NAN).unwrap().expect("builds");
            let expected = volume_of(&part) - removed(20.0 * scale, first * scale, last * scale);
            let got = volume_of(&shape);
            assert!((got - expected).abs() < 1e-9 * volume_of(&part), "scale {scale} {first}->{last}: {got} vs {expected}");
            let topo = topology(&shape).unwrap();
            let faces = topo["faces"].as_array().unwrap();
            assert_eq!(faces.len(), 7, "scale {scale}: the chamfer adds one face");
            assert!(
                faces.iter().any(|face| face["name"].as_str().is_some_and(|name| name.contains("chamfer("))),
                "the chamfer face is named by its source edge"
            );
        }
    }
}

#[test]
fn equal_distances_are_the_constant_chamfer_of_the_kernel() {
    let _serial = crate::serial_blends();
    for scale in SCALES {
        let part = block(scale);
        let edge = edge_at(&part, [10.0 * scale, 0.0, 5.0 * scale], scale);
        let variable = chamfer_variable(&part, &[edge], &[], 1.2 * scale, 1.2 * scale, f64::NAN, f64::NAN).unwrap().expect("builds");
        let constant = chamfer(&part, &[edge], 1.2 * scale).unwrap().expect("builds");
        assert!((volume_of(&variable) - volume_of(&constant)).abs() < 1e-9 * volume_of(&part));
    }
}

#[test]
fn a_concave_edge_gains_material() {
    let _serial = crate::serial_blends();
    for scale in SCALES {
        let floor = block(scale);
        let wall = make_box([0.0, 0.0, 0.0], [20.0 * scale, 5.0 * scale, 10.0 * scale]).unwrap().unwrap();
        let part = boolean(BooleanOp::Union, &floor, &wall, true).unwrap().unwrap();
        let edge = edge_at(&part, [10.0 * scale, 5.0 * scale, 5.0 * scale], scale);
        let shape = chamfer_variable(&part, &[edge], &[], scale, 2.0 * scale, f64::NAN, f64::NAN).unwrap().expect("builds");
        let expected = volume_of(&part) + removed(20.0 * scale, scale, 2.0 * scale);
        assert!((volume_of(&shape) - expected).abs() < 1e-9 * volume_of(&part), "scale {scale}");
    }
}

#[test]
fn what_it_cannot_build_is_refused_with_the_reason() {
    let _serial = crate::serial_blends();
    let part = block(1.0);
    let top = edge_at(&part, [10.0, 0.0, 5.0], 1.0);
    let side = edge_at(&part, [0.0, 0.0, 2.5], 1.0);
    let reason = |edges: &[u32], first: f64, last: f64| chamfer_variable_reason(&part, edges, &[], first, last, f64::NAN, f64::NAN).unwrap();
    assert!(reason(&[top], 1.0, 2.0).is_empty());
    assert!(reason(&[], 1.0, 2.0).contains("listed"));
    assert!(reason(&[top, side], 1.0, 2.0).contains("meet at a vertex"));
    assert!(reason(&[top, top], 1.0, 2.0).contains("twice"));
    assert!(reason(&[top], 1.0, 6.0).contains("reaches past the faces"));
    assert!(reason(&[top], 0.0, 2.0).contains("> 0"));
    assert!(reason(&[999], 1.0, 2.0).contains("out of range"));
    let pipe = make_cylinder(5.0, 10.0).unwrap().unwrap();
    let rim = edge_at_circle(&pipe);
    assert!(chamfer_variable_reason(&pipe, &[rim], &[], 1.0, 2.0, f64::NAN, f64::NAN).unwrap().contains("closed edge"));
    assert!(chamfer_variable(&part, &[top], &[], 1.0, 6.0, f64::NAN, f64::NAN).unwrap().is_none());
}

fn edge_at_circle(shape: &Shape) -> u32 {
    let topo = topology(shape).unwrap();
    topo["edges"].as_array().unwrap().iter().position(|edge| edge["curve"] == "circle").expect("circle") as u32
}

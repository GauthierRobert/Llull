//! WRP M3: emboss tools (`features::emboss_tools`) fused with, cut from, or splitting a planar face (closed-form volumes).

use crate::features::{emboss_tools, split_shape};
use crate::{boolean, make_box, mass_properties, BooleanOp, Shape};

/// Top face of a 10 mm cube: plane at z = 10 with the x / y axes.
const TOP: [f64; 9] = [0.0, 0.0, 10.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
const PLANE: i32 = 1;
const UP: [f64; 3] = [0.0, 0.0, 1.0];

fn cube() -> Shape {
    make_box([0.0; 3], [10.0, 10.0, 10.0]).unwrap().unwrap()
}

/// One region: the square [2, 6] x [2, 6] in (u, v), four lines, no holes.
fn square() -> Vec<f64> {
    vec![
        1.0, 1.0, 1.0, // one region, one loop, outer
        2.0, 2.0, 4.0, // start, four segments
        0.0, 6.0, 2.0, 0.0, 6.0, 6.0, 0.0, 2.0, 6.0, 0.0, 2.0, 2.0,
    ]
}

fn volume(shape: &Shape) -> f64 {
    mass_properties(shape).unwrap().volume
}

#[test]
fn emboss_adds_and_deboss_removes_the_closed_form_volume() {
    let tools = emboss_tools(PLANE, &TOP, &square(), [0.0, 1.0], UP, 1e-6, false).unwrap().unwrap();
    let embossed = boolean(BooleanOp::Union, &cube(), &tools, true).unwrap().unwrap();
    assert!((volume(&embossed) - 1016.0).abs() < 1e-6);
    let down = emboss_tools(PLANE, &TOP, &square(), [-1.0, 0.0], UP, 1e-6, false).unwrap().unwrap();
    let debossed = boolean(BooleanOp::Subtract, &cube(), &down, true).unwrap().unwrap();
    assert!((volume(&debossed) - 984.0).abs() < 1e-6);
}

#[test]
fn scribe_splits_the_face_and_keeps_the_volume() {
    let faces = emboss_tools(PLANE, &TOP, &square(), [0.0, 1.0], UP, 1e-6, true).unwrap().unwrap();
    let scribed = split_shape(&cube(), &faces).unwrap().unwrap();
    assert!((volume(&scribed) - 1000.0).abs() < 1e-6);
}

#[test]
fn inconsistent_region_data_is_an_error_not_a_crash() {
    assert!(emboss_tools(PLANE, &TOP, &[1.0, 1.0], [0.0, 1.0], UP, 1e-6, false).is_err());
}

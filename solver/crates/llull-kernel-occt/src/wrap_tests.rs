//! WRP M3: emboss tools (`features_surface::emboss_tools`) fused with, cut from, or splitting a planar face (closed-form volumes).

use crate::features_surface::{emboss_tools, pcurve_edge_tools, split_shape};
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

/// Sphere (centre origin, axis z, x direction x) and torus (major 10, minor 3) wires for the doubly curved emboss kinds.
const SPHERE_KIND: i32 = 4;
const TORUS_KIND: i32 = 5;
const SPHERE: [f64; 10] = [0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 10.0];
const TORUS: [f64; 11] = [0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 10.0, 3.0];

/// One region: the rectangle [u0, u1] x [v0, v1] in (u, v), four lines.
fn rectangle(u0: f64, v0: f64, u1: f64, v1: f64) -> Vec<f64> {
    vec![1.0, 1.0, 1.0, u0, v0, 4.0, 0.0, u1, v0, 0.0, u1, v1, 0.0, u0, v1, 0.0, u0, v0]
}

#[test]
fn emboss_and_deboss_on_a_sphere_follow_the_steiner_volume() {
    let sphere = make_sphere_solid();
    let area = 100.0 * 0.6 * 2.0 * 0.2_f64.sin();
    let region = rectangle(-0.3, -0.2, 0.3, 0.2);
    let up = [1.0, 0.0, 0.0];
    let tools = emboss_tools(SPHERE_KIND, &SPHERE, &region, [0.0, 1.0], up, 1e-6, false).unwrap().unwrap();
    let embossed = boolean(BooleanOp::Union, &sphere, &tools, true).unwrap().unwrap();
    let expected = area * (1.0 + 1.0 / 10.0 + 1.0 / 300.0);
    let delta = volume(&embossed) - volume(&sphere);
    assert!((delta / expected - 1.0).abs() < 1e-6, "sphere emboss {delta} vs {expected}");
    let down = emboss_tools(SPHERE_KIND, &SPHERE, &region, [-1.0, 0.0], up, 1e-6, false).unwrap().unwrap();
    let debossed = boolean(BooleanOp::Subtract, &sphere, &down, true).unwrap().unwrap();
    let expected_down = area * (1.0 - 1.0 / 10.0 + 1.0 / 300.0);
    let removed = volume(&sphere) - volume(&debossed);
    assert!((removed / expected_down - 1.0).abs() < 1e-6, "sphere deboss {removed} vs {expected_down}");
}

#[test]
fn emboss_on_a_torus_follows_the_tube_offset_volume() {
    let torus = crate::make_torus(10.0, 3.0).unwrap().unwrap();
    let region = rectangle(0.0, -0.4, 0.5, 0.4);
    let tools = emboss_tools(TORUS_KIND, &TORUS, &region, [0.0, 1.0], [1.0, 0.0, 0.0], 1e-6, false).unwrap().unwrap();
    let embossed = boolean(BooleanOp::Union, &torus, &tools, true).unwrap().unwrap();
    let (major, minor, d) = (10.0_f64, 3.0_f64, 1.0_f64);
    let (du, dv, cos_integral) = (0.5, 0.8, 2.0 * 0.4_f64.sin() * 0.5);
    let expected = du * dv * major * (minor * d + d * d / 2.0) + cos_integral * ((minor + d).powi(3) - minor.powi(3)) / 3.0;
    let delta = volume(&embossed) - volume(&torus);
    assert!((delta / expected - 1.0).abs() < 1e-6, "torus emboss {delta} vs {expected}");
}

#[test]
fn split_by_pcurve_chains_divides_a_sphere_face_and_keeps_the_volume() {
    let sphere = make_sphere_solid();
    // a closed rectangle chain (four lines) scribed on the sphere
    let chain = vec![1.0, -0.3, -0.2, 4.0, 0.0, 0.3, -0.2, 0.0, 0.3, 0.2, 0.0, -0.3, 0.2, 0.0, -0.3, -0.2];
    let tools = pcurve_edge_tools(SPHERE_KIND, &SPHERE, &chain).unwrap().unwrap();
    let split = split_shape(&sphere, &tools).unwrap().unwrap();
    assert!((volume(&split) / volume(&sphere) - 1.0).abs() < 1e-9);
    let faces = crate::queries::topology(&split).unwrap()["faces"].as_array().map_or(0, Vec::len);
    assert!(faces >= 2, "the scribed patch is its own face ({faces} faces)");
    assert!(pcurve_edge_tools(SPHERE_KIND, &SPHERE, &[1.0, 0.0, 0.0]).is_err(), "inconsistent chains are an error");
    assert!(emboss_tools(SPHERE_KIND, &[0.0; 9], &rectangle(0.0, 0.0, 1.0, 1.0), [0.0, 1.0], [1.0, 0.0, 0.0], 1e-6, false).is_err());
}

fn make_sphere_solid() -> Shape {
    crate::make_sphere(10.0).unwrap().unwrap()
}

#[test]
fn split_along_chains_in_the_own_parameters_of_a_face_of_the_source() {
    let sphere = make_sphere_solid();
    let faces = |shape: &Shape| crate::queries::topology(shape).unwrap()["faces"].as_array().map_or(0, Vec::len);
    // a closed rectangle in the native (u, v) of the sphere face
    let chain = vec![1.0, -0.3, -0.2, 4.0, 0.0, 0.3, -0.2, 0.0, 0.3, 0.2, 0.0, -0.3, 0.2, 0.0, -0.3, -0.2];
    let tools = crate::features_surface::face_edge_tools(&sphere, 0, &chain).unwrap().unwrap();
    let split = split_shape(&sphere, &tools).unwrap().unwrap();
    assert!(faces(&split) > faces(&sphere), "{} faces after, {} before", faces(&split), faces(&sphere));
    assert!((volume(&split) / volume(&sphere) - 1.0).abs() < 1e-9);
    assert!(crate::features_surface::face_edge_tools(&sphere, 7, &chain).unwrap().is_none(), "a face index past the end is refused");
    assert!(crate::features_surface::face_edge_tools(&sphere, 0, &[2.0, 0.0]).is_err(), "truncated chains are an error");
}

/// A region a half turn round a cylinder from the first one still lifts outward: the lift side is decided once, not per region against the direction of the first.
#[test]
fn every_region_of_an_emboss_lifts_the_same_side_even_far_from_the_first() {
    let cylinder = crate::make_cylinder(10.0, 20.0).unwrap().unwrap();
    // cylinder surface: origin, axis, xDir, radius; (u, v) = (azimuth, height); squares of 0.2 rad x 2 at azimuth 0 and pi
    let surface = [0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 10.0];
    let region =
        |u0: f64| -> Vec<f64> { vec![1.0, 1.0, u0, 8.0, 4.0, 0.0, u0 + 0.2, 8.0, 0.0, u0 + 0.2, 10.0, 0.0, u0, 10.0, 0.0, u0, 8.0] };
    let mut two = vec![2.0];
    two.extend(region(-0.1));
    two.extend(region(std::f64::consts::PI - 0.1));
    let tools = emboss_tools(2, &surface, &two, [0.0, 0.5], [1.0, 0.0, 0.0], 1e-6, false).unwrap().unwrap();
    let embossed = boolean(BooleanOp::Union, &cylinder, &tools, true).unwrap().unwrap();
    let gained = volume(&embossed) - volume(&cylinder);
    let one = 0.2 * 10.0 * 2.0 * 0.5 * (1.0 + 0.5 / 20.0);
    assert!((gained / (2.0 * one) - 1.0).abs() < 1e-6, "gained {gained}, two regions need {}", 2.0 * one);
}

//! BLD M2 ends: a profile blend on a straight edge that ends on a flat face which is not perpendicular to it (`cpp/blend_profile.cxx`, `end_planes`): the
//! prism runs past the end face and the cut trims it, so the volume is the closed form `A L + (tan a + tan b) M` of the spandrel (area A, first
//! moment M about the edge across the top face) and the circular blend is the same solid as OCCT's own fillet.

use crate::features::{fillet, fillet_profile_blend, profile_blend_reason};
use crate::queries::topology;
use crate::{mass_properties, Shape};
use serde_json::Value;

const NAN: f64 = f64::NAN;
const PI: f64 = std::f64::consts::PI;

fn num(value: &Value) -> f64 {
    value.as_f64().unwrap()
}

fn volume_of(shape: &Shape) -> f64 {
    mass_properties(shape).unwrap().volume
}

fn edges_where(shape: &Shape, keep: impl Fn(&Value) -> bool) -> Vec<u32> {
    let topo = topology(shape).unwrap();
    topo["edges"].as_array().unwrap().iter().enumerate().filter(|(_, edge)| keep(edge)).map(|(index, _)| index as u32).collect()
}

/// A prism of height `height` over the polygon `points` (x, y), drawn in the z = 0 plane.
fn prism(points: &[[f64; 2]], height: f64) -> Shape {
    let mut chain = Vec::new();
    for k in 0..points.len() {
        let (a, b) = (points[k], points[(k + 1) % points.len()]);
        chain.extend([0.0, a[0], a[1], 0.0, b[0], b[1], 0.0]);
    }
    let face = crate::features::chain_face(&chain).unwrap().unwrap();
    crate::features::prism_of_face(&face, [0.0, 0.0, height]).unwrap().unwrap()
}

/// The profile blend of `edges` with one symmetric constant `size`, as the evaluator asks for it (kind 2 = circle, 0 = conic).
fn blend(shape: &Shape, edges: &[u32], size: f64, kind: f64, param: f64) -> Result<Shape, String> {
    let specs: Vec<f64> = edges.iter().flat_map(|edge| [f64::from(*edge), kind, param, size, NAN, -1.0, 0.0]).collect();
    let laws: Vec<f64> = edges.iter().flat_map(|_| [size, NAN, 0.0, 0.0]).collect();
    match fillet_profile_blend(shape, &specs, edges, &laws, kind, param).unwrap() {
        Some(built) => Ok(built),
        None => Err(profile_blend_reason(shape, &specs, edges, &laws, kind, param).unwrap()),
    }
}

/// The top front edge (y = 0, z = height) of a prism whose end walls are vertical.
fn front_edge(shape: &Shape, height: f64) -> Vec<u32> {
    edges_where(shape, |e| (num(&e["mid"][2]) - height).abs() < 1e-9 && num(&e["mid"][1]).abs() < 1e-9)
}

/// Area and first moment about the front face (the u coordinate across the top face) of the spandrel of the circle of radius `r` in a right angle.
fn circle_spandrel(r: f64) -> (f64, f64) {
    (r * r * (1.0 - PI / 4.0), r.powi(3) * (5.0 / 6.0 - PI / 4.0))
}

fn near(a: f64, b: f64, tolerance: f64) -> bool {
    (a - b).abs() <= tolerance * b.abs().max(1.0)
}

#[test]
fn a_circular_blend_on_an_edge_with_oblique_ends_is_the_closed_form_and_the_circular_fillet() {
    let _serial = crate::serial_blends();
    let r = 1.0;
    let (area, moment) = circle_spandrel(r);
    // end walls flaring outward with y (tan = 0.5 each), narrowing inward (tan = 0.5 each), and one of each (a parallelogram: the moments cancel)
    for (points, tangents) in [
        ([[0.0, 0.0], [10.0, 0.0], [13.0, 6.0], [-3.0, 6.0]], 1.0),
        ([[0.0, 0.0], [10.0, 0.0], [7.0, 6.0], [3.0, 6.0]], -1.0),
        ([[0.0, 0.0], [10.0, 0.0], [13.0, 6.0], [3.0, 6.0]], 0.5 - 0.5),
    ] {
        let part = prism(&points, 3.0);
        let edge = front_edge(&part, 3.0);
        assert_eq!(edge.len(), 1);
        let built = blend(&part, &edge, r, 2.0, 0.0).unwrap_or_else(|why| panic!("refused: {why}"));
        let expected_removed = area * 10.0 + tangents * moment;
        let removed = volume_of(&part) - volume_of(&built);
        assert!(near(removed, expected_removed, 1e-9), "removed {removed} expected {expected_removed}");
        let occt = fillet(&part, &edge, r, None).unwrap().unwrap();
        assert!(near(volume_of(&built), volume_of(&occt), 1e-6), "{} vs OCCT {}", volume_of(&built), volume_of(&occt));
    }
}

#[test]
fn a_conic_blend_on_an_edge_with_an_oblique_end_is_the_closed_form() {
    let _serial = crate::serial_blends();
    // parabola (rho 0.5) with legs d in a right angle: spandrel area d^2 / 6, first moment about the front face d^3 / 12 * ... by Green's theorem below
    let d = 2.0;
    let part = prism(&[[0.0, 0.0], [10.0, 0.0], [13.0, 6.0], [-3.0, 6.0]], 3.0);
    let edge = front_edge(&part, 3.0);
    let built = blend(&part, &edge, d, 0.0, 0.5).unwrap_or_else(|why| panic!("refused: {why}"));
    // numeric Green integral over corner -> a (along the top face), parabola, b -> corner; u across the top face, w down the front face
    let n = 200000;
    let mut area = 0.0;
    let mut moment = 0.0;
    let mut previous = (d, 0.0);
    for k in 1..=n {
        let t = f64::from(k) / f64::from(n);
        let point = ((1.0 - t) * (1.0 - t) * d, t * t * d);
        // boundary a -> b: contributes -(u dw - w du) / 2 and the u moment -u^2 dw / 2... signs fixed by the corner -> a -> b orientation
        area += 0.5 * (previous.0 * point.1 - previous.1 * point.0);
        moment += 0.5 * (previous.0 * previous.0 + previous.0 * point.0 + point.0 * point.0) / 3.0 * (point.1 - previous.1);
        previous = point;
    }
    let area = area.abs();
    let moment = moment.abs();
    assert!(near(area, d * d / 6.0, 1e-9));
    let removed = volume_of(&part) - volume_of(&built);
    let expected = area * 10.0 + moment;
    assert!(near(removed, expected, 1e-6), "removed {removed} expected {expected}");
}

/// An L-shaped column sheared by `shift` in x over height 6 (its top and bottom faces stay horizontal, oblique to its slanted edges).
fn sheared_l(shift: f64) -> Shape {
    let points = [[0.0, 0.0], [10.0, 0.0], [10.0, 5.0], [5.0, 5.0], [5.0, 10.0], [0.0, 10.0]];
    let mut chain = Vec::new();
    for k in 0..points.len() {
        let (a, b) = (points[k], points[(k + 1) % points.len()]);
        chain.extend([0.0, a[0], a[1], 0.0, b[0], b[1], 0.0]);
    }
    let face = crate::features::chain_face(&chain).unwrap().unwrap();
    crate::features::prism_of_face(&face, [shift, 0.0, 6.0]).unwrap().unwrap()
}

#[test]
fn a_concave_edge_that_ends_obliquely_is_fused_flush_with_its_end_faces() {
    let _serial = crate::serial_blends();
    let r = 1.0;
    let (area, _) = circle_spandrel(r);
    for shift in [3.0, -3.0] {
        let part = sheared_l(shift);
        let length = (shift * shift + 36.0_f64).sqrt();
        // the reflex vertical edge at (5, 5): it runs from (5, 5, 0) to (5 + shift, 5, 6)
        let edge = edges_where(&part, |e| (num(&e["mid"][1]) - 5.0).abs() < 1e-9 && (num(&e["mid"][0]) - (5.0 + shift / 2.0)).abs() < 1e-9);
        assert_eq!(edge.len(), 1);
        let built = blend(&part, &edge, r, 2.0, 0.0).unwrap_or_else(|why| panic!("refused: {why}"));
        // parallel end faces: the length of the tool is the edge length at every point of the section
        let added = volume_of(&built) - volume_of(&part);
        assert!(near(added, area * length, 1e-9), "added {added} expected {}", area * length);
        let occt = fillet(&part, &edge, r, None).unwrap().unwrap();
        assert!(near(volume_of(&built), volume_of(&occt), 1e-6));
        let faces = |shape: &Shape| topology(shape).unwrap()["faces"].as_array().unwrap().len();
        // one new face (the blend) and the faces of the column: the tool's end caps merge into the end faces
        assert_eq!(faces(&built), faces(&part) + 1, "faces {} vs {}", faces(&built), faces(&part));
    }
}

#[test]
fn what_an_oblique_end_cannot_have_is_named() {
    let _serial = crate::serial_blends();
    // an end face nearly parallel to the edge (about 84 degrees from square: past the 80 a prism can be run across)
    let part = prism(&[[0.0, 0.0], [10.0, 0.0], [70.0, 6.0], [-60.0, 6.0]], 3.0);
    let edge = front_edge(&part, 3.0);
    let specs = [f64::from(edge[0]), 2.0, 0.0, 0.5, NAN, -1.0, 0.0];
    let why = crate::features::profile_reason(&part, &specs).unwrap();
    assert!(why.contains("rad from square to the edge"), "{why}");
    // legs that the end faces cut to nothing: a 2-long wedge with a leg of 3.5 across a 6 wide top
    let short = prism(&[[0.0, 0.0], [2.0, 0.0], [0.0, 6.0]], 3.0);
    let edge = front_edge(&short, 3.0);
    let specs = [f64::from(edge[0]), 2.0, 0.0, 3.5, NAN, -1.0, 0.0];
    let why = crate::features::profile_reason(&short, &specs).unwrap();
    assert!(why.contains("cut the contact lines") || why.contains("reach past"), "{why}");
}

#[test]
fn an_end_face_that_does_not_close_the_corner_or_is_curved_is_refused() {
    let _serial = crate::serial_blends();
    // the front edge ends at a reflex vertex of the outline: the next wall leaves backwards, so the solid is still there past the end plane
    let reflex = prism(&[[0.0, 0.0], [10.0, 0.0], [12.0, -3.0], [20.0, -3.0], [20.0, 6.0], [0.0, 6.0]], 3.0);
    let edge = edges_where(&reflex, |e| {
        (num(&e["mid"][2]) - 3.0).abs() < 1e-9 && num(&e["mid"][1]).abs() < 1e-9 && (num(&e["mid"][0]) - 5.0).abs() < 1e-9
    });
    assert_eq!(edge.len(), 1);
    let specs = [f64::from(edge[0]), 2.0, 0.0, 0.5, NAN, -1.0, 0.0];
    let why = crate::features::profile_reason(&reflex, &specs).unwrap();
    assert!(why.contains("is still inside the solid there"), "{why}");
    // the front edge ends on a cylinder: a curved end face
    let slab = crate::make_box([0.0; 3], [10.0, 6.0, 3.0]).unwrap().unwrap();
    let round = crate::make_cylinder(8.0, 3.0).unwrap().unwrap();
    let part = crate::boolean(crate::BooleanOp::Intersect, &slab, &round, false).unwrap().unwrap();
    let edge = edges_where(&part, |e| (num(&e["mid"][2]) - 3.0).abs() < 1e-9 && num(&e["mid"][1]).abs() < 1e-9);
    assert_eq!(edge.len(), 1);
    let specs = [f64::from(edge[0]), 2.0, 0.0, 0.5, NAN, -1.0, 0.0];
    let why = crate::features::profile_reason(&part, &specs).unwrap();
    assert!(why.contains("is on a curved face"), "{why}");
}

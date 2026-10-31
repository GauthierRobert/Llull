//! BLD §13.36: the G2 corner star of a curvature-profile step (`cpp/blend_corner_exact.cxx`, `cpp/blend_corner.cxx`).

use crate::blend_corner_tests::{cube, num, CornerHooks};
use crate::features::{fillet_profile_blend, profile_blend_reason, shape_notes};
use crate::queries::{edge_continuity, face_graph, topology};
use crate::{analyze, make_box, mass_properties, Shape};
use serde_json::Value;

const NAN: f64 = f64::NAN;

/// Every edge of `shape` blended with `size` and the section `kind` / `param` (1 = curvature, 0 = conic), the corners found automatically.
fn profile_of(shape: &Shape, size: f64, kind: f64, param: f64) -> Result<Shape, String> {
    let count = topology(shape).unwrap()["edges"].as_array().unwrap().len();
    let specs: Vec<f64> = (0..count).flat_map(|edge| [edge as f64, kind, param, size, NAN, -1.0, 0.0]).collect();
    match fillet_profile_blend(shape, &specs, &[], &[], kind, param).unwrap() {
        Some(built) => Ok(built),
        None => Err(profile_blend_reason(shape, &specs, &[], &[], kind, param).unwrap()),
    }
}

fn profile_cube(size: f64, kind: f64, param: f64) -> Shape {
    profile_of(&cube(10.0), size, kind, param).unwrap_or_else(|why| panic!("refused: {why}"))
}

/// What each corner of the step got: the continuity of its star and, when the G2 star was refused, why.
fn corners_of(shape: &Shape) -> Vec<(String, String)> {
    let notes: Value = serde_json::from_str(&shape_notes(shape).unwrap()).unwrap();
    notes["corners"]
        .as_array()
        .unwrap()
        .iter()
        .map(|corner| (corner["continuity"].as_str().unwrap_or("").to_string(), corner["g2Refused"].as_str().unwrap_or("").to_string()))
        .collect()
}

fn all(continuity: &str) -> Vec<(String, String)> {
    vec![(continuity.to_string(), String::new()); 8]
}

/// The worst readings over the interior samples (21 per edge) of the edges that border a corner patch: `spokes` between two sub-patches, `contacts` between a sub-patch and a blend or
/// flat face. Each is (g1 angle in radians, jump of the normal curvature across the edge in 1/length).
struct Readings {
    spokes: (f64, f64),
    contacts: (f64, f64),
}

fn readings(shape: &Shape) -> Readings {
    let topo = topology(shape).unwrap();
    let names: Vec<String> = topo["faces"].as_array().unwrap().iter().map(|f| f["name"].as_str().unwrap_or("").to_string()).collect();
    let graph = face_graph(shape).unwrap();
    let mut worst = Readings { spokes: (0.0, 0.0), contacts: (0.0, 0.0) };
    for (edge, faces) in graph["edgeFaces"].as_array().unwrap().iter().enumerate() {
        let faces: Vec<usize> = faces.as_array().unwrap().iter().map(|f| f.as_u64().unwrap() as usize).collect();
        let patches = faces.iter().filter(|f| names[**f].starts_with("blend(v:")).count();
        if faces.len() != 2 || patches == 0 {
            continue;
        }
        let slot = if patches == 2 { &mut worst.spokes } else { &mut worst.contacts };
        let samples = edge_continuity(shape, edge as f64, 21.0).unwrap();
        let samples = samples.as_array().unwrap();
        for sample in &samples[1..samples.len() - 1] {
            let curvature = &sample["normalCurvature"];
            slot.0 = slot.0.max(num(&sample["g1"]));
            slot.1 = slot.1.max((num(&curvature[0]) - num(&curvature[1])).abs());
        }
    }
    worst
}

fn volume(shape: &Shape) -> f64 {
    mass_properties(shape).unwrap().volume
}

/// The numbers of 13.36.4 (cube 10, size 1, curvature shape 0.5): the G2 star against the G1 star it replaces.
#[test]
fn the_curvature_profile_cube_star_is_g2_to_its_blends_and_g1_across_its_spokes() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let shape = profile_cube(1.0, 1.0, 0.5);
    assert!(analyze(&shape).unwrap().valid);
    assert_eq!(corners_of(&shape), all("G2"));
    assert_eq!(topology(&shape).unwrap()["faces"].as_array().unwrap().len(), 66);
    let g2 = readings(&shape);
    assert!(g2.contacts.1 < 1e-3, "curvature jump at the blend and flat faces {:e}", g2.contacts.1);
    assert!(g2.contacts.0 < 1e-4, "angle at the blend and flat faces {:e}", g2.contacts.0);
    assert!(g2.spokes.0 < 1e-4, "the spokes are G1: {:e}", g2.spokes.0);
    // the spokes are G1 seams (no curvature match across them): stated, not hidden
    assert!(g2.spokes.1 > 0.1, "{:e}", g2.spokes.1);
    crate::test_bridge::set_corner_g2_star(false);
    let g1_shape = profile_cube(1.0, 1.0, 0.5);
    assert_eq!(corners_of(&g1_shape), all("G1"));
    let g1 = readings(&g1_shape);
    assert!(g1.contacts.1 > 0.5, "the G1 star jumps by {:e}", g1.contacts.1);
    assert!((volume(&shape) - volume(&g1_shape)).abs() < 1e-3 * volume(&g1_shape), "{} against {}", volume(&shape), volume(&g1_shape));
}

#[test]
fn unequal_sizes_other_shape_factors_and_a_larger_blend_stay_g2() {
    let _serial = crate::serial_blends();
    let uneven = make_box([0.0; 3], [10.0, 7.0, 5.0]).unwrap().unwrap();
    let count = topology(&uneven).unwrap()["edges"].as_array().unwrap().len();
    let specs: Vec<f64> = (0..count).flat_map(|edge| [edge as f64, 1.0, 0.5, 0.8 + 0.1 * (edge % 4) as f64, NAN, -1.0, 0.0]).collect();
    let built = fillet_profile_blend(&uneven, &specs, &[], &[], 1.0, 0.5).unwrap().expect("a box with sizes 0.8 to 1.1");
    for (label, shape) in [
        ("sizes 0.8 to 1.1 on a 10 x 7 x 5 box", built),
        ("shape 0.3", profile_cube(1.0, 1.0, 0.3)),
        ("shape 0.8", profile_cube(1.0, 1.0, 0.8)),
        ("size 2.4", profile_cube(2.4, 1.0, 0.5)),
    ] {
        assert_eq!(corners_of(&shape), all("G2"), "{label}");
        let measured = readings(&shape);
        assert!(measured.contacts.1 < 1e-3 && measured.spokes.0 < 1e-4, "{label}: {:e} {:e}", measured.contacts.1, measured.spokes.0);
    }
}

#[test]
fn the_g1_star_stays_for_a_conic_profile_and_is_not_tried_for_g2() {
    let _serial = crate::serial_blends();
    let shape = profile_cube(1.0, 0.0, 0.5);
    // not tried: no g2Refused reason either (a conic section ends with a curvature the plane does not have)
    assert_eq!(corners_of(&shape), all("G1"));
    assert!(readings(&shape).contacts.1 > 0.5);
}

#[test]
fn a_g2_star_that_cannot_meet_the_gates_is_refused_by_name_and_the_g1_star_is_built() {
    let _serial = crate::serial_blends();
    // shape factor 0.05 puts the section's curvature in a spike at its ends: no pole count meets the gates (measured: a sub-patch turns round at 64 poles)
    let shape = profile_cube(1.0, 1.0, 0.05);
    assert!(analyze(&shape).unwrap().valid);
    let corners = corners_of(&shape);
    assert_eq!(corners.len(), 8);
    for (continuity, why) in &corners {
        assert_eq!(continuity, "G1");
        assert!(why.contains("the curvature of the supports by"), "{why}");
    }
    assert!(readings(&shape).contacts.0 < 0.0095);
}

#[test]
fn the_g2_star_gives_the_same_solid_on_any_number_of_threads() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let mut reference = None;
    for threads in [1, 8, 2] {
        crate::test_bridge::set_corner_threads(threads);
        let shape = profile_cube(1.0, 1.0, 0.5);
        let fingerprint = (volume(&shape).to_bits(), topology(&shape).unwrap()["faces"].as_array().unwrap().len());
        assert_eq!(*reference.get_or_insert(fingerprint), fingerprint, "{threads} threads");
    }
}

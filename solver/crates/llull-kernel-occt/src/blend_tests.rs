//! BLD M0: OCCT fillet diagnostics (`queries::fillet_report`) and the native edge queries (`edge_samples`, `edge_continuity`).

use crate::queries::{edge_continuity, edge_samples, fillet_report, topology};
use crate::{make_box, make_cylinder, make_sewn_solid, Shape};
use serde_json::Value;

const NAN: f64 = f64::NAN;

fn cube(size: f64) -> Shape {
    make_box([0.0; 3], [size, size, size]).unwrap().unwrap()
}

fn f(value: &Value) -> f64 {
    value.as_f64().unwrap()
}

#[test]
fn a_building_fillet_reports_ok_contours() {
    let report = fillet_report(&cube(10.0), &[0], &[1.0, NAN, 0.0]).unwrap();
    assert_eq!(report["stage"], "none");
    assert_eq!(report["done"], true);
    assert_eq!(report["valid"], true);
    assert_eq!(report["contours"][0]["status"], "ok");
    assert_eq!(report["contours"][0]["edges"], serde_json::json!([0]));
    assert_eq!(report["unsupportedVertices"].as_array().unwrap().len(), 0);
}

#[test]
fn a_radius_too_large_is_a_coded_contour_or_corner_failure() {
    // all 12 edges of a 4 mm cube at r 3 cannot build (two fillets of one face would overlap)
    let report = fillet_report(&cube(4.0), &[], &[3.0, NAN, 0.0]).unwrap();
    assert_ne!(report["stage"], "none");
    assert_eq!(report["partial"].is_boolean(), true);
    let single = fillet_report(&cube(4.0), &[0], &[9.0, NAN, 0.0]).unwrap();
    assert_ne!(single["stage"], "none");
    assert!(
        single["contours"].as_array().unwrap().iter().any(|contour| contour["status"] != "ok") || single["vertices"].as_array().is_some()
    );
}

#[test]
fn bad_edges_and_non_fillet_inputs_are_reported() {
    let out_of_range = fillet_report(&cube(4.0), &[99], &[1.0, NAN, 0.0]).unwrap();
    assert_eq!(out_of_range["stage"], "contours");
    assert!(out_of_range["message"].as_str().unwrap().contains("out of range"));
}

fn pyramid() -> Shape {
    let apex = [5.0, 5.0, 10.0];
    let corners = [[0.0, 0.0, 0.0], [10.0, 0.0, 0.0], [10.0, 10.0, 0.0], [0.0, 10.0, 0.0]];
    let mut positions = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let mut push = |a: [f64; 3], b: [f64; 3], c: [f64; 3]| {
        let base = (positions.len() / 3) as u32;
        for p in [a, b, c] {
            positions.extend(p);
        }
        indices.extend([base, base + 1, base + 2]);
    };
    for i in 0..4 {
        push(corners[i], corners[(i + 1) % 4], apex);
    }
    push(corners[0], corners[2], corners[1]);
    push(corners[0], corners[3], corners[2]);
    make_sewn_solid(&positions, &indices).unwrap().unwrap()
}

#[test]
fn a_four_edge_apex_is_listed_and_the_other_failures_keep_their_vertex() {
    let shape = pyramid();
    let topo = topology(&shape).unwrap();
    let edges = topo["edges"].as_array().unwrap();
    let lateral: Vec<u32> = edges
        .iter()
        .enumerate()
        .filter(|(_, edge)| f(&edge["start"][2]) > 9.0 || f(&edge["end"][2]) > 9.0)
        .map(|(index, _)| index as u32)
        .collect();
    assert_eq!(lateral.len(), 4);
    let report = fillet_report(&shape, &lateral, &[0.5, NAN, 0.0].repeat(4)).unwrap();
    let crowded = report["unsupportedVertices"].as_array().unwrap();
    let apex = crowded.iter().find(|vertex| (f(&vertex["point"][2]) - 10.0).abs() < 1e-9).expect("the apex is listed");
    assert_eq!(apex["edgeCount"], 4);
    assert_eq!(apex["selectedEdgeCount"], 4);
    assert_eq!(crowded.iter().filter(|vertex| vertex["point"] == apex["point"]).count(), 1, "each vertex once");
}

#[test]
fn edge_samples_follow_the_curve_frame() {
    let rim = make_cylinder(5.0, 10.0).unwrap().unwrap();
    let topo = topology(&rim).unwrap();
    let circle = topo["edges"].as_array().unwrap().iter().position(|edge| edge["curve"] == "circle").unwrap();
    let samples = edge_samples(&rim, circle as f64, 5.0).unwrap();
    let list = samples.as_array().unwrap();
    assert_eq!(list.len(), 5);
    assert!((f(&list[2]["curvature"]) - 0.2).abs() < 1e-9, "curvature 1/R: {}", list[2]["curvature"]);
    assert!(f(&list[2]["torsion"]).abs() < 1e-9);
    assert!((f(&list[4]["s"]) - 2.0 * std::f64::consts::PI * 5.0).abs() < 1e-6, "arc length at the end");
    assert!(f(&list[1]["dCurvatureDs"]).abs() < 1e-9);
    let straight = edge_samples(&cube(2.0), 0.0, 3.0).unwrap();
    assert_eq!(f(&straight[1]["curvature"]), 0.0);
    assert!((f(&straight[1]["s"]) - 1.0).abs() < 1e-12);
    assert_eq!(edge_samples(&rim, 99.0, 5.0).unwrap(), Value::Null, "unknown edge");
    assert_eq!(edge_samples(&rim, circle as f64, 1.0).unwrap(), Value::Null, "count below 2");
    assert_eq!(edge_samples(&rim, -1.0, 5.0).unwrap(), Value::Null);
}

#[test]
fn edge_continuity_tells_a_sharp_edge_from_a_fillet_contact() {
    let rounded = crate::features::fillet(&cube(10.0), &[0], 2.0, None).unwrap().unwrap();
    let edge_count = topology(&rounded).unwrap()["edges"].as_array().unwrap().len();
    let (mut sharp, mut tangent) = (0, 0);
    for edge in 0..edge_count {
        let Some(samples) = edge_continuity(&rounded, edge as f64, 4.0).unwrap().as_array().cloned() else { continue };
        assert_eq!(samples.len(), 4);
        let sample = &samples[1];
        assert!(f(&sample["g0"]) < 1e-6, "faces meet at the edge");
        if f(&sample["g1"]) < 1e-6 {
            tangent += 1;
            let kappa = sample["normalCurvature"].as_array().unwrap();
            let gap = (f(&kappa[0]) - f(&kappa[1])).abs();
            assert!((gap - 0.5).abs() < 1e-6, "curvature jump 1/r = 0.5: {sample}");
        } else if (f(&sample["g1"]) - std::f64::consts::FRAC_PI_2).abs() < 1e-6 {
            sharp += 1;
        }
    }
    assert_eq!(tangent, 2, "two contact lines");
    assert!(sharp >= 8, "the untouched box edges are right angles: {sharp}");
    let plain = cube(10.0);
    let first = edge_continuity(&plain, 0.0, 2.0).unwrap();
    assert!((f(&first[0]["g1"]) - std::f64::consts::FRAC_PI_2).abs() < 1e-9);
    assert_eq!(edge_continuity(&plain, 99.0, 2.0).unwrap(), Value::Null);
    let cylinder = make_cylinder(1.0, 2.0).unwrap().unwrap();
    let seam = topology(&cylinder).unwrap()["edges"].as_array().unwrap().iter().position(|edge| edge["seam"] == true).unwrap();
    assert_eq!(edge_continuity(&cylinder, seam as f64, 3.0).unwrap(), Value::Null, "a seam has one face");
}

fn mesh_volume(shape: &Shape, deflection: f64) -> f64 {
    let mesh = crate::tessellate(shape, deflection, 0.05).unwrap();
    let p = |i: u32| -> [f64; 3] {
        let k = 3 * i as usize;
        [mesh.positions[k], mesh.positions[k + 1], mesh.positions[k + 2]]
    };
    mesh.indices
        .chunks_exact(3)
        .map(|t| {
            let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
            (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0
        })
        .sum::<f64>()
}

/// VC-BLD-30 (M0): the linear law of `Add(r1, r2, E)` removes slightly MORE than the normal-section construction; the Gauss-rule volume of the
/// B-spline blend face agrees with a fine mesh, so the difference is the construction, not the integration.
#[test]
fn the_variable_radius_volume_is_confirmed_by_a_fine_mesh() {
    let block = make_box([0.0; 3], [20.0, 10.0, 5.0]).unwrap().unwrap();
    let topo = topology(&block).unwrap();
    let at = |edge: &Value, key: &str, axis: usize, value: f64| (f(&edge[key][axis]) - value).abs() < 1e-9;
    let top = topo["edges"]
        .as_array()
        .unwrap()
        .iter()
        .position(|e| ["start", "end"].iter().all(|key| at(e, key, 2, 5.0) && at(e, key, 1, 10.0)))
        .unwrap() as u32;
    for (end, section) in [(2.0, 989.985247625), (3.0, 981.401174161)] {
        let shape = crate::features::fillet(&block, &[top], 1.0, Some(end)).unwrap().unwrap();
        let exact = crate::mass_properties(&shape).unwrap().volume;
        let fine = mesh_volume(&shape, 1e-4);
        assert!((exact - fine).abs() < 1e-5 * exact, "gprops {exact} vs fine mesh {fine}");
        assert!(exact < section - 0.05, "r 1 -> {end}: {exact} is below the section value {section}");
    }
}

#[test]
fn a_seam_edge_in_the_selection_is_skipped_and_the_report_still_comes_back() {
    let cylinder = make_cylinder(5.0, 10.0).unwrap().unwrap();
    let topo = topology(&cylinder).unwrap();
    let edges: Vec<u32> = (0..topo["edges"].as_array().unwrap().len() as u32).collect();
    let laws = [1.0, NAN, 0.0].repeat(edges.len());
    let report = fillet_report(&cylinder, &edges, &laws).unwrap();
    assert!(report["contours"].is_array(), "a report, not an OCCT failure: {report}");
}

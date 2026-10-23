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
    let _serial = crate::serial_blends();
    let report = fillet_report(&cube(10.0), &[0], &[1.0, NAN, 0.0, 0.0]).unwrap();
    assert_eq!(report["stage"], "none");
    assert_eq!(report["done"], true);
    assert_eq!(report["valid"], true);
    assert_eq!(report["contours"][0]["status"], "ok");
    assert_eq!(report["contours"][0]["edges"], serde_json::json!([0]));
    assert_eq!(report["unsupportedVertices"].as_array().unwrap().len(), 0);
}

#[test]
fn a_radius_too_large_is_a_coded_contour_or_corner_failure() {
    let _serial = crate::serial_blends();
    // all 12 edges of a 4 mm cube at r 3 cannot build (two fillets of one face would overlap)
    let report = fillet_report(&cube(4.0), &[], &[3.0, NAN, 0.0, 0.0]).unwrap();
    assert_ne!(report["stage"], "none");
    assert!(report["partial"].is_boolean());
    let single = fillet_report(&cube(4.0), &[0], &[9.0, NAN, 0.0, 0.0]).unwrap();
    assert_ne!(single["stage"], "none");
    assert!(
        single["contours"].as_array().unwrap().iter().any(|contour| contour["status"] != "ok") || single["vertices"].as_array().is_some()
    );
}

#[test]
fn bad_edges_and_non_fillet_inputs_are_reported() {
    let _serial = crate::serial_blends();
    let out_of_range = fillet_report(&cube(4.0), &[99], &[1.0, NAN, 0.0, 0.0]).unwrap();
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
    let _serial = crate::serial_blends();
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
    let report = fillet_report(&shape, &lateral, &[0.5, NAN, 0.0, 0.0].repeat(4)).unwrap();
    let crowded = report["unsupportedVertices"].as_array().unwrap();
    let apex = crowded.iter().find(|vertex| (f(&vertex["point"][2]) - 10.0).abs() < 1e-9).expect("the apex is listed");
    assert_eq!(apex["edgeCount"], 4);
    assert_eq!(apex["selectedEdgeCount"], 4);
    assert_eq!(crowded.iter().filter(|vertex| vertex["point"] == apex["point"]).count(), 1, "each vertex once");
}

#[test]
fn edge_samples_follow_the_curve_frame() {
    let _serial = crate::serial_blends();
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
    let _serial = crate::serial_blends();
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
    let _serial = crate::serial_blends();
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
    let _serial = crate::serial_blends();
    let cylinder = make_cylinder(5.0, 10.0).unwrap().unwrap();
    let topo = topology(&cylinder).unwrap();
    let edges: Vec<u32> = (0..topo["edges"].as_array().unwrap().len() as u32).collect();
    let laws = [1.0, NAN, 0.0, 0.0].repeat(edges.len());
    let report = fillet_report(&cylinder, &edges, &laws).unwrap();
    assert!(report["contours"].is_array(), "a report, not an OCCT failure: {report}");
}

#[test]
fn a_linear_law_through_a_control_point_builds_and_removes_the_straight_piece_volume() {
    let _serial = crate::serial_blends();
    // 20 x 10 x 5 block, top edge (the edge along x at y = 5, z = 2.5): r 1 -> 2 (t 0.5) -> 1 with straight pieces.
    let block = make_box([-10.0, -5.0, -2.5], [20.0, 10.0, 5.0]).unwrap().unwrap();
    let topo = topology(&block).unwrap();
    let edge = topo["edges"]
        .as_array()
        .unwrap()
        .iter()
        .position(|e| {
            let (s, t) = (&e["start"], &e["end"]);
            (f(&s[1]) - 5.0).abs() < 1e-9 && (f(&s[2]) - 2.5).abs() < 1e-9 && (f(&t[1]) - 5.0).abs() < 1e-9 && (f(&t[2]) - 2.5).abs() < 1e-9
        })
        .unwrap() as u32;
    let linear = crate::features::fillet_laws(&block, &[edge], &[1.0, 1.0, 1.0, 1.0, 0.5, 2.0]).unwrap().unwrap();
    let smooth = crate::features::fillet_laws(&block, &[edge], &[1.0, 1.0, 0.0, 1.0, 0.5, 2.0]).unwrap().unwrap();
    let volume = |shape: &Shape| crate::mass_properties(shape).unwrap().volume;
    // Cavalieri: removed = int A(r(s)) ds with A = r^2 (1 - pi/4) at 90 degrees; r is piecewise linear 1 -> 2 -> 1 over the 20 mm.
    let removed = 2.0 * 10.0 * (1.0 - std::f64::consts::FRAC_PI_4) * (7.0 / 3.0);
    assert!((1000.0 - volume(&linear) - removed).abs() < 0.05, "linear law removes {} vs {removed}", 1000.0 - volume(&linear));
    assert!((volume(&linear) - volume(&smooth)).abs() > 1e-6, "the two interpolations differ");
}

#[test]
fn a_sided_chamfer_removes_the_asymmetric_triangle() {
    let _serial = crate::serial_blends();
    let cube = cube(10.0);
    let graph = crate::queries::face_graph(&cube).unwrap();
    let faces = graph["edgeFaces"][0].as_array().unwrap();
    let face = faces[0].as_u64().unwrap() as u32;
    let volume = |shape: &Shape| crate::mass_properties(shape).unwrap().volume;
    let distances = crate::features::chamfer_sided(&cube, &[0], &[face], 1.0, 2.0, false).unwrap().unwrap();
    assert!((volume(&distances) - 990.0).abs() < 1e-6, "1 x 2 on a 10 mm edge removes 10: {}", volume(&distances));
    let angle = crate::features::chamfer_sided(&cube, &[0], &[face], 1.0, 30f64.to_radians(), true).unwrap().unwrap();
    assert!((volume(&angle) - 997.113248654).abs() < 1e-6, "1 at 30 degrees: {}", volume(&angle));
    assert!(crate::features::chamfer_sided(&cube, &[0], &[99], 1.0, 2.0, false).unwrap().is_none(), "a face index out of range is refused");
    assert!(crate::features::chamfer_sided(&cube, &[0, 1], &[face], 1.0, 2.0, false).unwrap().is_none(), "one face per edge");
}

#[test]
fn blend_sections_read_the_radius_of_a_constant_fillet_and_refuse_a_foreign_edge() {
    let _serial = crate::serial_blends();
    let rounded = crate::features::fillet(&cube(10.0), &[0], 2.0, None).unwrap().unwrap();
    let topo = topology(&rounded).unwrap();
    let blend = topo["faces"].as_array().unwrap().iter().position(|face| face["surface"] == "cylinder").unwrap();
    let graph = crate::queries::face_graph(&rounded).unwrap();
    let count = topo["edges"].as_array().unwrap().len();
    let contacts: Vec<usize> = (0..count)
        .filter(|&edge| {
            let around = graph["edgeFaces"][edge].as_array().unwrap();
            around.iter().any(|face| face.as_u64() == Some(blend as u64))
                && edge_continuity(&rounded, edge as f64, 2.0).unwrap().as_array().is_some_and(|samples| f(&samples[0]["g1"]) < 1e-6)
        })
        .collect();
    assert_eq!(contacts.len(), 2, "two tangent contact edges");
    let sections = crate::queries::blend_sections(&rounded, blend as f64, contacts[0] as f64, contacts[1] as f64, 5.0).unwrap();
    let list = sections.as_array().unwrap();
    assert_eq!(list.len(), 5);
    for section in list {
        assert!((f(&section["radius"]) - 2.0).abs() < 1e-9, "radius 2: {section}");
    }
    assert_eq!(f(&list[0]["t"]), 0.0);
    assert_eq!(f(&list[4]["t"]), 1.0);
    let foreign = (0..count)
        .find(|edge| {
            !contacts.contains(edge)
                && !graph["edgeFaces"][*edge].as_array().unwrap().iter().any(|face| face.as_u64() == Some(blend as u64))
        })
        .unwrap();
    assert_eq!(crate::queries::blend_sections(&rounded, blend as f64, contacts[0] as f64, foreign as f64, 5.0).unwrap(), Value::Null);
    assert_eq!(crate::queries::blend_sections(&rounded, 99.0, 0.0, 1.0, 5.0).unwrap(), Value::Null);
    assert_eq!(crate::queries::blend_sections(&rounded, blend as f64, contacts[0] as f64, contacts[1] as f64, 1.0).unwrap(), Value::Null);
}

fn block_with_top_edge() -> (Shape, u32, u32) {
    let block = make_box([-10.0, -5.0, -2.5], [20.0, 10.0, 5.0]).unwrap().unwrap();
    let topo = topology(&block).unwrap();
    let edge = topo["edges"]
        .as_array()
        .unwrap()
        .iter()
        .position(|e| {
            (f(&e["start"][1]) - 5.0).abs() < 1e-9
                && (f(&e["start"][2]) - 2.5).abs() < 1e-9
                && (f(&e["end"][1]) - 5.0).abs() < 1e-9
                && (f(&e["end"][2]) - 2.5).abs() < 1e-9
        })
        .unwrap() as u32;
    let top =
        topo["faces"].as_array().unwrap().iter().position(|face| face["normal"].as_array().is_some_and(|n| f(&n[2]) > 0.9)).unwrap() as u32;
    (block, edge, top)
}

fn volume_of(shape: &Shape) -> f64 {
    crate::mass_properties(shape).unwrap().volume
}

#[test]
fn profile_blends_remove_the_analytic_spandrel_volume() {
    let _serial = crate::serial_blends();
    let (block, edge, top) = block_with_top_edge();
    let e = f64::from(edge);
    let cases: [(f64, [f64; 7], f64); 6] = [
        (993.646111101, [e, 0.0, 0.25, 1.0, NAN, -1.0, 0.0], 1e-3),
        (995.707963268, [e, 0.0, 2f64.sqrt() - 1.0, 1.0, NAN, -1.0, 0.0], 1e-3),
        (996.666666667, [e, 0.0, 0.5, 1.0, NAN, -1.0, 0.0], 1e-3),
        (998.912905349, [e, 0.0, 0.75, 1.0, NAN, -1.0, 0.0], 1e-3),
        (998.0, [e, 1.0, 0.5, 1.0, NAN, -1.0, 0.0], 1e-3),
        (991.415926536, [e, 2.0, 0.0, 1.0, 2.0, f64::from(top), 0.0], 1e-3),
    ];
    for (expected, spec, tolerance) in cases {
        let built = crate::features::fillet_profile(&block, &spec).unwrap();
        let shape = built.unwrap_or_else(|| panic!("{spec:?}: {}", crate::features::profile_reason(&block, &spec).unwrap()));
        assert!((volume_of(&shape) - expected).abs() < tolerance, "{spec:?}: {} vs {expected}", volume_of(&shape));
    }
}

fn prism_of(points: &[[f64; 2]], depth: f64) -> Shape {
    let mut chain = Vec::new();
    for k in 0..points.len() {
        let (a, b) = (points[k], points[(k + 1) % points.len()]);
        chain.extend([0.0, a[0], a[1], 0.0, b[0], b[1], 0.0]);
    }
    let face = crate::features::chain_face(&chain).unwrap().unwrap();
    crate::features::prism_of_face(&face, [0.0, 0.0, depth]).unwrap().unwrap()
}

fn face_with_normal(shape: &Shape, normal: [f64; 3]) -> u32 {
    let topo = topology(shape).unwrap();
    topo["faces"]
        .as_array()
        .unwrap()
        .iter()
        .position(|face| face["normal"].as_array().is_some_and(|n| (0..3).all(|k| (f(&n[k]) - normal[k]).abs() < 1e-9)))
        .unwrap() as u32
}

#[test]
fn a_face_blend_across_a_chamfer_consumes_it_and_refuses_a_radius_that_leaves_the_material() {
    let _serial = crate::serial_blends();
    let chamfered = prism_of(&[[-5.0, -5.0], [5.0, -5.0], [5.0, 4.0], [4.0, 5.0], [-5.0, 5.0]], 10.0);
    let (a, b) = (face_with_normal(&chamfered, [1.0, 0.0, 0.0]), face_with_normal(&chamfered, [0.0, 1.0, 0.0]));
    let spec = |radius: f64| [f64::from(a), f64::from(b), radius, 2.0, 0.0];
    let built = crate::features::face_blend(&chamfered, &spec(2.0)).unwrap().expect("r 2 builds");
    assert!((volume_of(&built) - 991.415926536).abs() < 1e-3, "r 2: {}", volume_of(&built));
    let faces_before = topology(&chamfered).unwrap()["faces"].as_array().unwrap().len();
    assert_eq!(
        topology(&built).unwrap()["faces"].as_array().unwrap().len(),
        faces_before,
        "the chamfer face is replaced by the blend face"
    );
    assert!(crate::features::face_blend(&chamfered, &spec(1.5)).unwrap().is_none());
    let reason = crate::features::face_blend_reason(&chamfered, &spec(1.5)).unwrap();
    assert!(reason.starts_with("[BLD_FACE_FILLET_NO_SOLUTION]"), "{reason}");
    assert!(reason.contains("1.70"), "the smallest radius is c / (2 - sqrt 2) = 1.7071: {reason}");
    assert_eq!(crate::features::face_blend_reason(&chamfered, &spec(2.0)).unwrap(), "");
    let same = crate::features::face_blend_reason(&chamfered, &[f64::from(a), f64::from(a), 1.0, 2.0, 0.0]).unwrap();
    assert!(same.starts_with("[BLD_FACESETS_OVERLAP]"), "{same}");
    assert!(crate::features::face_blend_reason(&chamfered, &[99.0, f64::from(b), 1.0, 2.0, 0.0]).unwrap().contains("out of range"));
    let big = crate::features::face_blend_reason(&chamfered, &spec(30.0)).unwrap();
    assert!(big.starts_with("[BLD_FACE_FILLET_NO_SOLUTION]"), "{big}");
}

#[test]
fn a_full_round_replaces_the_top_of_a_rib_by_a_half_cylinder() {
    let _serial = crate::serial_blends();
    let rib = prism_of(&[[-2.0, 0.0], [2.0, 0.0], [2.0, 10.0], [-2.0, 10.0]], 20.0);
    let (left, top, right) =
        (face_with_normal(&rib, [-1.0, 0.0, 0.0]), face_with_normal(&rib, [0.0, 1.0, 0.0]), face_with_normal(&rib, [1.0, 0.0, 0.0]));
    let spec = [f64::from(left), f64::from(top), f64::from(right)];
    let built = crate::features::full_round(&rib, &spec).unwrap().expect("full round builds");
    assert!((volume_of(&built) - 765.663706144).abs() < 1e-3, "{}", volume_of(&built));
    let topo = topology(&built).unwrap();
    let cylinders = topo["faces"].as_array().unwrap().iter().filter(|face| face["surface"] == "cylinder").count();
    assert_eq!(cylinders, 1, "one half-cylinder replaces the top");
    let swapped = crate::features::full_round_reason(&rib, &[f64::from(right), f64::from(top), f64::from(left)]).unwrap();
    assert_eq!(swapped, "", "side order does not matter");
    let inward = crate::features::full_round_reason(&rib, &[f64::from(left), f64::from(top), f64::from(top)]).unwrap();
    assert!(inward.starts_with("[BLD_FACESETS_OVERLAP]"), "{inward}");
    let not_opposed = crate::features::full_round_reason(&rib, &[f64::from(left), f64::from(right), f64::from(top)]).unwrap();
    assert!(not_opposed.starts_with("[BLD_FULL_ROUND_NOT_OPPOSED]"), "{not_opposed}");
}

fn face_at(shape: &Shape, normal: [f64; 3], near: [f64; 3]) -> u32 {
    let details = crate::queries::face_details(shape, 1).unwrap();
    let topo = topology(shape).unwrap();
    let mut best: Option<(u32, f64)> = None;
    for (k, face) in topo["faces"].as_array().unwrap().iter().enumerate() {
        let Some(n) = face["normal"].as_array() else { continue };
        if !(0..3).all(|i| (f(&n[i]) - normal[i]).abs() < 1e-9) {
            continue;
        }
        let c = &details[k]["centroid"];
        let d = (0..3).map(|i| (f(&c[i]) - near[i]).powi(2)).sum::<f64>();
        if best.is_none_or(|(_, b)| d < b) {
            best = Some((k as u32, d));
        }
    }
    best.expect("a face with that normal").0
}

#[test]
fn a_hold_line_radius_puts_the_contact_on_the_line_at_a_non_right_angle() {
    let _serial = crate::serial_blends();
    // Block 20x10x5 chamfered 2 x 2 on its top +y edge: the top face meets the chamfer face at a 45 degree fold. A ball of radius r touches the
    // top plane r tan(fold / 2) from the edge, so for a contact 1 mm from the edge r = 1 / tan(22.5 degrees) = 2.414214.
    let block = make_box([-10.0, -5.0, -2.5], [20.0, 10.0, 5.0]).unwrap().unwrap();
    let top_edge = {
        let topo = topology(&block).unwrap();
        topo["edges"]
            .as_array()
            .unwrap()
            .iter()
            .position(|e| {
                (f(&e["start"][1]) - 5.0).abs() < 1e-9
                    && (f(&e["start"][2]) - 2.5).abs() < 1e-9
                    && (f(&e["end"][1]) - 5.0).abs() < 1e-9
                    && (f(&e["end"][2]) - 2.5).abs() < 1e-9
            })
            .unwrap() as u32
    };
    let chamfered = crate::features::chamfer(&block, &[top_edge], 2.0).unwrap().unwrap();
    let top = face_at(&chamfered, [0.0, 0.0, 1.0], [0.0, 0.0, 2.5]);
    let slant = {
        let topo = topology(&chamfered).unwrap();
        topo["faces"]
            .as_array()
            .unwrap()
            .iter()
            .position(|face| face["normal"].as_array().is_some_and(|n| f(&n[1]).abs() > 0.5 && f(&n[2]).abs() > 0.5))
            .unwrap() as u32
    };
    let radius = 1.0 / (std::f64::consts::FRAC_PI_8).tan();
    let spec = [f64::from(top), f64::from(slant), radius, 2.0, 0.0];
    let built = crate::features::face_blend(&chamfered, &spec)
        .unwrap()
        .unwrap_or_else(|| panic!("{}", crate::features::face_blend_reason(&chamfered, &spec).unwrap()));
    // the top face now ends 1 mm from the chamfer edge (y = 3): area 20 x (8 - 1)... the top spans y -5 .. 3 before, y -5 .. 2 after
    let topo = topology(&built).unwrap();
    let area = |name: [f64; 3]| {
        let k = face_at(&built, name, [0.0, 0.0, 2.5]) as usize;
        f(&topo["faces"][k]["area"])
    };
    assert!((area([0.0, 0.0, 1.0]) - 20.0 * 7.0).abs() < 1e-6, "contact 1 mm from the edge: {}", area([0.0, 0.0, 1.0]));
}

#[test]
fn a_concave_blend_whose_arc_lies_in_the_material_has_no_solution() {
    let _serial = crate::serial_blends();
    // L-shaped extrusion whose inner corner (4, 4) is filled by a chamfer-like triangle of material: the air spandrel of a small radius is partly material.
    let filled = prism_of(&[[0.0, 0.0], [10.0, 0.0], [10.0, 4.0], [5.0, 4.0], [4.0, 5.0], [4.0, 10.0], [0.0, 10.0]], 10.0);
    let floor = face_at(&filled, [0.0, 1.0, 0.0], [7.5, 4.0, 5.0]);
    let wall = face_at(&filled, [1.0, 0.0, 0.0], [4.0, 7.5, 5.0]);
    let spec = |radius: f64| [f64::from(floor), f64::from(wall), radius, 2.0, 0.0];
    let reason = crate::features::face_blend_reason(&filled, &spec(1.2)).unwrap();
    assert!(reason.starts_with("[BLD_FACE_FILLET_NO_SOLUTION]"), "{reason}");
    assert!(reason.contains("1.70"), "the smallest radius is c / (2 - sqrt 2) = 1.7071: {reason}");
    let built = crate::features::face_blend(&filled, &spec(2.0)).unwrap().expect("r 2 builds");
    assert!(volume_of(&built) > volume_of(&filled), "a concave blend adds material");
}

#[test]
fn a_full_round_needs_sides_that_reach_down_to_the_axis() {
    let _serial = crate::serial_blends();
    let low = prism_of(&[[-2.0, 0.0], [2.0, 0.0], [2.0, 1.0], [-2.0, 1.0]], 20.0);
    let (left, top, right) =
        (face_with_normal(&low, [-1.0, 0.0, 0.0]), face_with_normal(&low, [0.0, 1.0, 0.0]), face_with_normal(&low, [1.0, 0.0, 0.0]));
    let reason = crate::features::full_round_reason(&low, &[f64::from(left), f64::from(top), f64::from(right)]).unwrap();
    assert!(reason.starts_with("[BLD_FULL_ROUND_NO_SOLUTION]"), "{reason}");
    assert!(reason.contains("reach down"), "{reason}");
    assert!(crate::features::full_round(&low, &[f64::from(left), f64::from(top), f64::from(right)]).unwrap().is_none());
}

#[test]
fn a_sided_chamfer_is_refused_for_a_face_that_does_not_bound_the_edge_and_for_a_seam_edge() {
    let _serial = crate::serial_blends();
    let cube = cube(10.0);
    let graph = crate::queries::face_graph(&cube).unwrap();
    let around: Vec<u64> = graph["edgeFaces"][0].as_array().unwrap().iter().map(|face| face.as_u64().unwrap()).collect();
    let foreign = (0..6u64).find(|face| !around.contains(face)).unwrap() as u32;
    assert!(
        crate::features::chamfer_sided(&cube, &[0], &[foreign], 1.0, 2.0, false).unwrap().is_none(),
        "first leg on a face the edge does not touch"
    );
    assert!(crate::features::chamfer_sided(&cube, &[0], &[foreign], 1.0, 30f64.to_radians(), true).unwrap().is_none());
    let cylinder = make_cylinder(5.0, 10.0).unwrap().unwrap();
    let topo = topology(&cylinder).unwrap();
    let seam = topo["edges"].as_array().unwrap().iter().position(|edge| edge["seam"] == true).unwrap() as u32;
    let any_face = 0u32;
    assert!(
        crate::features::chamfer_sided(&cylinder, &[seam], &[any_face], 1.0, 1.0, false).unwrap().is_none(),
        "a seam edge is refused, not skipped"
    );
}

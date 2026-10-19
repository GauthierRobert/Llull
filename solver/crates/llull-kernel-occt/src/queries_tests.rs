use super::*;
use crate::{make_box, make_cylinder, make_sphere, mass_properties};
use serde_json::json;

fn unit_box() -> Shape {
    make_box([0.0, 0.0, 0.0], [1.0, 2.0, 3.0]).unwrap().unwrap()
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

fn f(value: &Value) -> f64 {
    value.as_f64().unwrap()
}

#[test]
fn box_topology_numbers_six_faces_twelve_edges() {
    let topology = topology(&unit_box()).unwrap();
    assert_eq!(topology["solids"], json!(1));
    assert_eq!(topology["vertices"], json!(8));
    assert_eq!(topology["faces"].as_array().unwrap().len(), 6);
    assert_eq!(topology["edges"].as_array().unwrap().len(), 12);
    assert!(close(f(&topology["volume"]), 6.0));
    // BRepPrim_Box face order: -X, +X, -Y, +Y, -Z, +Z; normals outward.
    let first = &topology["faces"][0];
    assert_eq!(first["surface"], json!("plane"));
    assert_eq!(first["normal"], json!([-1, 0, 0]));
    assert!(close(f(&first["area"]), 6.0));
    let edge = &topology["edges"][0];
    assert_eq!(edge["curve"], json!("line"));
    assert_eq!((edge["seam"].clone(), edge["degenerate"].clone()), (json!(false), json!(false)));
    assert!(edge.get("samples").is_none(), "straight edges carry no samples");
}

#[test]
fn cylinder_topology_has_a_seam_and_an_axis() {
    let cylinder = make_cylinder(2.0, 5.0).unwrap().unwrap();
    let topology = topology(&cylinder).unwrap();
    let side = topology["faces"].as_array().unwrap().iter().find(|face| face["surface"] == json!("cylinder")).unwrap();
    assert_eq!(side["axis"]["direction"], json!([0, 0, 1]));
    assert!(close(f(&side["axis"]["radius"]), 2.0));
    assert_eq!(side["axis"]["span"], json!([0, 5]));
    assert_eq!(side["convex"], json!(true));
    let edges = topology["edges"].as_array().unwrap();
    assert_eq!(edges.iter().filter(|edge| edge["seam"] == json!(true)).count(), 1);
    let circle = edges.iter().find(|edge| edge["curve"] == json!("circle")).unwrap();
    assert_eq!(circle["samples"].as_array().unwrap().len(), 17);
}

#[test]
fn sphere_poles_are_degenerate_edges() {
    let topology = topology(&make_sphere(1.0).unwrap().unwrap()).unwrap();
    let edges = topology["edges"].as_array().unwrap();
    assert_eq!(edges.iter().filter(|edge| edge["degenerate"] == json!(true)).count(), 2);
}

#[test]
fn face_queries_answer_closed_forms() {
    let cylinder = make_cylinder(2.0, 5.0).unwrap().unwrap();
    let details = face_details(&cylinder, 8).unwrap();
    let side = details.as_array().unwrap().iter().find(|face| face["surface"] == json!("cylinder")).unwrap();
    assert!(close(f(&side["radius"]), 2.0));
    assert_eq!(side["samples"].as_array().unwrap().len(), 8);
    let index = side["index"].as_f64().unwrap();
    let projected = project_on_face(&cylinder, index, &[5.0, 0.0, 1.0]).unwrap();
    assert!(close(f(&projected[0]["distance"]), 3.0));
    assert_eq!(face_contains(&cylinder, index, [2.0, 0.0, 1.0], 1e-6).unwrap(), json!(true));
    assert_eq!(face_contains(&cylinder, index, [1.0, 0.0, 1.0], 1e-6).unwrap(), json!(false));
    let samples = face_samples(&cylinder, index, UvRequest::Grid { nu: 2, nv: 2 }).unwrap();
    assert!(close(f(&samples[0]["k1"]), 0.5), "a convex cylinder bends +1/r outward: {}", samples[0]);
    let geometry = face_geometry(&cylinder, index).unwrap();
    assert_eq!(geometry["surface"]["type"], json!("cylinder"));
    let evaluated = evaluate_face(&cylinder, index, &[0.0, 1.0]).unwrap();
    assert_eq!(evaluated[0]["normal"], json!([1, 0, 0]));
}

#[test]
fn out_of_range_faces_answer_null() {
    let shape = unit_box();
    assert_eq!(face_geometry(&shape, 6.0).unwrap(), Value::Null);
    assert_eq!(face_geometry(&shape, -1.0).unwrap(), Value::Null);
    assert_eq!(face_geometry(&shape, 0.5).unwrap(), Value::Null);
    assert_eq!(face_samples(&shape, 0.0, UvRequest::Grid { nu: 0, nv: 3 }).unwrap(), Value::Null);
}

#[test]
fn box_face_graph_edges_are_convex_between_two_faces() {
    let graph = face_graph(&unit_box()).unwrap();
    assert_eq!(graph["faces"].as_array().unwrap().len(), 6);
    assert_eq!(graph["faces"][0]["loops"][0].as_array().unwrap().len(), 4);
    assert!(graph["edgeFaces"].as_array().unwrap().iter().all(|faces| faces.as_array().unwrap().len() == 2));
    assert!(graph["edgeConvexity"].as_array().unwrap().iter().all(|convexity| convexity == &json!("convex")));
}

#[test]
fn distances_sign_inside_points_and_detect_containment() {
    let shape = unit_box();
    let distances = point_distances(&shape, &[0.5, 1.0, 1.0, 3.0, 1.0, 1.5]).unwrap();
    assert!(close(f(&distances[0]["signed"]), -0.5));
    assert!(close(f(&distances[1]["distance"]), 2.0));
    assert_eq!(distances[1]["face"], json!(1));
    let far = make_box([5.0, 0.0, 0.0], [1.0, 1.0, 1.0]).unwrap().unwrap();
    let apart = shape_distance(&shape, &far).unwrap();
    assert!(close(f(&apart["distance"]), 4.0));
    assert_eq!(apart["inside"], json!(false));
    let small = make_box([0.25, 0.5, 0.5], [0.5, 0.5, 0.5]).unwrap().unwrap();
    assert_eq!(shape_distance(&shape, &small).unwrap()["inside"], json!(true));
}

#[test]
fn brep_text_round_trips_in_the_v1_format() {
    let text = write_brep(&unit_box()).unwrap();
    assert!(text.starts_with("\nCASCADE Topology V1") || text.starts_with("CASCADE Topology V1"), "{}", &text[..40]);
    let back = read_brep(&text).unwrap().unwrap();
    assert!(close(mass_properties(&back).unwrap().volume, 6.0));
    assert!(read_brep("not a brep").unwrap().is_none());
}

#[test]
fn step_assemblies_share_parts_and_refuse_cycles() {
    let shape = unit_box();
    let parts = vec![AssemblyPart { shapes: vec![&shape], children: vec![] }];
    let uses: Vec<PartUse> =
        (0..2).map(|k| PartUse { part: 0, rotation: [0.0, 0.0, 0.0], position: [f64::from(k) * 5.0, 0.0, 0.0] }).collect();
    let text = export_step_assembly(&parts, &uses).unwrap().unwrap();
    assert_eq!(text.matches("MANIFOLD_SOLID_BREP(").count(), 1, "one part, written once");
    assert_eq!(text.matches("NEXT_ASSEMBLY_USAGE_OCCURRENCE(").count(), 2);
    let cyclic = vec![AssemblyPart { shapes: vec![&shape], children: vec![PartUse { part: 0, rotation: [0.0; 3], position: [0.0; 3] }] }];
    assert_eq!(export_step_assembly(&cyclic, &uses).unwrap(), None);
}

#[test]
fn imports_its_own_step_export() {
    let text = crate::export_step(&[&unit_box()]).unwrap().unwrap();
    let options = ImportOptions { precision: 0.01, max_tolerance: 1.0, heal: true, sew: true };
    let imported = import_step(&text, options).unwrap();
    assert_eq!(imported["census"]["solids"], json!(1));
    let solid = &imported["solids"][0];
    assert_eq!((solid["validAsRead"].clone(), solid["faces"].clone()), (json!(true), json!(6)));
    let back = read_brep(solid["brep"].as_str().unwrap()).unwrap().unwrap();
    assert!(close(mass_properties(&back).unwrap().volume, 6.0));
    assert_eq!(import_step("garbage", options).unwrap()["error"], json!("unreadable"));
}

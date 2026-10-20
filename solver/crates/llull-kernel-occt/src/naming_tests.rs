//! SC-N1: persistent face / edge names carried by OCCT history through the recipe walk (cpp/naming.hxx).

use crate::recipe::Evaluator;
use serde_json::{json, Value};

fn entity(id: &str, kind: &str, fields: Value) -> Value {
    let mut base = json!({ "id": id, "kind": kind, "position": [0, 0, 0], "rotation": [0, 0, 0], "layerId": "l", "color": "#888" });
    if let (Some(target), Some(extra)) = (base.as_object_mut(), fields.as_object()) {
        target.extend(extra.clone());
    }
    base
}

fn leaf(entity: Value) -> Value {
    json!({ "op": "solid", "entity": entity })
}

fn topology(recipe: &Value) -> Value {
    let shape = Evaluator::new(16).evaluate(recipe).unwrap().unwrap();
    crate::queries::topology(&shape).unwrap()
}

fn names(topology: &Value, kind: &str) -> Vec<String> {
    topology[kind].as_array().unwrap().iter().map(|item| item["name"].as_str().unwrap().to_string()).collect()
}

fn edge_index(topology: &Value, name: &str) -> u32 {
    let found = names(topology, "edges").iter().position(|edge| edge == name);
    u32::try_from(found.unwrap_or_else(|| panic!("no edge {name} in {:?}", names(topology, "edges")))).unwrap()
}

fn sorted(mut items: Vec<String>) -> Vec<String> {
    items.sort();
    items
}

#[test]
fn a_box_names_its_faces_by_outward_axis_after_its_entity() {
    let faces = sorted(names(&topology(&leaf(entity("b", "box", json!({ "size": [2, 3, 4] })))), "faces"));
    assert_eq!(faces, ["b:x+", "b:x-", "b:y+", "b:y-", "b:z+", "b:z-"]);
}

#[test]
fn a_rotated_box_keeps_its_local_roles() {
    let rotated = leaf(entity("b", "box", json!({ "size": [2, 3, 4], "rotation": [0.4, 0.2, 1.1] })));
    assert_eq!(sorted(names(&topology(&rotated), "faces")), ["b:x+", "b:x-", "b:y+", "b:y-", "b:z+", "b:z-"]);
}

#[test]
fn edges_are_named_by_the_faces_that_meet_there() {
    let edges = names(&topology(&leaf(entity("b", "box", json!({ "size": [2, 3, 4] })))), "edges");
    assert_eq!(edges.len(), 12);
    assert!(edges.contains(&"e(b:x+|b:z+)".to_string()), "{edges:?}");
    let unique: std::collections::BTreeSet<&String> = edges.iter().collect();
    assert_eq!(unique.len(), 12, "every box edge has its own pair of faces");
}

#[test]
fn an_extrusion_names_sides_by_profile_segment_and_caps() {
    let prism = leaf(entity("p", "extrusion", json!({ "profile": [[0, 0], [4, 0], [4, 1], [0, 1]], "depth": 3 })));
    let faces = sorted(names(&topology(&prism), "faces"));
    assert_eq!(faces, ["p:cap.end", "p:cap.start", "p:side.0", "p:side.1", "p:side.2", "p:side.3"]);
}

#[test]
fn a_cylinder_has_a_side_a_top_and_a_bottom() {
    let faces = sorted(names(&topology(&leaf(entity("c", "cylinder", json!({ "radius": 1, "height": 2 })))), "faces"));
    assert_eq!(faces, ["c:bottom", "c:side", "c:top"]);
}

#[test]
fn a_fillet_keeps_the_faces_and_names_the_blend_after_its_edge() {
    let base = leaf(entity("b", "box", json!({ "size": [4, 4, 4] })));
    let edge = edge_index(&topology(&base), "e(b:x+|b:z+)");
    let filleted = json!({ "op": "fillet", "source": base, "edges": [edge], "size": 0.5 });
    let faces = names(&topology(&filleted), "faces");
    assert!(faces.contains(&"blend(e(b:x+|b:z+))".to_string()), "{faces:?}");
    for kept in ["b:x+", "b:x-", "b:y+", "b:y-", "b:z+", "b:z-"] {
        assert!(faces.contains(&kept.to_string()), "{kept} lost: {faces:?}");
    }
}

#[test]
fn an_upstream_size_edit_keeps_the_edge_name_on_the_same_corner() {
    for size in [[4, 4, 4], [7, 2, 5]] {
        let top = topology(&leaf(entity("b", "box", json!({ "size": size }))));
        let index = usize::try_from(edge_index(&top, "e(b:x+|b:z+)")).unwrap();
        let mid = &top["edges"][index]["mid"];
        let half = |axis: usize| f64::from(size[axis]) / 2.0;
        assert!((mid[0].as_f64().unwrap() - half(0)).abs() < 1e-9 && (mid[2].as_f64().unwrap() - half(2)).abs() < 1e-9);
    }
}

#[test]
fn a_boolean_keeps_operand_names_and_a_cut_names_the_tool_wall() {
    let block = leaf(entity("b", "box", json!({ "size": [10, 10, 4] })));
    let pin = leaf(entity("c", "cylinder", json!({ "radius": 1, "height": 10 })));
    let cut = json!({ "op": "boolean", "boolean": "subtract", "a": block, "b": pin });
    let faces = names(&topology(&cut), "faces");
    assert!(faces.contains(&"c:side".to_string()), "the bore is the cylinder's side: {faces:?}");
    assert_eq!(faces.iter().filter(|face| face.as_str() == "b:z+").count(), 1);
}

#[test]
fn a_face_split_in_two_keeps_its_name_twice() {
    let block = leaf(entity("b", "box", json!({ "size": [10, 4, 4] })));
    let slot = leaf(entity("s", "box", json!({ "size": [2, 6, 6], "position": [0, 0, 1] })));
    let cut = json!({ "op": "boolean", "boolean": "subtract", "a": block, "b": slot });
    let faces = names(&topology(&cut), "faces");
    assert_eq!(faces.iter().filter(|face| face.as_str() == "b:z+").count(), 2, "{faces:?}");
}

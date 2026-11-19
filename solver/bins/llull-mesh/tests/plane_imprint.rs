//! `intersectPlane` targets end to end (FEA-PLANE-MESH): the STEP part is split by the plane before meshing, the target is the nodes on the
//! section edges, and the mesh stays ONE conformal model across every cut (any plane orientation). STEP fixtures:
//! solver/crates/llull-netgen/tests/fixtures.

mod common;

use common::*;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

/// A STEP part with one target carrying a plane (millimetres, analysis unit = document unit).
fn plane_request(fixture: &str, target: Value, order: i64) -> Value {
    json!({
        "op": "mesh", "lengthScale": 1.0,
        "parts": [{ "entityId": "b", "geometry": step(fixture) }],
        "targets": [target],
        "controls": { "order": order, "globalSize": 3.0, "refinements": [] }
    })
}

/// Corner nodes (first 4) of every tet of block 0.
fn tets(response: &Value) -> Vec<[u64; 4]> {
    elements(response, 0).iter().map(|row| [1, 2, 3, 4].map(|k| row[k].as_u64().unwrap())).collect()
}

/// A cut plane: a point and a unit normal.
type Cut = ([f64; 3], [f64; 3]);

fn x_cut(at: f64) -> Cut {
    ([at, 0.0, 0.0], [1.0, 0.0, 0.0])
}

/// Signed distance of `p` to the plane `cut` (any normal length).
fn signed(cut: &Cut, p: &[f64; 3]) -> f64 {
    let length = cut.1.iter().map(|c| c * c).sum::<f64>().sqrt();
    (0..3).map(|k| (p[k] - cut.0[k]) * cut.1[k]).sum::<f64>() / length
}

/// Diagonal of the box of the mesh nodes.
fn mesh_diagonal(xyz: &HashMap<u64, [f64; 3]>) -> f64 {
    let (mut low, mut high) = ([f64::MAX; 3], [f64::MIN; 3]);
    for p in xyz.values() {
        for k in 0..3 {
            (low[k], high[k]) = (low[k].min(p[k]), high[k].max(p[k]));
        }
    }
    (0..3).map(|k| (high[k] - low[k]).powi(2)).sum::<f64>().sqrt()
}

/// The mesh is ONE conformal model across every cut: no coincident nodes, every node on a cut plane (any orientation, within 1e-9 x the mesh
/// diagonal) used by tets on both sides, and the tets joined through shared nodes into a single component. `cuts` = the imprinted planes (empty: only the generic checks).
fn assert_conformal(response: &Value, cuts: &[Cut]) {
    let xyz = coords(response);
    let mut seen: HashMap<[i64; 3], u64> = HashMap::new();
    for (id, p) in &xyz {
        let key = p.map(|c| (c * 1e9).round() as i64);
        if let Some(other) = seen.insert(key, *id) {
            panic!("nodes {other} and {id} coincide at {p:?}: the mesh is split along a cut");
        }
    }
    let cells = tets(response);
    let centre = |cell: &[u64; 4]| [0, 1, 2].map(|k| cell.iter().map(|n| xyz[n][k]).sum::<f64>() / 4.0);
    let on = 1e-9 * mesh_diagonal(&xyz);
    for cut in cuts {
        let corners: HashSet<u64> = cells.iter().flatten().copied().collect();
        let on_cut: HashSet<u64> = corners.iter().filter(|id| signed(cut, &xyz[id]).abs() < on).copied().collect();
        assert!(!on_cut.is_empty(), "no node on the plane cut {cut:?}");
        let (mut below, mut above): (HashSet<u64>, HashSet<u64>) = (HashSet::new(), HashSet::new());
        for cell in &cells {
            let side = if signed(cut, &centre(cell)) < 0.0 { &mut below } else { &mut above };
            side.extend(cell.iter().filter(|n| on_cut.contains(n)));
        }
        for node in &on_cut {
            assert!(
                below.contains(node) && above.contains(node),
                "node {node} of the plane cut {cut:?} is not shared by tets on both sides"
            );
        }
    }
    let mut parent: HashMap<u64, u64> = xyz.keys().map(|n| (*n, *n)).collect();
    fn find(parent: &mut HashMap<u64, u64>, n: u64) -> u64 {
        let p = parent[&n];
        if p == n {
            return n;
        }
        let root = find(parent, p);
        parent.insert(n, root);
        root
    }
    for cell in &cells {
        let root = find(&mut parent, cell[0]);
        for n in &cell[1..] {
            let other = find(&mut parent, *n);
            parent.insert(other, root);
        }
    }
    let components: HashSet<u64> = cells.iter().map(|cell| find(&mut parent, cell[0])).collect();
    assert_eq!(components.len(), 1, "the tets form {} disconnected pieces", components.len());
}

fn volumes_are_positive(response: &Value, cuts: &[Cut]) {
    let xyz = coords(response);
    assert!(!elements(response, 0).is_empty());
    for cell in tets(response) {
        let corners: Vec<[f64; 3]> = cell.iter().map(|n| xyz[n]).collect();
        let edge = |i: usize| [0, 1, 2].map(|k| corners[i][k] - corners[0][k]);
        let (a, b, c) = (edge(1), edge(2), edge(3));
        let volume = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
        assert!(volume.abs() > 0.0, "flat element {cell:?}");
    }
    assert_conformal(response, cuts);
}

/// The checker is not vacuous: duplicating the cut-face nodes (two separate solids meshed side by side) is caught.
#[test]
#[should_panic(expected = "coincide")]
fn the_conformity_check_catches_a_mesh_split_along_the_cut() {
    let target = json!({ "key": "C", "entityId": "b", "facesNear": [[3.0, 5.0, 10.0]], "intersectPlane": plane_x(10.0) });
    let mut response = run(&plane_request("box_20x10x10.step", target, 1));
    let xyz = coords(&response);
    let last = xyz.keys().max().copied().unwrap();
    let on_cut: Vec<u64> = xyz.iter().filter(|(_, p)| (p[0] - 10.0).abs() < 1e-9).map(|(id, _)| *id).collect();
    let mut copies = Vec::new();
    for (k, id) in on_cut.iter().enumerate() {
        copies.push(json!([last + 1 + k as u64, xyz[id][0], xyz[id][1], xyz[id][2]]));
    }
    response["nodes"].as_array_mut().unwrap().extend(copies);
    assert_conformal(&response, &[x_cut(10.0)]);
}

fn plane_x(at: f64) -> Value {
    json!({ "point": [at, 0.0, 0.0], "normal": [1.0, 0.0, 0.0] })
}

#[test]
fn a_box_top_face_cut_by_the_mid_plane_targets_the_nodes_on_the_section_line() {
    for order in [1, 2] {
        let target = json!({ "key": "C_mid", "entityId": "b", "facesNear": [[3.0, 5.0, 10.0]], "intersectPlane": plane_x(10.0) });
        let response = run(&plane_request("box_20x10x10.step", target, order));
        assert_eq!(response["ok"], true, "{response}");
        let xyz = coords(&response);
        let set = ids(&response["nodeSets"]["C_mid"]);
        assert!(set.len() >= 3, "{}", set.len());
        assert!(set.iter().all(|n| (xyz[n][0] - 10.0).abs() < 1e-9 && (xyz[n][2] - 10.0).abs() < 1e-9), "on the plane AND the top face");
        let (low, high) = set.iter().fold((f64::MAX, f64::MIN), |(lo, hi), n| (lo.min(xyz[n][1]), hi.max(xyz[n][1])));
        assert!(low.abs() < 1e-9 && (high - 10.0).abs() < 1e-9, "the whole section line [0, 10] is covered: {low}..{high}");
        assert!(response["faceSets"].get("C_mid").is_none(), "a plane target has no faces of its own");
        volumes_are_positive(&response, &[x_cut(10.0)]);
    }
}

#[test]
fn an_off_centre_plane_gives_a_line_of_nodes_not_the_whole_face() {
    let cut = |plane: Option<Value>| {
        let mut target = json!({ "key": "L", "entityId": "b", "facesNear": [[3.0, 5.0, 10.0]] });
        if let Some(plane) = plane {
            target["intersectPlane"] = plane;
        }
        run(&plane_request("box_20x10x10.step", target, 1))
    };
    let whole = cut(None);
    let section = cut(Some(plane_x(7.3)));
    let xyz = coords(&section);
    let line = ids(&section["nodeSets"]["L"]);
    assert!(!line.is_empty() && line.iter().all(|n| (xyz[n][0] - 7.3).abs() < 1e-9), "mesh nodes lie exactly on the imprinted plane");
    let top = ids(&whole["nodeSets"]["L"]);
    assert!(top.len() > 2 * line.len(), "{} of the top face's {}", line.len(), top.len());
}

#[test]
fn an_oblique_plane_cuts_the_part_into_one_conformal_model() {
    // through the centre (10, 5, 5), normal (1, 0.5, 1) / 1.5: the top face z = 10 is cut along x = 7.5 - y / 2
    let cut: Cut = ([10.0, 5.0, 5.0], [1.0, 0.5, 1.0]);
    let plane = json!({ "point": cut.0, "normal": cut.1 });
    for order in [1, 2] {
        let target = json!({ "key": "C", "entityId": "b", "facesNear": [[3.0, 5.0, 10.0]], "intersectPlane": plane });
        let response = run(&plane_request("box_20x10x10.step", target, order));
        assert_eq!(response["ok"], true, "{response}");
        let xyz = coords(&response);
        let set = ids(&response["nodeSets"]["C"]);
        assert!(set.len() >= 3, "{}", set.len());
        assert!(set.iter().all(|n| signed(&cut, &xyz[n]).abs() < 1e-9 && (xyz[n][2] - 10.0).abs() < 1e-9), "on the plane AND the top face");
        let (low, high) = set.iter().fold((f64::MAX, f64::MIN), |(lo, hi), n| (lo.min(xyz[n][1]), hi.max(xyz[n][1])));
        assert!(low.abs() < 1e-9 && (high - 10.0).abs() < 1e-9, "the whole section line is covered: y {low}..{high}");
        volumes_are_positive(&response, &[cut]);
    }
}

/// The oblique check is not vacuous: the imprinted oblique mesh torn along its cut (the tets above it re-pointed to copies of the cut nodes,
/// shifted 1e-6 within the plane so no node coincides) is caught by the both-sides check.
#[test]
#[should_panic(expected = "is not shared by tets on both sides")]
fn the_conformity_check_catches_a_mesh_torn_along_an_oblique_cut() {
    let cut: Cut = ([10.0, 5.0, 5.0], [1.0, 0.5, 1.0]);
    let target =
        json!({ "key": "C", "entityId": "b", "facesNear": [[3.0, 5.0, 10.0]], "intersectPlane": { "point": cut.0, "normal": cut.1 } });
    let mut response = run(&plane_request("box_20x10x10.step", target, 1));
    assert_eq!(response["ok"], true, "{response}");
    let xyz = coords(&response);
    let last = xyz.keys().max().copied().unwrap();
    let on_cut: Vec<u64> = xyz.iter().filter(|(_, p)| signed(&cut, p).abs() < 1e-9).map(|(id, _)| *id).collect();
    assert!(!on_cut.is_empty());
    // (1, 0, -1) / sqrt 2 lies in the plane
    let shift = [1e-6 / 2f64.sqrt(), 0.0, -1e-6 / 2f64.sqrt()];
    let copy_of: HashMap<u64, u64> = on_cut.iter().enumerate().map(|(k, id)| (*id, last + 1 + k as u64)).collect();
    let copies: Vec<Value> =
        on_cut.iter().map(|id| json!([copy_of[id], xyz[id][0] + shift[0], xyz[id][1] + shift[1], xyz[id][2] + shift[2]])).collect();
    response["nodes"].as_array_mut().unwrap().extend(copies);
    for row in response["blocks"][0]["elements"].as_array_mut().unwrap() {
        let row = row.as_array_mut().unwrap();
        let centre = [0, 1, 2].map(|k| (1..=4).map(|c| xyz[&row[c].as_u64().unwrap()][k]).sum::<f64>() / 4.0);
        if signed(&cut, &centre) > 0.0 {
            for node in row.iter_mut().skip(1) {
                if let Some(copy) = copy_of.get(&node.as_u64().unwrap()) {
                    *node = json!(copy);
                }
            }
        }
    }
    assert_conformal(&response, &[cut]);
}

#[test]
fn a_cylinder_cut_by_a_plane_through_its_axis_targets_the_two_seam_lines() {
    let target = json!({ "key": "S", "entityId": "b", "facesNear": [[7.0, 10.0, 1.0]], "intersectPlane": plane_x(10.0) });
    let response = run(&plane_request("plate_hole.step", target, 1));
    assert_eq!(response["ok"], true, "{response}");
    let xyz = coords(&response);
    let set = ids(&response["nodeSets"]["S"]);
    assert!(set.len() >= 4, "{}", set.len());
    for n in &set {
        let [x, y, _] = xyz[n];
        assert!((x - 10.0).abs() < 1e-9, "on the plane: x = {x}");
        assert!(((y - 10.0).abs() - 3.0).abs() < 1e-6, "on the hole wall: y = {y}");
    }
    assert!(set.iter().any(|n| xyz[n][1] < 10.0) && set.iter().any(|n| xyz[n][1] > 10.0), "both seams");
    volumes_are_positive(&response, &[x_cut(10.0)]);
}

#[test]
fn a_plane_that_misses_the_part_or_the_selected_faces_is_a_named_error() {
    let miss = json!({ "key": "C", "entityId": "b", "facesNear": [[3.0, 5.0, 10.0]], "intersectPlane": plane_x(50.0) });
    let response = run(&plane_request("box_20x10x10.step", miss, 1));
    assert_eq!(response["code"], "FEA_TARGET_UNRESOLVED", "{response}");
    assert!(response["error"].as_str().unwrap().contains("does not cut"), "{response}");
    // the plane cuts the part but not the (end) face the target selects
    let off_face = json!({ "key": "C", "entityId": "b", "facesNear": [[0.0, 5.0, 5.0]], "intersectPlane": plane_x(10.0) });
    let response = run(&plane_request("box_20x10x10.step", off_face, 1));
    assert_eq!(response["code"], "FEA_TARGET_UNRESOLVED", "{response}");
    assert!(response["error"].as_str().unwrap().contains("meets no edge of the selected faces"), "{response}");
    let no_face = json!({ "key": "C", "entityId": "b", "pointsNear": [[0.0, 5.0, 5.0]], "intersectPlane": plane_x(10.0) });
    let response = run(&plane_request("box_20x10x10.step", no_face, 1));
    assert!(response["error"].as_str().unwrap().contains("needs facesNear"), "{response}");
}

#[test]
fn a_plane_target_on_stl_geometry_or_with_conformal_bonding_is_refused_not_ignored() {
    let mut request = box_request(1);
    request["targets"] = json!([{ "key": "C", "entityId": "box-1", "facesNear": [[0.0, 5.0, 5.0]], "intersectPlane": plane_x(10.0) }]);
    assert_eq!(run(&request)["code"], "FEA_TARGET_PLANE_UNSUPPORTED");
    let target = json!({ "key": "C", "entityId": "b", "facesNear": [[3.0, 5.0, 10.0]], "intersectPlane": plane_x(10.0) });
    let mut request = plane_request("box_20x10x10.step", target, 1);
    request["controls"]["bonding"] = json!("conformal");
    assert_eq!(run(&request)["code"], "FEA_TARGET_PLANE_UNSUPPORTED");
}

#[test]
fn targets_without_a_plane_still_resolve_when_another_target_imprints_one() {
    let request = json!({
        "op": "mesh", "lengthScale": 1.0,
        "parts": [{ "entityId": "b", "geometry": step("box_20x10x10.step") }],
        "targets": [
            { "key": "C", "entityId": "b", "facesNear": [[0.0, 5.0, 5.0]] },
            { "key": "T", "entityId": "b", "facesNear": [[3.0, 5.0, 10.0]] },
            { "key": "E", "entityId": "b", "edgesNear": [[10.0, 0.0, 0.0]] },
            { "key": "P", "entityId": "b", "facesNear": [[3.0, 5.0, 10.0]], "intersectPlane": plane_x(10.0) }
        ],
        "controls": { "order": 1, "globalSize": 3.0, "refinements": [{ "key": "P", "size": 1.5 }] }
    });
    let response = run(&request);
    assert_eq!(response["ok"], true, "{response}");
    let xyz = coords(&response);
    let near = |key: &str, axis: usize, value: f64| ids(&response["nodeSets"][key]).iter().all(|n| (xyz[n][axis] - value).abs() < 1e-9);
    assert!(near("C", 0, 0.0) && near("T", 2, 10.0) && near("P", 0, 10.0));
    // the edge y = 0, z = 0 runs the whole 20 mm although the plane split it at x = 10
    let edge = ids(&response["nodeSets"]["E"]);
    let span = edge.iter().fold((f64::MAX, f64::MIN), |(lo, hi), n| (lo.min(xyz[n][0]), hi.max(xyz[n][0])));
    assert!(edge.iter().all(|n| xyz[n][1].abs() < 1e-9 && xyz[n][2].abs() < 1e-9) && span.0.abs() < 1e-9 && (span.1 - 20.0).abs() < 1e-9);
    // the whole top face: both halves
    let top = ids(&response["nodeSets"]["T"]);
    assert!(top.iter().any(|n| xyz[n][0] < 10.0 - 1e-9) && top.iter().any(|n| xyz[n][0] > 10.0 + 1e-9));
    assert!(response["faceSets"].get("T").is_some());
}

/// CalculiX tet face labels over the first four nodes of the element.
const FACE_CORNERS: [[usize; 3]; 4] = [[0, 1, 2], [0, 3, 1], [1, 3, 2], [2, 3, 0]];

/// Total area of the element faces of face set `key`.
fn face_set_area(response: &Value, key: &str) -> f64 {
    let xyz = coords(response);
    let rows: HashMap<u64, Vec<u64>> =
        elements(response, 0).iter().map(|row| (row[0].as_u64().unwrap(), (1..=4).map(|k| row[k].as_u64().unwrap()).collect())).collect();
    response["faceSets"][key]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            let nodes = &rows[&entry[0].as_u64().unwrap()];
            let [a, b, c] = FACE_CORNERS[entry[1].as_u64().unwrap() as usize - 1].map(|k| xyz[&nodes[k]]);
            let (u, v) = ([0, 1, 2].map(|k| b[k] - a[k]), [0, 1, 2].map(|k| c[k] - a[k]));
            let cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
            0.5 * cross.iter().map(|c| c * c).sum::<f64>().sqrt()
        })
        .sum()
}

#[test]
fn a_pressure_face_cut_by_a_plane_keeps_its_whole_area_and_the_mesh_stays_one_model() {
    for order in [1, 2] {
        let request = json!({
            "op": "mesh", "lengthScale": 1.0,
            "parts": [{ "entityId": "b", "geometry": step("box_20x10x10.step") }],
            "targets": [
                { "key": "T", "entityId": "b", "facesNear": [[3.0, 5.0, 10.0]] },
                { "key": "P", "entityId": "b", "facesNear": [[3.0, 5.0, 10.0]], "intersectPlane": plane_x(10.0) },
                { "key": "E", "entityId": "b", "edgesNear": [[10.0, 0.0, 0.0]] }
            ],
            "controls": { "order": order, "globalSize": 3.0, "refinements": [] }
        });
        let response = run(&request);
        assert_eq!(response["ok"], true, "{response}");
        let area = face_set_area(&response, "T");
        assert!((area - 200.0).abs() < 1e-6, "order {order}: the cut top face totals {area}, not 200 mm2");
        volumes_are_positive(&response, &[x_cut(10.0)]);
        let xyz = coords(&response);
        let edge = ids(&response["nodeSets"]["E"]);
        assert!(edge.iter().any(|n| xyz[n][0] < 9.0) && edge.iter().any(|n| xyz[n][0] > 11.0), "the split edge keeps both halves");
    }
}

#[test]
fn an_edge_already_in_the_plane_is_the_section_of_the_face_it_bounds() {
    // plane x = y holds the vertical edge (0, 0, z) of the box; the x = 0 face is not split, the section is that existing edge
    let plane = json!({ "point": [0.0, 0.0, 0.0], "normal": [1.0, -1.0, 0.0] });
    let target = json!({ "key": "C", "entityId": "b", "facesNear": [[0.0, 5.0, 5.0]], "intersectPlane": plane });
    let response = run(&plane_request("box_20x10x10.step", target, 1));
    assert_eq!(response["ok"], true, "{response}");
    let xyz = coords(&response);
    let set = ids(&response["nodeSets"]["C"]);
    assert!(set.len() >= 3 && set.iter().all(|n| xyz[n][0].abs() < 1e-9 && xyz[n][1].abs() < 1e-9), "{} nodes", set.len());
    let zs = set.iter().map(|n| xyz[n][2]);
    assert!(zs.clone().fold(f64::MAX, f64::min).abs() < 1e-9 && (zs.fold(f64::MIN, f64::max) - 10.0).abs() < 1e-9);
    volumes_are_positive(&response, &[]);
}

#[test]
fn two_distinct_planes_split_one_part_into_one_model() {
    let request = json!({
        "op": "mesh", "lengthScale": 1.0,
        "parts": [{ "entityId": "b", "geometry": step("box_20x10x10.step") }],
        "targets": [
            { "key": "A", "entityId": "b", "facesNear": [[3.0, 5.0, 10.0]], "intersectPlane": plane_x(5.0) },
            { "key": "B", "entityId": "b", "facesNear": [[3.0, 5.0, 10.0]], "intersectPlane": plane_x(15.0) },
            { "key": "T", "entityId": "b", "facesNear": [[3.0, 5.0, 10.0]] }
        ],
        "controls": { "order": 2, "globalSize": 3.0, "refinements": [] }
    });
    let response = run(&request);
    assert_eq!(response["ok"], true, "{response}");
    let xyz = coords(&response);
    for (key, at) in [("A", 5.0), ("B", 15.0)] {
        let set = ids(&response["nodeSets"][key]);
        assert!(set.len() >= 3 && set.iter().all(|n| (xyz[n][0] - at).abs() < 1e-9 && (xyz[n][2] - 10.0).abs() < 1e-9), "{key}");
    }
    assert!((face_set_area(&response, "T") - 200.0).abs() < 1e-6, "the top face is cut in three and keeps its area");
    volumes_are_positive(&response, &[x_cut(5.0), x_cut(15.0)]);
}

#[test]
fn the_same_plane_written_with_different_rounding_or_normal_is_imprinted_once() {
    let request = |second: Value| {
        json!({
            "op": "mesh", "lengthScale": 1.0,
            "parts": [{ "entityId": "b", "geometry": step("box_20x10x10.step") }],
            "targets": [
                { "key": "A", "entityId": "b", "facesNear": [[3.0, 5.0, 10.0]], "intersectPlane": plane_x(10.0) },
                { "key": "B", "entityId": "b", "facesNear": [[3.0, 5.0, 10.0]], "intersectPlane": second }
            ],
            "controls": { "order": 1, "globalSize": 3.0, "refinements": [] }
        })
    };
    let alike = [
        json!({ "point": [10.0 + 4e-10, 3.0, 2.0], "normal": [2.0, 1e-11, 0.0] }),
        json!({ "point": [10.0, 0.0, 9.0], "normal": [-1.0, 0.0, 0.0] }),
    ];
    for second in alike {
        let response = run(&request(second));
        assert_eq!(response["ok"], true, "{response}");
        assert_eq!(response["nodeSets"]["A"], response["nodeSets"]["B"], "one imprint: both targets are the same nodes");
        volumes_are_positive(&response, &[x_cut(10.0)]);
    }
}

#[test]
fn an_imprinted_request_gives_the_same_mesh_twice() {
    let request = json!({
        "op": "mesh", "lengthScale": 1.0,
        "parts": [{ "entityId": "b", "geometry": step("plate_hole.step") }],
        "targets": [{ "key": "S", "entityId": "b", "facesNear": [[7.0, 10.0, 1.0]], "intersectPlane": plane_x(10.0) }],
        "controls": { "order": 2, "globalSize": 3.0, "refinements": [{ "key": "S", "size": 1.5 }] }
    });
    let (a, b) = (run(&request), run(&request));
    assert_eq!(a["ok"], true, "{a}");
    assert_eq!((&a["nodes"], &a["blocks"], &a["nodeSets"]), (&b["nodes"], &b["blocks"], &b["nodeSets"]));
}

#[test]
fn a_plane_tangent_to_or_lying_in_a_face_cuts_nothing() {
    for at in [0.0, 20.0] {
        let target = json!({ "key": "C", "entityId": "b", "facesNear": [[3.0, 5.0, 10.0]], "intersectPlane": plane_x(at) });
        let response = run(&plane_request("box_20x10x10.step", target, 1));
        assert_eq!(response["code"], "FEA_TARGET_UNRESOLVED", "x = {at}: {response}");
        assert!(response["error"].as_str().unwrap().contains("tangent"), "{response}");
    }
}

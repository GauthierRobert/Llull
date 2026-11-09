//! `llull-mesh` end to end: requests on stdin, the response line on stdout. STEP fixtures: solver/crates/llull-netgen/tests/fixtures
//! (CadQuery boxes and a plate with a 6 mm hole, millimetres). The parity with the previous mesher is measured on the server's
//! FE suites (docs/decisions/NG1-netgen-mesher.md).

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::process::{Command, Stdio};

fn run(request: &Value) -> Value {
    let mut child =
        Command::new(env!("CARGO_BIN_EXE_llull-mesh")).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    child.stdin.take().unwrap().write_all(request.to_string().as_bytes()).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let stdout = String::from_utf8(output.stdout).unwrap();
    serde_json::from_str(stdout.lines().rfind(|line| !line.trim().is_empty()).unwrap()).unwrap()
}

fn base64(data: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn step(name: &str) -> Value {
    let path = format!("{}/../../crates/llull-netgen/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    json!({ "kind": "step", "stepBase64": base64(&std::fs::read(path).unwrap()) })
}

/// Binary STL of the box [0, a] x [0, b] x [0, c], outward facets.
fn box_stl(a: f32, b: f32, c: f32) -> String {
    let corner = |i: usize| [if i & 1 != 0 { a } else { 0.0 }, if i & 2 != 0 { b } else { 0.0 }, if i & 4 != 0 { c } else { 0.0 }];
    let quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
    let mut data = vec![0u8; 80];
    data.extend_from_slice(&12u32.to_le_bytes());
    for quad in quads {
        for triangle in [[quad[0], quad[1], quad[2]], [quad[0], quad[2], quad[3]]] {
            data.extend_from_slice(&[0u8; 12]);
            for vertex in triangle {
                for value in corner(vertex) {
                    data.extend_from_slice(&value.to_le_bytes());
                }
            }
            data.extend_from_slice(&[0u8; 2]);
        }
    }
    base64(&data)
}

fn box_request(order: i64) -> Value {
    json!({
        "op": "mesh",
        "lengthScale": 0.001,
        "parts": [{ "entityId": "box-1", "geometry": { "kind": "stl", "stlBase64": box_stl(20.0, 10.0, 10.0) } }],
        "targets": [
            { "key": "C_fix", "entityId": "box-1", "facesNear": [[0.0, 5.0, 5.0]] },
            { "key": "L_end", "entityId": "box-1", "facesNear": [[20.0, 5.0, 5.0]] },
            { "key": "P_tip", "entityId": null, "pointsNear": [[20.0, 10.0, 10.0]] }
        ],
        "controls": { "order": order, "elementFamily": "tet", "globalSize": 4.0, "refinements": [{ "key": "C_fix", "size": 2.0 }] }
    })
}

fn coords(response: &Value) -> HashMap<u64, [f64; 3]> {
    response["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| (n[0].as_u64().unwrap(), [n[1].as_f64().unwrap(), n[2].as_f64().unwrap(), n[3].as_f64().unwrap()]))
        .collect()
}

fn ids(set: &Value) -> Vec<u64> {
    set.as_array().unwrap().iter().map(|n| n.as_u64().unwrap()).collect()
}

fn elements(response: &Value, block: usize) -> &Vec<Value> {
    response["blocks"][block]["elements"].as_array().unwrap()
}

#[test]
fn reports_netgen_and_occt_versions() {
    let output = Command::new(env!("CARGO_BIN_EXE_llull-mesh")).arg("--version").output().unwrap();
    let line = String::from_utf8_lossy(&output.stdout);
    assert!(line.starts_with("llull-mesh ") && line.contains("(Netgen 6.2.") && line.contains(", OCCT 7.9"), "{line}");
}

#[test]
fn meshes_an_stl_box_into_quadratic_tets_with_target_sets_in_the_analysis_unit() {
    let response = run(&box_request(2));
    assert_eq!(response["ok"], true, "{response}");
    assert_eq!(response["mesher"], "netgen");
    assert!(response["mesherVersion"].as_str().unwrap().starts_with("6.2."));
    assert_eq!(response["blocks"].as_array().unwrap().len(), 1);
    assert_eq!(response["blocks"][0]["type"], "C3D10");
    assert!(elements(&response, 0).iter().all(|e| e.as_array().unwrap().len() == 11));
    let node_ids: Vec<u64> = response["nodes"].as_array().unwrap().iter().map(|n| n[0].as_u64().unwrap()).collect();
    assert_eq!(node_ids, (1..=node_ids.len() as u64).collect::<Vec<_>>(), "node ids are contiguous from 1");
    let xyz = coords(&response);
    let fixed = ids(&response["nodeSets"]["C_fix"]);
    assert!(!fixed.is_empty());
    assert!(fixed.iter().all(|n| xyz[n][0].abs() < 1e-12), "C_fix lies on x = 0");
    assert!(ids(&response["nodeSets"]["L_end"]).iter().all(|n| (xyz[n][0] - 0.02).abs() < 1e-7));
    let faces = response["faceSets"]["L_end"].as_array().unwrap();
    assert!(!faces.is_empty() && faces.iter().all(|f| (1..=4).contains(&f[1].as_i64().unwrap())));
    assert_eq!(response["nodeSets"]["P_tip"].as_array().unwrap().len(), 1);
    assert!(response["targets"]["P_tip"]["residual"].as_f64().unwrap() < 1e-7);
    // every C3D10 has a positive volume and its mid nodes halfway along its edges
    for element in elements(&response, 0) {
        let n: Vec<[f64; 3]> = element.as_array().unwrap()[1..].iter().map(|id| xyz[&id.as_u64().unwrap()]).collect();
        let d = |a: usize, b: usize| [0, 1, 2].map(|k| n[b][k] - n[a][k]);
        let (u, v, w) = (d(0, 1), d(0, 2), d(0, 3));
        let volume = u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0]);
        assert!(volume > 0.0);
        assert!((0..3).all(|k| (n[4][k] - (n[0][k] + n[1][k]) / 2.0).abs() < 1e-15 && (n[9][k] - (n[2][k] + n[3][k]) / 2.0).abs() < 1e-15));
    }
}

#[test]
fn the_refined_face_gets_smaller_elements() {
    let mut plain = box_request(1);
    plain["controls"]["refinements"] = json!([]);
    let (plain, refined) = (run(&plain), run(&box_request(1)));
    let count = |r: &Value| r["faceSets"]["C_fix"].as_array().unwrap().len();
    assert!(count(&refined) > 2 * count(&plain), "{} vs {}", count(&refined), count(&plain));
}

#[test]
fn the_same_request_gives_the_same_mesh() {
    assert_eq!(run(&box_request(1)), run(&box_request(1)));
}

#[test]
fn a_step_part_resolves_faces_by_point_and_by_kernel_face_map_and_edges() {
    // kernel face 4 = the x = 20 face of the box (area 100 mm2, centroid (20, 5, 5))
    let request = json!({
        "op": "mesh", "lengthScale": 1.0,
        "parts": [{ "entityId": "b", "geometry": step("box_20x10x10.step"),
            "faces": [{ "index": 4, "area": 100.0, "centroid": [20.0, 5.0, 5.0] }] }],
        "targets": [
            { "key": "C", "entityId": "b", "facesNear": [[0.0, 5.0, 5.0]] },
            { "key": "L", "entityId": "b", "faceIndices": [4] },
            { "key": "E", "entityId": "b", "edgesNear": [[20.0, 0.0, 5.0]] }
        ],
        "controls": { "order": 1, "globalSize": 3.0, "refinements": [] }
    });
    let response = run(&request);
    assert_eq!(response["ok"], true, "{response}");
    let xyz = coords(&response);
    assert!(ids(&response["nodeSets"]["C"]).iter().all(|n| xyz[n][0].abs() < 1e-9));
    assert!(ids(&response["nodeSets"]["L"]).iter().all(|n| (xyz[n][0] - 20.0).abs() < 1e-9));
    let edge = ids(&response["nodeSets"]["E"]);
    assert!(edge.len() >= 2 && edge.iter().all(|n| (xyz[n][0] - 20.0).abs() < 1e-9 && xyz[n][1].abs() < 1e-9));
    let map = response["faceMap"].as_array().unwrap();
    assert_eq!(map.len(), 1);
    assert_eq!((map[0]["entityId"].as_str(), map[0]["faceIndex"].as_i64()), (Some("b"), Some(4)));
    assert!(map[0]["residual"].as_f64().unwrap() < 1e-9);
}

#[test]
fn touching_step_parts_bond_conformally_and_overlapping_ones_are_refused() {
    let request = |right: &str| {
        json!({
            "op": "mesh", "lengthScale": 1.0,
            "parts": [{ "entityId": "left", "geometry": step("box_20x10x10.step") }, { "entityId": "right", "geometry": step(right) }],
            "targets": [{ "key": "F", "entityId": "left", "facesNear": [[0.0, 5.0, 5.0]] }, { "key": "R", "entityId": "right", "facesNear": [[40.0, 5.0, 5.0]] }],
            "controls": { "order": 2, "globalSize": 4.0, "bonding": "conformal", "refinements": [] }
        })
    };
    let response = run(&request("box_right_20x10x10.step"));
    assert_eq!(response["ok"], true, "{response}");
    let part_nodes = |block: usize| -> HashSet<u64> { elements(&response, block).iter().flat_map(|e| ids(e)[1..].to_vec()).collect() };
    let (left, right) = (part_nodes(0), part_nodes(1));
    let shared: Vec<&u64> = left.intersection(&right).collect();
    let xyz = coords(&response);
    assert!(!shared.is_empty() && shared.iter().all(|n| (xyz[n][0] - 20.0).abs() < 1e-9), "the parts share the x = 20 interface");
    assert_eq!(left.len() + right.len() - shared.len(), xyz.len());
    let overlap = run(&request("box_20x10x10.step"));
    assert_eq!(overlap["code"], "FEA_BONDING_OVERLAP", "{overlap}");
}

#[test]
fn a_small_hole_is_defeatured_before_meshing() {
    let request = json!({
        "op": "mesh", "lengthScale": 1.0,
        "parts": [{ "entityId": "plate", "geometry": step("plate_hole.step"), "defeature": { "maxFeatureSize": 4.0 } }],
        "targets": [{ "key": "C", "entityId": "plate", "facesNear": [[0.0, 10.0, 2.0]] }],
        "controls": { "order": 1, "globalSize": 5.0, "refinements": [] }
    });
    let response = run(&request);
    assert_eq!(response["ok"], true, "{response}");
    assert_eq!(response["defeatured"][0]["entityId"], "plate");
    assert_eq!(response["defeatured"][0]["faces"].as_array().unwrap().len(), 1);
    let xyz = coords(&response);
    assert!(xyz.values().any(|p| (p[0] - 10.0).abs() < 2.0 && (p[1] - 10.0).abs() < 2.0), "nodes fill the former hole");
}

#[test]
fn meshes_a_midsurface_into_oriented_quad_shells() {
    let request = |order: i64| {
        json!({
            "op": "mesh",
            "lengthScale": 1.0,
            "parts": [{ "entityId": "wall", "geometry": { "kind": "midsurface", "element": "shell", "thickness": 1.0,
                "faces": [{ "outer": [[0, 0, 0], [20, 0, 0], [20, 10, 0], [0, 10, 0]], "normal": [0, 0, 1] }] } }],
            "targets": [
                { "key": "E", "entityId": "wall", "edgesNear": [[0, 5, 0]] },
                { "key": "P", "entityId": "wall", "facesNear": [[10, 5, 0.4]] }
            ],
            "controls": { "order": order, "elementFamily": "shell_quad", "globalSize": 2.5, "refinements": [] }
        })
    };
    let response = run(&request(1));
    assert_eq!(response["ok"], true, "{response}");
    assert_eq!(response["blocks"].as_array().unwrap().len(), 1, "all quads");
    assert_eq!(response["blocks"][0]["type"], "S4");
    let xyz = coords(&response);
    assert!(ids(&response["nodeSets"]["E"]).iter().all(|n| xyz[n][0].abs() < 1e-12));
    let faces = response["faceSets"]["P"].as_array().unwrap();
    assert_eq!(faces.len(), elements(&response, 0).len(), "every element of the pressed face");
    assert!(faces.iter().all(|f| f[1] == 1), "the point is on the +normal side");
    for element in elements(&response, 0) {
        let n: Vec<[f64; 3]> = ids(element)[1..].iter().map(|id| xyz[id]).collect();
        let z = (n[1][0] - n[0][0]) * (n[2][1] - n[0][1]) - (n[1][1] - n[0][1]) * (n[2][0] - n[0][0]);
        assert!(z > 0.0, "corner normal along +z");
    }
    let quadratic = run(&request(2));
    assert_eq!(quadratic["blocks"][0]["type"], "S8");
    // the edge set holds every element node on x = 0, the quarter-point mid nodes of the split edge segments included
    let xyz = coords(&quadratic);
    let on_edge: HashSet<u64> =
        elements(&quadratic, 0).iter().flat_map(|e| ids(e)[1..].to_vec()).filter(|n| xyz[n][0].abs() < 1e-12).collect();
    assert_eq!(ids(&quadratic["nodeSets"]["E"]).into_iter().collect::<HashSet<_>>(), on_edge);
}

/// Element and node counts within 25 % of the reference counts for the same request (the previous mesher, measured 2026-10-22;
/// docs/decisions/NG1-netgen-mesher.md).
fn assert_counts_near(response: &Value, reference_elements: usize, reference_nodes: usize) {
    assert_eq!(response["ok"], true, "{response}");
    let elements: usize = response["blocks"].as_array().unwrap().iter().map(|b| b["elements"].as_array().unwrap().len()).sum();
    let nodes = response["nodes"].as_array().unwrap().len();
    for (count, reference) in [(elements, reference_elements), (nodes, reference_nodes)] {
        let ratio = count as f64 / reference as f64;
        assert!((0.75..=1.25).contains(&ratio), "{count} vs reference {reference} ({ratio:.2})");
    }
}

#[test]
fn counts_stay_near_the_reference_for_a_curved_solid_and_a_quad_shell() {
    let plate = json!({
        "op": "mesh", "lengthScale": 1.0,
        "parts": [{ "entityId": "p", "geometry": step("plate_hole.step") }],
        "targets": [{ "key": "C", "entityId": "p", "facesNear": [[0.0, 10.0, 2.0]] }],
        "controls": { "order": 2, "globalSize": 1.0, "refinements": [] }
    });
    assert_counts_near(&run(&plate), 15451, 25756);
    let wall = json!({
        "op": "mesh", "lengthScale": 1.0,
        "parts": [{ "entityId": "w", "geometry": { "kind": "midsurface", "element": "shell", "thickness": 1.0,
            "faces": [{ "outer": [[0, 0, 0], [40, 0, 0], [40, 20, 0], [0, 20, 0]], "normal": [0, 0, 1] }] } }],
        "targets": [{ "key": "E", "entityId": "w", "edgesNear": [[0, 10, 0]] }],
        "controls": { "order": 1, "elementFamily": "shell_quad", "globalSize": 1.0, "refinements": [] }
    });
    assert_counts_near(&run(&wall), 3200, 3321);
}

#[test]
fn a_target_off_the_part_is_unresolved() {
    let mut request = box_request(1);
    request["targets"] = json!([{ "key": "C_far", "entityId": "box-1", "facesNear": [[0.0, 5.0, 500.0]] }]);
    let response = run(&request);
    assert_eq!(response["ok"], false);
    assert_eq!(response["code"], "FEA_TARGET_UNRESOLVED");
    assert!(response["error"].as_str().unwrap().starts_with("target C_far: no face of 'box-1' within"), "{response}");
}

#[test]
fn a_point_between_two_faces_is_ambiguous() {
    let mut request = box_request(1);
    request["targets"] = json!([{ "key": "C_edge", "entityId": "box-1", "facesNear": [[0.0, 0.0, 5.0]] }]);
    assert_eq!(run(&request)["code"], "FEA_TARGET_AMBIGUOUS");
}

#[test]
fn a_malformed_request_is_an_error_response() {
    let response = run(&json!({ "op": "mesh", "parts": [] }));
    assert_eq!(response["ok"], false);
    let response = run(&json!("not a request"));
    assert_eq!(response["ok"], false);
}

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

/// The mesh is ONE conformal model across every cut: no coincident nodes, every node on a cut plane x = c used by tets on both sides, and the
/// tets joined through shared nodes into a single component. `cuts` = the x coordinates of the imprinted planes (empty: only the generic checks).
fn assert_conformal(response: &Value, cuts: &[f64]) {
    let xyz = coords(response);
    let mut seen: HashMap<[i64; 3], u64> = HashMap::new();
    for (id, p) in &xyz {
        let key = p.map(|c| (c * 1e9).round() as i64);
        if let Some(other) = seen.insert(key, *id) {
            panic!("nodes {other} and {id} coincide at {p:?}: the mesh is split along a cut");
        }
    }
    let cells = tets(response);
    let centre_x = |cell: &[u64; 4]| cell.iter().map(|n| xyz[n][0]).sum::<f64>() / 4.0;
    for &cut in cuts {
        let corners: HashSet<u64> = cells.iter().flatten().copied().collect();
        let on_cut: HashSet<u64> = corners.iter().filter(|id| (xyz[id][0] - cut).abs() < 1e-9).copied().collect();
        assert!(!on_cut.is_empty(), "no node on the cut x = {cut}");
        let (mut below, mut above): (HashSet<u64>, HashSet<u64>) = (HashSet::new(), HashSet::new());
        for cell in &cells {
            let side = if centre_x(cell) < cut { &mut below } else { &mut above };
            side.extend(cell.iter().filter(|n| on_cut.contains(n)));
        }
        for node in &on_cut {
            assert!(below.contains(node) && above.contains(node), "cut node {node} at x = {cut} is not shared by tets on both sides");
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

fn volumes_are_positive(response: &Value, cuts: &[f64]) {
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
    assert_conformal(&response, &[10.0]);
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
        volumes_are_positive(&response, &[10.0]);
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
    volumes_are_positive(&response, &[10.0]);
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
        volumes_are_positive(&response, &[10.0]);
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
    volumes_are_positive(&response, &[5.0, 15.0]);
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
        volumes_are_positive(&response, &[10.0]);
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

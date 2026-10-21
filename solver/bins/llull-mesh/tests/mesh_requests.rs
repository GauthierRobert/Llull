//! `llull-mesh` end to end: requests on stdin, the response line on stdout. Meshing tests skip (with a note) when no Gmsh library
//! loads; the parity with the Python mesher it replaces is checked on the server's FE suites (same request, identical response).

use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};

fn run(request: &Value, gmsh_lib: Option<&str>) -> Value {
    let mut command = Command::new(env!("CARGO_BIN_EXE_llull-mesh"));
    if let Some(lib) = gmsh_lib {
        command.env("LLULL_GMSH_LIB", lib);
    }
    let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    child.stdin.take().unwrap().write_all(request.to_string().as_bytes()).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let stdout = String::from_utf8(output.stdout).unwrap();
    serde_json::from_str(stdout.lines().rfind(|line| !line.trim().is_empty()).unwrap()).unwrap()
}

fn gmsh_available() -> bool {
    let output = Command::new(env!("CARGO_BIN_EXE_llull-mesh")).arg("--version").output().unwrap();
    let line = String::from_utf8_lossy(&output.stdout).to_string();
    if line.contains("no Gmsh") {
        eprintln!("skipped: {line}");
        return false;
    }
    true
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
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(data)
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

fn node_x(response: &Value) -> std::collections::HashMap<u64, f64> {
    response["nodes"].as_array().unwrap().iter().map(|n| (n[0].as_u64().unwrap(), n[1].as_f64().unwrap())).collect()
}

#[test]
fn meshes_a_box_into_quadratic_tets_with_target_sets_in_the_analysis_unit() {
    if !gmsh_available() {
        return;
    }
    let response = run(&box_request(2), None);
    assert_eq!(response["ok"], true, "{response}");
    assert_eq!(response["mesher"], "gmsh");
    let blocks = response["blocks"].as_array().unwrap();
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0]["type"], "C3D10");
    let elements = blocks[0]["elements"].as_array().unwrap();
    assert!(elements.iter().all(|e| e.as_array().unwrap().len() == 11));
    let ids: Vec<u64> = response["nodes"].as_array().unwrap().iter().map(|n| n[0].as_u64().unwrap()).collect();
    assert_eq!(ids, (1..=ids.len() as u64).collect::<Vec<_>>(), "node ids are contiguous from 1");
    let x = node_x(&response);
    let fixed = response["nodeSets"]["C_fix"].as_array().unwrap();
    assert!(!fixed.is_empty());
    assert!(fixed.iter().all(|n| x[&n.as_u64().unwrap()].abs() < 1e-12), "C_fix lies on x = 0");
    assert!(response["nodeSets"]["L_end"].as_array().unwrap().iter().all(|n| (x[&n.as_u64().unwrap()] - 0.02).abs() < 1e-7));
    let faces = response["faceSets"]["L_end"].as_array().unwrap();
    assert!(!faces.is_empty() && faces.iter().all(|f| (1..=4).contains(&f[1].as_i64().unwrap())));
    assert_eq!(response["nodeSets"]["P_tip"].as_array().unwrap().len(), 1);
    assert!(response["targets"]["P_tip"]["residual"].as_f64().unwrap() < 1e-7);
}

#[test]
fn the_same_request_gives_the_same_mesh() {
    if !gmsh_available() {
        return;
    }
    assert_eq!(run(&box_request(1), None), run(&box_request(1), None));
}

#[test]
fn meshes_a_midsurface_into_oriented_quad_shells() {
    if !gmsh_available() {
        return;
    }
    let request = json!({
        "op": "mesh",
        "lengthScale": 1.0,
        "parts": [{ "entityId": "wall", "geometry": { "kind": "midsurface", "element": "shell", "thickness": 1.0,
            "faces": [{ "outer": [[0, 0, 0], [20, 0, 0], [20, 10, 0], [0, 10, 0]], "normal": [0, 0, 1] }] } }],
        "targets": [
            { "key": "E", "entityId": "wall", "edgesNear": [[0, 5, 0]] },
            { "key": "P", "entityId": "wall", "facesNear": [[10, 5, 0.4]] }
        ],
        "controls": { "order": 1, "elementFamily": "shell_quad", "globalSize": 2.5, "refinements": [] }
    });
    let response = run(&request, None);
    assert_eq!(response["ok"], true, "{response}");
    assert_eq!(response["blocks"][0]["type"], "S4");
    let x = node_x(&response);
    assert!(response["nodeSets"]["E"].as_array().unwrap().iter().all(|n| x[&n.as_u64().unwrap()].abs() < 1e-12));
    let faces = response["faceSets"]["P"].as_array().unwrap();
    assert_eq!(faces.len(), response["blocks"][0]["elements"].as_array().unwrap().len(), "every element of the pressed face");
    assert!(faces.iter().all(|f| f[1] == 1), "the point is on the +normal side");
}

#[test]
fn a_target_off_the_part_is_unresolved() {
    if !gmsh_available() {
        return;
    }
    let mut request = box_request(1);
    request["targets"] = json!([{ "key": "C_far", "entityId": "box-1", "facesNear": [[0.0, 5.0, 500.0]] }]);
    let response = run(&request, None);
    assert_eq!(response["ok"], false);
    assert_eq!(response["code"], "FEA_TARGET_UNRESOLVED");
    assert!(response["error"].as_str().unwrap().starts_with("target C_far: no face of 'box-1' within"), "{response}");
}

#[test]
fn a_missing_gmsh_library_is_fea_tool_missing() {
    let response = run(&box_request(1), Some("/nonexistent/libgmsh.so"));
    assert_eq!(response["ok"], false);
    assert_eq!(response["code"], "FEA_TOOL_MISSING");
    assert!(response["error"].as_str().unwrap().contains("/nonexistent/libgmsh.so"), "{response}");
}

#[test]
fn a_malformed_request_is_an_error_response() {
    let response = run(&json!({ "op": "mesh", "parts": [] }), Some("/nonexistent/libgmsh.so"));
    assert_eq!(response["ok"], false);
    let response = run(&json!("not a request"), None);
    assert_eq!(response["ok"], false);
}

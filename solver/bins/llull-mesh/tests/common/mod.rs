//! Helpers shared by the `llull-mesh` request suites (each suite uses a subset).
#![allow(dead_code)]

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::process::{Command, Stdio};

pub fn run(request: &Value) -> Value {
    let mut child =
        Command::new(env!("CARGO_BIN_EXE_llull-mesh")).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    child.stdin.take().unwrap().write_all(request.to_string().as_bytes()).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let stdout = String::from_utf8(output.stdout).unwrap();
    serde_json::from_str(stdout.lines().rfind(|line| !line.trim().is_empty()).unwrap()).unwrap()
}

pub fn base64(data: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(data)
}

pub fn step(name: &str) -> Value {
    let path = format!("{}/../../crates/llull-netgen/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    json!({ "kind": "step", "stepBase64": base64(&std::fs::read(path).unwrap()) })
}

/// Binary STL of the box [0, a] x [0, b] x [0, c], outward facets.
pub fn box_stl(a: f32, b: f32, c: f32) -> String {
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

pub fn box_request(order: i64) -> Value {
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

pub fn coords(response: &Value) -> HashMap<u64, [f64; 3]> {
    response["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| (n[0].as_u64().unwrap(), [n[1].as_f64().unwrap(), n[2].as_f64().unwrap(), n[3].as_f64().unwrap()]))
        .collect()
}

pub fn ids(set: &Value) -> Vec<u64> {
    set.as_array().unwrap().iter().map(|n| n.as_u64().unwrap()).collect()
}

pub fn elements(response: &Value, block: usize) -> &Vec<Value> {
    response["blocks"][block]["elements"].as_array().unwrap()
}

//! Results of the TypeScript mesh engine (the oracle of VC-MSH-32), pinned for the ops ported in DES-7c step 7 (remesh, analyze): the SHA-256 of the result positions
//! (`result_positions.f64`) followed by the indices (`result_indices.u32`), the whole `report` of `report.json` and, for `analyze`, its `analysis`, from `data/ts_pins.json`.
//! `native:check` runs cargo only, so these pins keep the bit-identity of the Rust code testable where the server suite does not run;
//! `server/tests/meshopsNative.test.ts` is the live comparison.
//!
//! How to regenerate `data/ts_pins.json` (after a deliberate change of a TypeScript op, or to add a case below):
//!   1. `LLULL_PIN_DIR=<empty dir> cargo test --release -p llull-meshops --test ts_pins -- --ignored write_pin_inputs` writes one folder per pin
//!      (`job.json`, `positions.f64`, `indices.u32`);
//!   2. `LLULL_PIN_DIR=<that dir> LLULL_PIN_WRITE=<repo>/solver/crates/llull-meshops/tests/data/ts_pins.json npx vitest run tests/meshopsPinsRegen.test.ts`
//!      (in `server/`) runs the TypeScript engine on those folders and writes the file.
//!
//! A mismatch is either a bug of the Rust twin or a change of the TypeScript op that the twin must follow: never edit the file by hand.

mod common;

use common::*;
use llull_meshops::run;
use llull_protocol::sha256_hex;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

struct Pin {
    name: &'static str,
    mesh: Mesh,
    job: Value,
}

fn wavy(x: f64, y: f64) -> f64 {
    0.4 * (x / 1.5).sin() * (y / 2.0).cos()
}

/// A ridge along x = 5: the two halves meet at about 77 degrees.
fn ridge(x: f64, _y: f64) -> f64 {
    0.8 * (x - 5.0).abs()
}

fn remesh(extra: Value) -> Value {
    let mut params = json!({ "iterations": 3, "featureAngleRad": 40f64.to_radians(), "preserveBoundary": true, "project": true });
    params.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    json!({ "op": "remesh", "params": params })
}

fn analyze(extra: Value) -> Value {
    let mut params = json!({ "maxListed": 20, "weldTolerance": 0, "selfIntersections": false });
    params.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    json!({ "op": "analyze", "params": params })
}

/// `parts` meshes side by side (one shell each, shifted along x by `gap`).
fn side_by_side(parts: &[Mesh], gap: f64) -> Mesh {
    let (mut positions, mut indices) = (Vec::new(), Vec::new());
    for (k, part) in parts.iter().enumerate() {
        let offset = (positions.len() / 3) as u32;
        positions.extend(part.0.chunks_exact(3).flat_map(|p| [p[0] + gap * k as f64, p[1], p[2]]));
        indices.extend(part.1.iter().map(|v| v + offset));
    }
    (positions, indices)
}

/// A sphere as an unwelded soup (three vertices per face), a flipped face, a dropped face and a repeated face.
fn damaged_sphere() -> Mesh {
    let (positions, indices) = sphere(3, 0.05, 21);
    let mut faces: Vec<[u32; 3]> = indices.chunks_exact(3).map(|t| [t[0], t[1], t[2]]).collect();
    faces[10].swap(1, 2);
    faces.remove(40);
    faces.push(faces[100]);
    faces.push([faces[7][0], faces[7][0], faces[7][1]]);
    let soup_positions = faces
        .iter()
        .flatten()
        .flat_map(|&v| [positions[v as usize * 3], positions[v as usize * 3 + 1], positions[v as usize * 3 + 2]])
        .collect();
    (soup_positions, (0..faces.len() as u32 * 3).collect())
}

fn pins() -> Vec<Pin> {
    vec![
        Pin { name: "remesh_sphere_split", mesh: sphere(3, 0.05, 7), job: remesh(json!({ "targetEdge": 0.9 })) },
        Pin { name: "remesh_sphere_merge", mesh: sphere(4, 0.05, 11), job: remesh(json!({ "targetEdge": 2.5, "iterations": 4 })) },
        Pin {
            name: "remesh_adaptive",
            mesh: sphere(3, 0.02, 5),
            job: remesh(json!({ "minEdge": 0.5, "maxEdge": 3.0, "approxError": 0.02 })),
        },
        Pin {
            name: "remesh_region",
            mesh: sphere(3, 0.0, 1),
            job: remesh(json!({ "targetEdge": 0.6, "region": { "center": [0.0, 0.0, 10.0], "radius": 3.0 } })),
        },
        Pin { name: "remesh_ridge", mesh: grid(10, ridge, &[]), job: remesh(json!({ "targetEdge": 0.7 })) },
        Pin { name: "analyze_sphere", mesh: sphere(4, 0.1, 3), job: analyze(json!({})) },
        Pin { name: "analyze_open_with_holes", mesh: grid(16, wavy, &[(3, 3), (4, 3), (10, 12)]), job: analyze(json!({ "maxListed": 2 })) },
        Pin {
            name: "analyze_two_shells",
            mesh: side_by_side(&[sphere(2, 0.0, 1), sphere(3, 0.2, 2)], 30.0),
            job: analyze(json!({ "maxListed": 1 })),
        },
        Pin { name: "analyze_damaged_soup", mesh: damaged_sphere(), job: analyze(json!({})) },
        Pin {
            name: "remesh_free_boundary",
            mesh: grid(16, wavy, &[(3, 3), (10, 12)]),
            job: remesh(json!({ "targetEdge": 1.2, "preserveBoundary": false, "project": false })),
        },
    ]
}

/// JSON equality with numbers compared as numbers (JavaScript writes 1 where Rust writes 1.0).
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(key, p)| y.get(key).is_some_and(|q| same(p, q))),
        _ => a == b,
    }
}

fn write_inputs(dir: &Path, pin: &Pin) {
    fs::create_dir_all(dir).unwrap();
    write_job(dir, &pin.job, &pin.mesh);
}

#[test]
fn the_results_are_the_ones_of_the_typescript_engine() {
    let expected: Value = serde_json::from_str(include_str!("data/ts_pins.json")).unwrap();
    for pin in pins() {
        let dir = folder(&format!("pin-{}", pin.name));
        write_inputs(&dir, &pin);
        run(&dir, &mut std::io::sink()).unwrap();
        let mut stream = fs::read(dir.join("result_positions.f64")).unwrap_or_default();
        stream.extend(fs::read(dir.join("result_indices.u32")).unwrap_or_default());
        let report: Value = serde_json::from_slice(&fs::read(dir.join("report.json")).unwrap()).unwrap();
        let pinned = &expected[pin.name];
        let digest = if stream.is_empty() { Value::Null } else { json!(sha256_hex(&stream)) };
        assert_eq!(pinned["digest"], digest, "{}: result bytes", pin.name);
        if pin.job["op"] == "analyze" {
            assert!(
                same(&pinned["analysis"], &report["analysis"]),
                "{}: analysis {} against {}",
                pin.name,
                pinned["analysis"],
                report["analysis"]
            );
        }
        assert!(same(&pinned["report"], &report["report"]), "{}: report {} against {}", pin.name, pinned["report"], report["report"]);
    }
}

#[test]
#[ignore = "writes the pin inputs to $LLULL_PIN_DIR for the TypeScript engine (see the module doc)"]
fn write_pin_inputs() {
    let dir = std::env::var("LLULL_PIN_DIR").expect("set LLULL_PIN_DIR to an empty folder");
    for pin in pins() {
        write_inputs(&Path::new(&dir).join(pin.name), &pin);
    }
}

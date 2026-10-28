//! Results pinned to the implementation before DES-7c step 5 (versioned lazy queue), which the TypeScript engine matches (VC-MSH-32): the SHA-256 of
//! `result_positions.f64` followed by `result_indices.u32`, and the whole `report` of `report.json`.
//!
//! The `fan` pin is the one deliberately different from the 33e29917 output: the same bytes, but `stoppedBy` is `"target"` where that build said
//! `"exhausted"` (TECHNICAL_SPEC 13.10.2: `stoppedBy` follows the final state).
//!
//! How the pins were made: `llull-compute` built at commit 33e29917 (`cargo build --release -p llull-compute` in `solver/`), run as
//! `llull-compute meshops <folder>` on the folders `LLULL_PIN_DIR=<dir> cargo test -p llull-meshops --test decimate_pins -- --ignored write_pin_inputs`
//! writes (one folder per pin: `positions.f64`, `indices.u32`, `job.json`), then `sha256sum result_positions.f64 result_indices.u32` joined as one
//! stream. The ignored test lets anyone redo that against any build of the old code.

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
    digest: &'static str,
    report: &'static str,
}

fn wavy(x: f64, y: f64) -> f64 {
    0.4 * (x / 1.5).sin() * (y / 2.0).cos()
}

const HOLES: [(usize, usize); 3] = [(3, 3), (4, 3), (10, 12)];

fn decimation(params: Value) -> Value {
    json!({ "op": "decimate", "params": params })
}

fn pins() -> Vec<Pin> {
    vec![
        Pin {
            name: "sphere",
            mesh: sphere(4, 0.1, 42),
            job: decimation(json!({ "targetTriangles": 700, "preserveBoundary": true })),
            digest: "97e025be8a6c05c9bec857685cc3659b1273dfcdd2640643380ec350da6440d7",
            report: r#"{"collapses":2210,"maxCollapseCost":0.6493267107762222,"reachedTarget":true,"rejected":{"deviation":0,"foldOver":8,"link":1},"stoppedBy":"target","trianglesAfter":700,"trianglesBefore":5120}"#,
        },
        Pin {
            name: "holes",
            mesh: grid(16, wavy, &HOLES),
            job: decimation(json!({ "targetTriangles": 120, "preserveBoundary": true, "featureAngleRad": 0.95f64.acos() })),
            digest: "f4d01d56d2d3c69d9a4c31cdf9dad51c03f229f8b4088f0b6ae25f2bfd5f4bfe",
            report: r#"{"collapses":193,"maxCollapseCost":0.06552360778777455,"reachedTarget":true,"rejected":{"deviation":0,"foldOver":1,"link":0},"stoppedBy":"target","trianglesAfter":120,"trianglesBefore":506}"#,
        },
        Pin {
            name: "bounded",
            mesh: sphere(3, 0.05, 7),
            job: decimation(json!({ "maxDeviation": 0.15, "preserveBoundary": true })),
            digest: "09a41cd8ebe9693ee3dcca0634727e24119564abcdc9315b45e1cd4d84ce2f15",
            report: r#"{"collapses":487,"maxCollapseCost":0.6530971745060015,"reachedTarget":null,"rejected":{"deviation":605,"foldOver":2,"link":0},"stoppedBy":"deviation_or_validity","trianglesAfter":306,"trianglesBefore":1280}"#,
        },
        Pin {
            name: "free",
            mesh: grid(16, wavy, &HOLES),
            job: decimation(json!({ "targetTriangles": 60, "preserveBoundary": false })),
            digest: "bfe2b74be7c5b7c20cdac4621aaf7d532732d6eb1c0b75ee90164ca44d7a704c",
            report: r#"{"collapses":249,"maxCollapseCost":0.16992737379536038,"reachedTarget":true,"rejected":{"deviation":0,"foldOver":0,"link":0},"stoppedBy":"target","trianglesAfter":60,"trianglesBefore":506}"#,
        },
        // a concave flat fan: the one collapse reaches the target and leaves nothing valid
        Pin {
            name: "fan",
            mesh: (
                vec![0.0, -0.1, 0.0, 3.0, -1.0, 0.0, 4.0, 1.0, 0.0, 3.0, 2.0, 0.0, -3.0, 2.0, 0.0, -4.0, 1.0, 0.0, 0.0, 0.0, 0.0],
                vec![0, 1, 2, 0, 2, 3, 0, 3, 6, 0, 6, 4, 0, 4, 5, 0, 5, 1],
            ),
            job: decimation(json!({ "targetTriangles": 4, "preserveBoundary": true })),
            digest: "cfa75cf05370ed1ee54a156cfe276a3320447cd95aac2e9ab34baa78bd244011",
            report: r#"{"collapses":1,"maxCollapseCost":0.0,"reachedTarget":true,"rejected":{"deviation":0,"foldOver":5,"link":0},"stoppedBy":"target","trianglesAfter":4,"trianglesBefore":6}"#,
        },
        // every cost is 0: the order is the vertex ids alone
        Pin {
            name: "flat",
            mesh: grid(16, |_, _| 0.0, &[]),
            job: decimation(json!({ "targetTriangles": 40, "preserveBoundary": false })),
            digest: "2f1a7c832d8e405aa6e66fa7148e5797015a300d0bf18ebdd70a3a092b223329",
            report: r#"{"collapses":251,"maxCollapseCost":0.0,"reachedTarget":true,"rejected":{"deviation":0,"foldOver":0,"link":0},"stoppedBy":"target","trianglesAfter":40,"trianglesBefore":512}"#,
        },
        Pin {
            name: "locked_region",
            mesh: sphere(3, 0.05, 9),
            job: decimation(
                json!({ "targetTriangles": 200, "preserveBoundary": true, "lockedRegion": { "center": [0.0, 0.0, 10.0], "radius": 5.0 } }),
            ),
            digest: "06b37f4e8c9190be4174243b1509e7c5a479ee398b6a60eb95ce1163f3b895aa",
            report: r#"{"collapses":540,"maxCollapseCost":3.4281017810380945,"reachedTarget":true,"rejected":{"deviation":0,"foldOver":0,"link":0},"stoppedBy":"target","trianglesAfter":200,"trianglesBefore":1280}"#,
        },
        Pin {
            name: "bound_and_target",
            mesh: sphere(4, 0.05, 5),
            job: decimation(json!({ "targetTriangles": 800, "maxDeviation": 0.3, "preserveBoundary": false })),
            digest: "021f27068e986a6e344cb3e02f214563180116fd329d5b106b8524cc565bab52",
            report: r#"{"collapses":2160,"maxCollapseCost":0.15510197048661212,"reachedTarget":true,"rejected":{"deviation":172,"foldOver":7,"link":0},"stoppedBy":"target","trianglesAfter":800,"trianglesBefore":5120}"#,
        },
    ]
}

fn write_inputs(dir: &Path, pin: &Pin) {
    fs::create_dir_all(dir).unwrap();
    fs::write(dir.join("job.json"), pin.job.to_string()).unwrap();
    fs::write(dir.join("positions.f64"), pin.mesh.0.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>()).unwrap();
    fs::write(dir.join("indices.u32"), pin.mesh.1.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>()).unwrap();
}

#[test]
fn the_results_are_the_ones_of_the_previous_implementation() {
    for pin in pins() {
        let dir = std::env::temp_dir().join(format!("llull-meshops-pin-{}-{}", pin.name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        write_inputs(&dir, &pin);
        run(&dir, &mut std::io::sink()).unwrap();
        let mut stream = fs::read(dir.join("result_positions.f64")).unwrap();
        stream.extend(fs::read(dir.join("result_indices.u32")).unwrap());
        let report: Value = serde_json::from_slice(&fs::read(dir.join("report.json")).unwrap()).unwrap();
        assert_eq!((sha256_hex(&stream).as_str(), report["report"].to_string().as_str()), (pin.digest, pin.report), "{}", pin.name);
    }
}

#[test]
#[ignore = "writes the pin inputs to $LLULL_PIN_DIR for a run of the old binary (see the module doc)"]
fn write_pin_inputs() {
    let dir = std::env::var("LLULL_PIN_DIR").expect("set LLULL_PIN_DIR to an empty folder");
    for pin in pins() {
        write_inputs(&Path::new(&dir).join(pin.name), &pin);
    }
}

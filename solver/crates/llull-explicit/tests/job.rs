//! The `llull-compute explicit` job folder contract: inputs read, outputs written with their sha256, events, refusals.

use llull_explicit::job::run_job;
use llull_protocol::sha256_hex;
use std::fs;
use std::path::{Path, PathBuf};

fn folder(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("llull-explicit-test-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("temp folder");
    dir
}

fn f64_bytes(values: &[f64]) -> Vec<u8> {
    values.iter().flat_map(|value| value.to_le_bytes()).collect()
}

fn u32_bytes(values: &[u32]) -> Vec<u8> {
    values.iter().flat_map(|value| value.to_le_bytes()).collect()
}

/// One 10 mm steel cube 1 mm above a floor at 1 m/s.
fn write_job(dir: &Path, job: serde_json::Value) {
    let unit = [[0., 0., 0.], [1., 0., 0.], [1., 1., 0.], [0., 1., 0.], [0., 0., 1.], [1., 0., 1.], [1., 1., 1.], [0., 1., 1.]];
    let nodes: Vec<f64> = unit.iter().flat_map(|p| [10.0 * p[0], 10.0 * p[1], 1.0 + 10.0 * p[2]]).collect();
    fs::write(dir.join("nodes.f64"), f64_bytes(&nodes)).expect("write");
    fs::write(dir.join("hex8.u32"), u32_bytes(&[0, 1, 2, 3, 4, 5, 6, 7])).expect("write");
    fs::write(dir.join("elmat.u32"), u32_bytes(&[0])).expect("write");
    fs::write(dir.join("velocity.f64"), f64_bytes(&[0.0, 0.0, -1000.0].repeat(8))).expect("write");
    fs::write(dir.join("job.json"), job.to_string()).expect("write");
}

fn job(device: &str) -> serde_json::Value {
    serde_json::json!({
        "version": 1, "nodes": "nodes.f64", "hex8": "hex8.u32", "elementMaterial": "elmat.u32", "initialVelocity": "velocity.f64",
        "materials": [{ "density": 7.85e-9, "youngsModulus": 200000.0, "poisson": 0.3 }],
        "gravity": [0.0, 0.0, -9806.65],
        "walls": [{ "name": "floor", "point": [0.0, 0.0, 0.0], "normal": [0.0, 0.0, 2.0] }],
        "controls": { "endTime": 2e-3, "historyInterval": 1e-4, "timeStepScale": 0.9, "hourglassCoefficient": 0.1,
                      "bulkLinear": 0.06, "bulkQuadratic": 1.5, "maxCycles": 100000 },
        "device": device
    })
}

#[test]
fn writes_hashed_outputs_events_and_is_byte_identical() {
    let mut hashes = Vec::new();
    for round in 0..3 {
        let dir = folder(&format!("ok{round}"));
        write_job(&dir, job(if round == 2 { "gpu" } else { "cpu" }));
        let mut events = Vec::new();
        let outputs = run_job(&dir, &mut events).expect("the job runs");
        let text = String::from_utf8(events).expect("utf8");
        assert!(text.lines().any(|line| line.contains("\"type\":\"progress\"") && line.contains("\"cycle\"")));
        assert_eq!(outputs.iter().map(|output| output.path.as_str()).collect::<Vec<_>>(), ["fields.f64", "result.json"]);
        for output in &outputs {
            assert_eq!(sha256_hex(&fs::read(dir.join(&output.path)).expect("read")), output.sha256);
        }
        let result: serde_json::Value = serde_json::from_slice(&fs::read(dir.join("result.json")).expect("read")).expect("json");
        assert_eq!(result["termination"], "normal");
        // A GPU request runs the kernels (device gpu) or falls back to the CPU twin with EXP_GPU_FALLBACK; CPU runs never warn.
        let fell_back = text.contains("EXP_GPU_FALLBACK");
        assert_eq!(fell_back, round == 2 && result["device"] == "cpu");
        assert_eq!(result["device"] == "gpu", round == 2 && !fell_back);
        assert_eq!(result["elements"]["hex8"], 1);
        assert_eq!(result["walls"][0]["name"], "floor");
        assert_eq!(fs::read(dir.join("fields.f64")).expect("read").len(), 6 * 8);
        // The cube reaches the floor after ~1 ms and the wall records a force.
        let peak = result["walls"][0]["force"].as_array().expect("forces").iter().filter_map(|f| f.as_f64()).fold(0.0, f64::max);
        assert!(peak > 0.0);
        if round < 2 {
            hashes.push(outputs.iter().map(|output| output.sha256.clone()).collect::<Vec<_>>());
        }
        let _ = fs::remove_dir_all(&dir);
    }
    assert_eq!(hashes[0], hashes[1]);
}

#[test]
fn refuses_malformed_jobs() {
    let cases = [
        ("version", serde_json::json!({ "version": 2 })),
        ("missing", serde_json::json!({ "nodes": "absent.f64" })),
        ("index", serde_json::json!({ "elementMaterial": "velocity.f64" })),
        ("wall", serde_json::json!({ "walls": [{ "name": "w", "point": [0.0, 0.0, 0.0], "normal": [0.0, 0.0, 0.0] }] })),
        (
            "controls",
            serde_json::json!({ "controls": { "endTime": 1.0, "historyInterval": 2.0, "timeStepScale": 0.9,
            "hourglassCoefficient": 0.1, "bulkLinear": 0.06, "bulkQuadratic": 1.5 } }),
        ),
        ("material", serde_json::json!({ "materials": [{ "density": 1.0, "youngsModulus": 1.0, "poisson": 0.5 }] })),
        ("path", serde_json::json!({ "nodes": "../nodes.f64" })),
        ("unknown", serde_json::json!({ "extra": 1 })),
    ];
    for (name, patch) in cases {
        let dir = folder(name);
        let mut spec = job("cpu");
        for (key, value) in patch.as_object().expect("object") {
            spec[key] = value.clone();
        }
        write_job(&dir, spec);
        let error = run_job(&dir, &mut Vec::new()).expect_err(name);
        assert!(error.code == "NATIVE_JOB_INPUT" || error.code == "NATIVE_JOB_IO", "{name}: {}", error.code);
        let _ = fs::remove_dir_all(&dir);
    }
}

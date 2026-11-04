//! `llull-compute bvh` job contract (VIS-M8e): the written arrays equal the TypeScript tree of the fixture, hashes are reported, and
//! every malformed folder is refused with a stable code.

use llull_bvh::job::run;
use llull_protocol::sha256_hex;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

fn folder(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("llull-bvh-job-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn f64_bytes(values: &[f64]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
}

fn job(dir: &Path, manifest: &str, boxes: &[u8]) {
    fs::write(dir.join("job.json"), manifest).unwrap();
    fs::write(dir.join("boxes.f64"), boxes).unwrap();
}

fn floats(value: &Value) -> Vec<f64> {
    value.as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect()
}

fn ints(value: &Value) -> Vec<i64> {
    value.as_array().unwrap().iter().map(|v| v.as_i64().unwrap()).collect()
}

fn read_u32(dir: &Path, name: &str) -> Vec<i64> {
    fs::read(dir.join(name)).unwrap().chunks_exact(4).map(|b| i64::from(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))).collect()
}

#[test]
fn outputs_equal_the_typescript_tree_and_are_hashed() {
    let text = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/instance_bvh.json")).unwrap();
    for case in serde_json::from_str::<Value>(&text).unwrap().as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let boxes = floats(&case["boxes"]);
        let dir = folder(name);
        job(&dir, &format!(r#"{{"version":1,"op":"build","count":{}}}"#, boxes.len() / 6), &f64_bytes(&boxes));
        let outputs = run(&dir).unwrap();
        assert_eq!(outputs.len(), 6, "{name}");
        for output in &outputs {
            assert_eq!(output.sha256, sha256_hex(&fs::read(dir.join(&output.path)).unwrap()), "{name}: {}", output.path);
        }
        assert_eq!(read_u32(&dir, "order.u32"), ints(&case["order"]), "{name}: order");
        assert_eq!(read_u32(&dir, "nodeStart.u32"), ints(&case["nodeStart"]), "{name}: nodeStart");
        assert_eq!(read_u32(&dir, "nodeEnd.u32"), ints(&case["nodeEnd"]), "{name}: nodeEnd");
        let children: Vec<i64> = fs::read(dir.join("nodeChild.i32"))
            .unwrap()
            .chunks_exact(4)
            .map(|b| i64::from(i32::from_le_bytes([b[0], b[1], b[2], b[3]])))
            .collect();
        assert_eq!(children, ints(&case["nodeChild"]), "{name}: nodeChild");
        let node_box: Vec<f64> =
            fs::read(dir.join("nodeBox.f64")).unwrap().chunks_exact(8).map(|b| f64::from_le_bytes(b.try_into().unwrap())).collect();
        assert_eq!(node_box, floats(&case["nodeBox"]), "{name}: nodeBox");
        let report: Value = serde_json::from_slice(&fs::read(dir.join("report.json")).unwrap()).unwrap();
        assert_eq!(report["count"].as_u64().unwrap() as usize, boxes.len() / 6, "{name}");
        assert_eq!(report["nodeCount"].as_u64().unwrap() as usize, ints(&case["nodeStart"]).len(), "{name}");
        let _ = fs::remove_dir_all(&dir);
    }
}

fn refusal(name: &str, manifest: &str, boxes: &[u8]) -> (&'static str, String) {
    let dir = folder(name);
    job(&dir, manifest, boxes);
    let error = run(&dir).unwrap_err();
    let _ = fs::remove_dir_all(&dir);
    (error.code, error.message)
}

#[test]
fn malformed_folders_are_refused_with_stable_codes() {
    let one = f64_bytes(&[0.0, 0.0, 0.0, 1.0, 1.0, 1.0]);
    let (code, message) = refusal("version", r#"{"version":2,"op":"build","count":1}"#, &one);
    assert_eq!((code, message.contains("version 2")), ("NATIVE_JOB_INPUT", true));
    let (code, message) = refusal("op", r#"{"version":1,"op":"query","count":1}"#, &one);
    assert_eq!((code, message.contains("'query'")), ("NATIVE_JOB_INPUT", true));
    let (code, message) = refusal("count", r#"{"version":1,"op":"build","count":2}"#, &one);
    assert_eq!((code, message.contains("need 96")), ("NATIVE_JOB_INPUT", true));
    let (code, _) = refusal("huge", r#"{"version":1,"op":"build","count":4294967296}"#, &one);
    assert_eq!(code, "NATIVE_JOB_INPUT");
    let (code, _) = refusal("unknown", r#"{"version":1,"op":"build","count":1,"bins":8}"#, &one);
    assert_eq!(code, "NATIVE_JOB_INPUT");
    let (code, _) = refusal("syntax", "not json", &one);
    assert_eq!(code, "NATIVE_JOB_INPUT");
    let (code, message) = refusal("nan", r#"{"version":1,"op":"build","count":1}"#, &f64_bytes(&[0.0, 0.0, 0.0, f64::NAN, 1.0, 1.0]));
    assert_eq!((code, message.contains("box 0")), ("NATIVE_JOB_INPUT", true));
    let (code, _) = refusal("ragged", r#"{"version":1,"op":"build","count":1}"#, &one[..47]);
    assert_eq!(code, "NATIVE_JOB_INPUT");
}

#[test]
fn a_missing_file_is_an_io_error_and_zero_boxes_build_an_empty_tree() {
    let dir = folder("missing");
    assert_eq!(run(&dir).unwrap_err().code, "NATIVE_JOB_IO");
    fs::write(dir.join("job.json"), r#"{"version":1,"op":"build","count":0}"#).unwrap();
    assert_eq!(run(&dir).unwrap_err().code, "NATIVE_JOB_IO");
    fs::write(dir.join("boxes.f64"), []).unwrap();
    run(&dir).unwrap();
    assert!(fs::read(dir.join("nodeBox.f64")).unwrap().is_empty());
    let _ = fs::remove_dir_all(&dir);
}

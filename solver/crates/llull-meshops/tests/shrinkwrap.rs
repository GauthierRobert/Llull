//! The `shrinkwrap` job (DES-7c native twins, 13.20): what it refuses (so the host falls through to the TypeScript engine), what it keeps (connectivity, the target), and the
//! geometry the TypeScript-pinned cases do not name (a wrap onto a plane is exact, a reach leaves vertices where they are). The bytes against the TypeScript engine are `ts_pins.rs`.

mod common;

use common::*;
use llull_meshops::run;
use serde_json::{json, Value};
use std::fs;

fn plane(z: f64) -> Mesh {
    grid(8, |_, _| z, &[])
}

fn job(params: Value, mesh: &Mesh, target: &Mesh, name: &str) -> (std::path::PathBuf, Result<(), String>) {
    let dir = folder(name);
    write_job(&dir, &json!({ "op": "shrinkwrap", "params": params }), mesh);
    fs::write(dir.join("positions_b.f64"), target.0.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>()).unwrap();
    fs::write(dir.join("indices_b.u32"), target.1.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>()).unwrap();
    let outcome = run(&dir, &mut std::io::sink()).map(|_| ()).map_err(|error| format!("{}: {}", error.code, error.message));
    (dir, outcome)
}

fn params(extra: Value) -> Value {
    let mut base = json!({ "mode": "nearest", "offset": 0.0, "side": "keep" });
    base.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    base
}

#[test]
fn a_wrap_onto_a_plane_is_exact_and_keeps_the_triangles() {
    let source = grid(8, |x, y| 0.3 * (x + y).sin(), &[]);
    let (dir, outcome) = job(params(json!({})), &source, &plane(-2.0), "wrap-plane");
    outcome.unwrap();
    let ((positions, indices), report) = read_result(&dir);
    assert_eq!(indices, source.1);
    assert!(positions.chunks_exact(3).all(|p| p[2] == -2.0), "every vertex is on the plane");
    assert_eq!(report["report"]["missed"], 0);
    assert_eq!(report["report"]["moved"], 81);
    assert_eq!(report["report"]["residual"], 0.0);
}

#[test]
fn a_reach_leaves_the_far_vertices_where_they_are() {
    let source = grid(8, |x, _| if x < 5.0 { 0.2 } else { 3.0 }, &[]);
    let (dir, outcome) = job(params(json!({ "maxDistance": 1.0 })), &source, &plane(0.0), "wrap-reach");
    outcome.unwrap();
    let ((positions, _), report) = read_result(&dir);
    let far = source.0.chunks_exact(3).filter(|p| p[2] == 3.0).count();
    assert!(far > 0 && report["report"]["missed"] == far);
    assert!(positions.chunks_exact(3).zip(source.0.chunks_exact(3)).all(|(after, before)| if before[2] == 3.0 {
        after == before
    } else {
        after[2] == 0.0
    }));
}

#[test]
fn what_the_job_does_not_take_is_refused_as_native_job_input() {
    let source = grid(4, |_, _| 0.0, &[]);
    let empty: Mesh = (vec![], vec![]);
    let cases: Vec<(&str, Value, &Mesh, &str)> = vec![
        ("a target without triangles", params(json!({})), &empty, "needs a target with triangles"),
        ("a negative offset", params(json!({ "offset": -0.5 })), &source, "offset must be a number from 0"),
        ("an offset that is not finite", params(json!({ "offset": 1e300 })), &source, "offset must be a number from 0"),
        ("a reach of 0", params(json!({ "maxDistance": 0.0 })), &source, "maxDistance must be positive"),
        (
            "a direction past 1e100",
            params(json!({ "mode": "direction", "direction": [1e101, 0.0, 0.0] })),
            &source,
            "direction must be finite",
        ),
        ("an unknown mode", params(json!({ "mode": "project" })), &source, "shrinkwrap params"),
        ("an unknown side", params(json!({ "side": "above" })), &source, "shrinkwrap params"),
    ];
    for (label, p, target, expected) in cases {
        let (_, outcome) = job(p, &source, target, "wrap-refused");
        let message = outcome.expect_err(label);
        assert!(message.starts_with("NATIVE_JOB_INPUT"), "{label}: {message}");
        assert!(message.contains(expected), "{label}: {message}");
    }
    // coordinates beyond 1e100 in the mesh or the target
    let huge = (source.0.iter().map(|v| v * 1e101).collect::<Vec<f64>>(), source.1.clone());
    for (label, mesh, target) in [("the mesh", &huge, &source), ("the target", &source, &huge)] {
        let (_, outcome) = job(params(json!({})), mesh, target, "wrap-huge");
        let message = outcome.expect_err(label);
        assert!(message.contains("finite coordinates below 1e100"), "{label}: {message}");
    }
}

//! Job-level tests of `llull-meshops`: the bit-identity with the TypeScript engine is proven by `server/tests/meshopsNative.test.ts`; these cover
//! the job contract and the geometric properties (area kept on planes, volume kept by the correction, refusals) on small meshes.

use llull_meshops::run;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

fn folder(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("llull-meshops-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_job(dir: &Path, job: &Value, positions: &[f64], indices: &[u32]) {
    fs::write(dir.join("job.json"), job.to_string()).unwrap();
    fs::write(dir.join("positions.f64"), positions.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>()).unwrap();
    fs::write(dir.join("indices.u32"), indices.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>()).unwrap();
}

fn read_result(dir: &Path) -> (Vec<f64>, Vec<u32>, Value) {
    let positions =
        fs::read(dir.join("result_positions.f64")).unwrap().chunks_exact(8).map(|b| f64::from_le_bytes(b.try_into().unwrap())).collect();
    let indices =
        fs::read(dir.join("result_indices.u32")).unwrap().chunks_exact(4).map(|b| u32::from_le_bytes(b.try_into().unwrap())).collect();
    let report: Value = serde_json::from_slice(&fs::read(dir.join("report.json")).unwrap()).unwrap();
    (positions, indices, report)
}

/// Grid of `n` x `n` cells on [0, 10]^2, two triangles per cell, wound +Z; `z` gives the height.
fn grid(n: usize, z: impl Fn(f64, f64) -> f64) -> (Vec<f64>, Vec<u32>) {
    let h = 10.0 / n as f64;
    let mut positions = Vec::new();
    for j in 0..=n {
        for i in 0..=n {
            let (x, y) = (i as f64 * h, j as f64 * h);
            positions.extend([x, y, z(x, y)]);
        }
    }
    let id = |i: usize, j: usize| (j * (n + 1) + i) as u32;
    let mut indices = Vec::new();
    for j in 0..n {
        for i in 0..n {
            indices.extend([id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j), id(i + 1, j + 1), id(i, j + 1)]);
        }
    }
    (positions, indices)
}

fn area(positions: &[f64], indices: &[u32]) -> f64 {
    indices
        .chunks_exact(3)
        .map(|t| {
            let p = |v: u32| [positions[v as usize * 3], positions[v as usize * 3 + 1], positions[v as usize * 3 + 2]];
            let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
            let (u, v) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
            let cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
            (cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2]).sqrt() / 2.0
        })
        .sum()
}

fn octahedron() -> (Vec<f64>, Vec<u32>) {
    let positions = vec![1.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, -1.0];
    let indices = vec![0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5];
    (positions, indices)
}

#[test]
fn decimating_a_flat_grid_keeps_the_area_and_stops_at_the_locked_boundary() {
    let dir = folder("flat");
    let (positions, indices) = grid(12, |_, _| 0.0);
    write_job(&dir, &json!({ "op": "decimate", "params": { "targetTriangles": 40, "preserveBoundary": true } }), &positions, &indices);
    let outputs = run(&dir, &mut std::io::sink()).unwrap();
    assert_eq!(outputs.len(), 3);
    let (out_positions, out_indices, report) = read_result(&dir);
    assert!((area(&out_positions, &out_indices) - 100.0).abs() < 1e-9);
    assert_eq!(report["report"]["reachedTarget"], json!(false));
    assert_eq!(report["report"]["trianglesBefore"], json!(288));
    assert_eq!(report["report"]["trianglesAfter"], json!(out_indices.len() / 3));
    assert!(out_indices.len() / 3 <= 48);
    assert_eq!(report["items"], json!(288));
}

#[test]
fn decimate_honours_a_target_a_deviation_bound_features_and_a_locked_region() {
    let (positions, indices) = grid(12, |x, y| (x / 2.0).sin() * (y / 3.0).cos());
    let dir = folder("bound");
    write_job(
        &dir,
        &json!({ "op": "decimate", "params": { "maxDeviation": 0.05, "preserveBoundary": false, "featureCos": 0.9, "lockedRegion": { "center": [5.0, 5.0, 0.0], "radius": 2.0 } } }),
        &positions,
        &indices,
    );
    run(&dir, &mut std::io::sink()).unwrap();
    let (_, out_indices, report) = read_result(&dir);
    assert!(out_indices.len() < indices.len());
    assert!(report["report"]["collapses"].as_u64().unwrap() > 0);
    assert!(matches!(report["report"]["stoppedBy"].as_str(), Some("deviation_or_validity" | "exhausted")));
}

#[test]
fn smoothing_with_volume_correction_keeps_the_volume_of_a_closed_mesh() {
    let (positions, indices) = octahedron();
    let dir = folder("smooth");
    let params = json!({ "taubin": false, "lambda": 0.5, "passBand": 0.1, "iterations": 3, "cotangent": false, "fixBoundary": true, "volumeCorrection": true });
    write_job(&dir, &json!({ "op": "smooth", "params": params }), &positions, &indices);
    run(&dir, &mut std::io::sink()).unwrap();
    let (out_positions, out_indices, report) = read_result(&dir);
    assert_eq!(out_indices, indices);
    assert_eq!(report["report"]["volumeCorrected"], json!(true));
    let (before, after) = (report["report"]["volumeBefore"].as_f64().unwrap(), report["report"]["volumeAfter"].as_f64().unwrap());
    assert!((before - 4.0 / 3.0).abs() < 1e-12);
    assert!((after - before).abs() / before < 1e-12);
    assert!(out_positions != positions);
    assert!(report["report"]["mu"].is_null());
}

#[test]
fn smoothing_variants_run_on_an_open_patch() {
    let (positions, indices) = grid(6, |x, y| 0.1 * (x * y).sin());
    for (name, taubin, cotangent, fix) in [("taubin", true, false, true), ("cotangent", false, true, false)] {
        let dir = folder(name);
        let params = json!({
            "taubin": taubin, "lambda": 0.6307, "passBand": 0.1, "iterations": 4, "cotangent": cotangent,
            "fixBoundary": fix, "volumeCorrection": true, "region": { "center": [5.0, 5.0, 0.0], "radius": 4.0 }
        });
        write_job(&dir, &json!({ "op": "smooth", "params": params }), &positions, &indices);
        run(&dir, &mut std::io::sink()).unwrap();
        let (_, _, report) = read_result(&dir);
        assert_eq!(report["report"]["volumeCorrected"], json!(false));
        assert!(report["report"]["maxDisplacement"].as_f64().unwrap() >= 0.0);
        assert_eq!(report["report"]["mu"].is_number(), taubin);
    }
}

#[test]
fn jobs_refuse_bad_input_with_stable_codes() {
    let (positions, indices) = octahedron();
    let dir = folder("bad");
    write_job(&dir, &json!({ "op": "wrap", "params": {} }), &positions, &indices);
    assert_eq!(run(&dir, &mut std::io::sink()).unwrap_err().code, "NATIVE_JOB_INPUT");
    write_job(&dir, &json!({ "op": "decimate", "params": { "preserveBoundary": true } }), &positions, &[0, 1, 99, 0, 1, 2]);
    assert!(run(&dir, &mut std::io::sink()).unwrap_err().message.contains("not below"));
    let mut nan = positions.clone();
    nan[0] = f64::NAN;
    write_job(&dir, &json!({ "op": "decimate", "params": { "preserveBoundary": true } }), &nan, &indices);
    assert!(run(&dir, &mut std::io::sink()).unwrap_err().message.contains("non-finite"));
    write_job(&dir, &json!({ "op": "decimate", "params": {} }), &positions, &indices);
    assert_eq!(run(&dir, &mut std::io::sink()).unwrap_err().code, "NATIVE_JOB_INPUT");
    fs::write(dir.join("positions.f64"), [0u8; 7]).unwrap();
    assert!(run(&dir, &mut std::io::sink()).unwrap_err().message.contains("whole number"));
    fs::remove_file(dir.join("job.json")).unwrap();
    assert_eq!(run(&dir, &mut std::io::sink()).unwrap_err().code, "NATIVE_JOB_IO");
}

#[test]
fn deviation_of_parallel_grids_is_the_offset_both_ways() {
    let (positions, indices) = grid(8, |_, _| 0.0);
    let lifted: Vec<f64> = positions.iter().enumerate().map(|(i, v)| if i % 3 == 2 { v + 0.5 } else { *v }).collect();
    let dir = folder("deviation");
    write_job(&dir, &json!({ "op": "deviation", "params": { "maxSamples": 20000 } }), &positions, &indices);
    fs::write(dir.join("positions_b.f64"), lifted.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>()).unwrap();
    fs::write(dir.join("indices_b.u32"), indices.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>()).unwrap();
    let outputs = run(&dir, &mut std::io::sink()).unwrap();
    assert_eq!(outputs.len(), 1);
    let report: Value = serde_json::from_slice(&fs::read(dir.join("report.json")).unwrap()).unwrap();
    let d = &report["report"];
    for key in ["forwardMax", "backwardMax", "hausdorff", "mean", "rms"] {
        assert!((d[key].as_f64().unwrap() - 0.5).abs() < 1e-12, "{key}");
    }
    assert_eq!(d["worst"]["distance"], json!(0.5));
    assert_eq!(d["histogram"][9], d["samples"]);
    // an empty second mesh is refused
    fs::write(dir.join("indices_b.u32"), []).unwrap();
    assert!(run(&dir, &mut std::io::sink()).unwrap_err().message.contains("without triangles"));
}

fn events(bytes: &[u8]) -> Vec<Value> {
    String::from_utf8(bytes.to_vec()).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
}

#[test]
fn every_op_reports_read_then_its_stage_then_write_with_rising_fractions() {
    let (positions, indices) = grid(40, |x, y| (x / 2.0).sin() * (y / 3.0).cos());
    let smooth = json!({ "taubin": false, "lambda": 0.5, "passBand": 0.1, "iterations": 3, "cotangent": false, "fixBoundary": true, "volumeCorrection": false });
    for (name, job, stage) in [
        ("progress-decimate", json!({ "op": "decimate", "params": { "targetTriangles": 200, "preserveBoundary": true } }), "decimate"),
        ("progress-smooth", json!({ "op": "smooth", "params": smooth }), "smooth"),
        ("progress-deviation", json!({ "op": "deviation", "params": { "maxSamples": 1000 } }), "deviation"),
    ] {
        let dir = folder(name);
        write_job(&dir, &job, &positions, &indices);
        if stage == "deviation" {
            fs::write(dir.join("positions_b.f64"), fs::read(dir.join("positions.f64")).unwrap()).unwrap();
            fs::write(dir.join("indices_b.u32"), fs::read(dir.join("indices.u32")).unwrap()).unwrap();
        }
        let mut out = Vec::new();
        run(&dir, &mut out).unwrap();
        let seen = events(&out);
        let stages: Vec<&str> = seen.iter().filter_map(|e| e["stage"].as_str()).collect();
        assert_eq!(stages.first(), Some(&"read"), "{name}");
        assert_eq!(stages.last(), Some(&"write"), "{name}");
        assert!(stages.contains(&stage), "{name}: {stages:?}");
        assert!(seen.iter().all(|e| e["type"] == "progress" && e["total"] == json!(3) && e["elapsedMs"].is_u64()), "{name}");
        let fractions: Vec<f64> = seen.iter().map(|e| e["fraction"].as_f64().unwrap()).collect();
        assert!(
            fractions.windows(2).all(|pair| pair[0] <= pair[1]) && fractions.iter().all(|f| (0.0..=1.0).contains(f)),
            "{name}: {fractions:?}"
        );
    }
}

#[test]
fn a_failed_job_has_only_progress_events_before_its_error() {
    let (positions, indices) = octahedron();
    let dir = folder("progress-bad");
    write_job(&dir, &json!({ "op": "wrap", "params": {} }), &positions, &indices);
    let mut out = Vec::new();
    assert_eq!(run(&dir, &mut out).unwrap_err().code, "NATIVE_JOB_INPUT");
    assert!(events(&out).iter().all(|e| e["type"] == "progress"));
}

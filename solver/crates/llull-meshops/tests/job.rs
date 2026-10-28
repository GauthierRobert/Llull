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
        &json!({ "op": "decimate", "params": { "maxDeviation": 0.05, "preserveBoundary": false, "featureAngleRad": 0.9f64.acos(), "lockedRegion": { "center": [5.0, 5.0, 0.0], "radius": 2.0 } } }),
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

/// The `deviation` report of a job that also measured it, the same pair measured by a separate `deviation` job, and the stages the first reported.
fn measured_with_and_without(name: &str, job: Value, positions: &[f64], indices: &[u32]) -> (Value, Value, Vec<String>) {
    let mut with = job.clone();
    with["deviationSamples"] = json!(2000);
    let dir = folder(&format!("{name}-with"));
    write_job(&dir, &with, positions, indices);
    let mut out = Vec::new();
    run(&dir, &mut out).unwrap();
    let (result_positions, result_indices, report) = read_result(&dir);
    let stages = events(&out).iter().filter_map(|e| e["stage"].as_str().map(str::to_string)).collect();
    let second = separate_deviation(name, positions, indices, &result_positions, &result_indices, 2000);
    (report["deviation"].clone(), second, stages)
}

fn separate_deviation(
    name: &str,
    positions: &[f64],
    indices: &[u32],
    other_positions: &[f64],
    other_indices: &[u32],
    samples: usize,
) -> Value {
    let separate = folder(&format!("{name}-separate"));
    write_job(&separate, &json!({ "op": "deviation", "params": { "maxSamples": samples } }), positions, indices);
    fs::write(separate.join("positions_b.f64"), other_positions.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>()).unwrap();
    fs::write(separate.join("indices_b.u32"), other_indices.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>()).unwrap();
    run(&separate, &mut std::io::sink()).unwrap();
    read_report(&separate)["report"].clone()
}

#[test]
fn decimate_and_smooth_measure_their_own_deviation_exactly_as_the_separate_job_would() {
    let (positions, indices) = grid(30, |x, y| (x / 2.0).sin() * (y / 3.0).cos());
    let smooth = json!({ "taubin": false, "lambda": 0.5, "passBand": 0.1, "iterations": 3, "cotangent": false, "fixBoundary": true, "volumeCorrection": false });
    for (name, job) in [
        ("dev-decimate", json!({ "op": "decimate", "params": { "targetTriangles": 300, "preserveBoundary": true } })),
        ("dev-smooth", json!({ "op": "smooth", "params": smooth })),
    ] {
        let (together, separate, stages) = measured_with_and_without(name, job, &positions, &indices);
        assert!(together["hausdorff"].as_f64().unwrap() > 0.0, "{name}");
        assert_eq!(together, separate, "{name}: one job gives the deviation of the separate one");
        assert_eq!(stages.last().map(String::as_str), Some("write"), "{name}");
        assert_eq!(stages.iter().rev().nth(1).map(String::as_str), Some("deviation"), "{name}: {stages:?}");
    }
}

#[test]
fn a_job_without_deviation_samples_reports_no_deviation_and_the_deviation_op_ignores_them() {
    let (positions, indices) = grid(10, |_, _| 0.0);
    let dir = folder("dev-absent");
    write_job(&dir, &json!({ "op": "decimate", "params": { "targetTriangles": 50, "preserveBoundary": true } }), &positions, &indices);
    run(&dir, &mut std::io::sink()).unwrap();
    assert!(read_result(&dir).2.get("deviation").is_none());
    let both = folder("dev-op");
    write_job(&both, &json!({ "op": "deviation", "params": { "maxSamples": 100 }, "deviationSamples": 100 }), &positions, &indices);
    fs::write(both.join("positions_b.f64"), fs::read(both.join("positions.f64")).unwrap()).unwrap();
    fs::write(both.join("indices_b.u32"), fs::read(both.join("indices.u32")).unwrap()).unwrap();
    run(&both, &mut std::io::sink()).unwrap();
    assert!(read_report(&both).get("deviation").is_none());
}

/// Icosphere of radius 10 (subdivided `level` times), outward-wound.
#[cfg(feature = "quad")]
fn icosphere(level: usize) -> (Vec<f64>, Vec<u32>) {
    let t = (1.0 + 5.0f64.sqrt()) / 2.0;
    let mut positions: Vec<[f64; 3]> = vec![
        [-1.0, t, 0.0],
        [1.0, t, 0.0],
        [-1.0, -t, 0.0],
        [1.0, -t, 0.0],
        [0.0, -1.0, t],
        [0.0, 1.0, t],
        [0.0, -1.0, -t],
        [0.0, 1.0, -t],
        [t, 0.0, -1.0],
        [t, 0.0, 1.0],
        [-t, 0.0, -1.0],
        [-t, 0.0, 1.0],
    ];
    let mut faces: Vec<[u32; 3]> = vec![
        [0, 11, 5],
        [0, 5, 1],
        [0, 1, 7],
        [0, 7, 10],
        [0, 10, 11],
        [1, 5, 9],
        [5, 11, 4],
        [11, 10, 2],
        [10, 7, 6],
        [7, 1, 8],
        [3, 9, 4],
        [3, 4, 2],
        [3, 2, 6],
        [3, 6, 8],
        [3, 8, 9],
        [4, 9, 5],
        [2, 4, 11],
        [6, 2, 10],
        [8, 6, 7],
        [9, 8, 1],
    ];
    for _ in 0..level {
        let mut cache = std::collections::HashMap::new();
        let mut next = Vec::new();
        let mut midpoint = |a: u32, b: u32, positions: &mut Vec<[f64; 3]>| -> u32 {
            *cache.entry((a.min(b), a.max(b))).or_insert_with(|| {
                let (p, q) = (positions[a as usize], positions[b as usize]);
                positions.push([(p[0] + q[0]) / 2.0, (p[1] + q[1]) / 2.0, (p[2] + q[2]) / 2.0]);
                positions.len() as u32 - 1
            })
        };
        for f in &faces {
            let (ab, bc, ca) =
                (midpoint(f[0], f[1], &mut positions), midpoint(f[1], f[2], &mut positions), midpoint(f[2], f[0], &mut positions));
            next.extend([[f[0], ab, ca], [f[1], bc, ab], [f[2], ca, bc], [ab, bc, ca]]);
        }
        faces = next;
    }
    let flat = positions
        .iter()
        .flat_map(|p| {
            let n = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt();
            [p[0] / n * 10.0, p[1] / n * 10.0, p[2] / n * 10.0]
        })
        .collect();
    (flat, faces.into_iter().flatten().collect())
}

#[cfg(feature = "quad")]
#[test]
fn quad_remesh_measures_the_outward_triangulated_quads_exactly_as_the_separate_job_on_them_would() {
    use llull_meshops::quad_mesh::{outward_quads, triangulate_quads};
    let (positions, indices) = icosphere(2);
    let job = json!({ "op": "quad_remesh", "params": { "targetFaces": 60, "adaptive": false }, "deviationSamples": 3000 });
    let dir = folder("dev-quad");
    write_job(&dir, &job, &positions, &indices);
    let mut out = Vec::new();
    run(&dir, &mut out).unwrap();
    let (result_positions, quads, report) = read_result(&dir);
    assert_eq!(quads.len() % 4, 0);
    let triangles = triangulate_quads(&result_positions, &outward_quads(&result_positions, &quads));
    let separate = separate_deviation("dev-quad", &positions, &indices, &result_positions, &triangles, 3000);
    assert_eq!(report["deviation"], separate);
    assert!(report["deviation"]["hausdorff"].as_f64().unwrap() < 1.0);
    let stages: Vec<String> = events(&out).iter().filter_map(|e| e["stage"].as_str().map(str::to_string)).collect();
    assert_eq!(stages.last().map(String::as_str), Some("write"));
    assert!(stages.contains(&"deviation".to_string()) && stages.contains(&"fix_valence".to_string()), "{stages:?}");
}

fn read_report(dir: &Path) -> Value {
    serde_json::from_slice(&fs::read(dir.join("report.json")).unwrap()).unwrap()
}

// 20,000 triangles and 10,201 vertices: above the sizes where the closest-point tree builds in parallel (8192) and the set-up scans split (4096 vertices)
#[test]
fn a_decimate_job_with_its_deviation_gives_the_same_files_on_every_run_and_thread_count() {
    let (positions, indices) = grid(100, |x, y| (x / 2.0).sin() * (y / 3.0).cos());
    let job = json!({ "op": "decimate", "params": { "targetTriangles": 500, "preserveBoundary": false }, "deviationSamples": 5000 });
    let files = |name: &str, threads: usize| {
        let dir = folder(name);
        write_job(&dir, &job, &positions, &indices);
        let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).build().unwrap();
        let outputs = pool.install(|| run(&dir, &mut std::io::sink())).unwrap();
        // report.json carries the elapsed milliseconds; the rest of it is compared through the parsed deviation and report
        let report = read_report(&dir);
        let mut digests: Vec<String> = outputs.iter().filter(|o| o.path != "report.json").map(|o| o.sha256.clone()).collect();
        digests.push(format!("{}{}", report["report"], report["deviation"]));
        digests
    };
    let first = files("det-1", 1);
    assert_eq!(first, files("det-1-again", 1));
    assert_eq!(first, files("det-6", 6));
}

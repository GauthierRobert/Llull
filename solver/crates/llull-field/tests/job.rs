//! End-to-end jobs of `llull_field::run` on job folders (the contract of `lib.rs`): mesh, measure, evaluate, refusals and malformed folders.

use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

fn sphere_program() -> Value {
    json!({
        "instructions": [
            {"op": "x", "args": []}, {"op": "y", "args": []}, {"op": "z", "args": []},
            {"op": "square", "args": [0]}, {"op": "square", "args": [1]}, {"op": "square", "args": [2]},
            {"op": "add", "args": [3, 4]}, {"op": "add", "args": [6, 5]}, {"op": "sqrt", "args": [7]},
            {"op": "const", "args": [0]}, {"op": "sub", "args": [8, 9]}
        ],
        "output": 10, "meshes": 0, "strutSets": []
    })
}

fn f64s(values: &[f64]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
}

/// A job folder holding `job` and the radius constant.
fn folder(name: &str, job: &Value) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("llull-field-job-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("constants.f64"), f64s(&[4.0])).unwrap();
    fs::write(dir.join("job.json"), job.to_string()).unwrap();
    dir
}

fn grid() -> Value {
    json!({"min": [-6.0, -6.0, -6.0], "max": [6.0, 6.0, 6.0], "voxel": 0.5})
}

fn report(dir: &std::path::Path) -> Value {
    serde_json::from_slice(&fs::read(dir.join("report.json")).unwrap()).unwrap()
}

fn run_job(dir: &std::path::Path) -> (Vec<llull_protocol::Output>, String) {
    let mut out = Vec::new();
    let outputs = llull_field::run(dir, &mut out).unwrap();
    (outputs, String::from_utf8(out).unwrap())
}

#[test]
fn meshes_a_sphere_into_a_closed_manifold_and_streams_progress() {
    let job = json!({"op": "mesh", "program": sphere_program(), "grid": grid(), "maxSamples": 1u64 << 30, "maxTriangles": 5_000_000});
    let dir = folder("mesh", &job);
    let (outputs, events) = run_job(&dir);
    let names: Vec<&str> = outputs.iter().map(|o| o.path.as_str()).collect();
    assert_eq!(names, ["positions.f64", "indices.u32", "report.json"]);
    let r = report(&dir);
    assert_eq!(r["closedManifold"], true);
    assert_eq!(r["samples"], 25u64.pow(3), "24 cells = 25 nodes per axis");
    assert_eq!(fs::read(dir.join("positions.f64")).unwrap().len() as u64, r["vertices"].as_u64().unwrap() * 24);
    assert_eq!(fs::read(dir.join("indices.u32")).unwrap().len() as u64, r["triangles"].as_u64().unwrap() * 12);
    assert!(r["maxVertexResidual"].as_f64().unwrap() < 0.05);
    assert!(r["prunedFraction"].as_f64().unwrap() > 0.0, "tiles far from the surface are pruned");
    assert!(events.contains("\"type\":\"progress\""), "progress events: {events}");
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn budgets_and_bad_grids_are_refusals_not_failures() {
    let refuse = |name: &str, patch: Value| {
        let mut job =
            json!({"op": "mesh", "program": sphere_program(), "grid": grid(), "maxSamples": 1u64 << 30, "maxTriangles": 5_000_000});
        job.as_object_mut().unwrap().extend(patch.as_object().unwrap().clone());
        let dir = folder(name, &job);
        run_job(&dir);
        let r = report(&dir);
        fs::remove_dir_all(&dir).unwrap();
        r["refusal"].clone()
    };
    assert_eq!(refuse("grid-budget", json!({"maxSamples": 10}))["code"], "IMP_GRID_BUDGET");
    let triangles = refuse("tri-budget", json!({"maxTriangles": 50}));
    assert_eq!(triangles["code"], "IMP_TRIANGLE_BUDGET");
    assert!(triangles["samples"].as_u64().unwrap() > 50);
    let bad = refuse("bad-grid", json!({"grid": {"min": [0.0, 0.0, 0.0], "max": [1.0, 1.0, 1.0], "voxel": 0.0}}));
    assert_eq!(bad["code"], "IMP_ENGINE_FAILED");
    let broken =
        refuse("bad-tape", json!({"program": {"instructions": [{"op": "x", "args": []}], "output": 9, "meshes": 0, "strutSets": []}}));
    assert_eq!(broken["code"], "IMP_ENGINE_FAILED");
    assert!(broken["message"].as_str().unwrap().contains("output register out of range"));
    let components = refuse("comp-budget", json!({"op": "measure", "request": {"kind": "components"}, "maxSamples": 10}));
    assert_eq!(components["code"], "IMP_GRID_BUDGET");
}

#[test]
fn measures_volume_quantiles_and_components() {
    let measure = |name: &str, request: Value, region: Option<Value>| {
        let mut job = json!({"op": "measure", "program": sphere_program(), "grid": grid(), "maxSamples": 1u64 << 30, "request": request});
        if let Some(r) = region {
            job["region"] = r;
        }
        let dir = folder(name, &job);
        if job.get("region").is_some() {
            fs::write(dir.join("region_constants.f64"), f64s(&[2.0])).unwrap();
        }
        run_job(&dir);
        let r = report(&dir);
        fs::remove_dir_all(&dir).unwrap();
        r
    };
    let sphere_volume = 4.0 / 3.0 * std::f64::consts::PI * 64.0;
    let v = measure("vol", json!({"kind": "volume", "sampling": "midpoint"}), None);
    assert!((v["volume"].as_f64().unwrap() - sphere_volume).abs() / sphere_volume < 0.02);
    assert_eq!(v["regionVolume"].as_f64().unwrap(), 12.0 * 12.0 * 12.0);
    let ld = measure("ld", json!({"kind": "volume", "sampling": "lowdiscrepancy"}), None);
    assert!((ld["volume"].as_f64().unwrap() - sphere_volume).abs() / sphere_volume < 0.03);
    let clipped = measure("clip", json!({"kind": "volume", "sampling": "midpoint"}), Some(sphere_program()));
    let ball2 = 4.0 / 3.0 * std::f64::consts::PI * 8.0;
    assert!((clipped["volume"].as_f64().unwrap() - ball2).abs() / ball2 < 0.05, "clipped to the radius-2 ball");
    let q = measure("quantile", json!({"kind": "quantile", "probabilities": [0.0, 1.0], "absolute": false}), None);
    assert!(q["values"][0].as_f64().unwrap() < -3.5 && q["values"][1].as_f64().unwrap() > 5.0);
    let c = measure("components", json!({"kind": "components"}), None);
    assert_eq!(c["solids"].as_array().unwrap().len(), 1);
    assert_eq!(c["voids"].as_array().unwrap().len(), 1);
    assert_eq!(c["voids"][0]["enclosed"], false);
    let missing = {
        let job = json!({"op": "measure", "program": sphere_program(), "grid": grid(), "maxSamples": 1u64 << 30});
        let dir = folder("no-request", &job);
        run_job(&dir);
        let r = report(&dir);
        fs::remove_dir_all(&dir).unwrap();
        r
    };
    assert_eq!(missing["refusal"]["code"], "IMP_ENGINE_FAILED");
}

#[test]
fn evaluates_points_and_counts_non_finite_values() {
    let job = json!({"op": "evaluate", "program": sphere_program(), "points": 3});
    let dir = folder("evaluate", &job);
    fs::write(dir.join("points.f64"), f64s(&[4.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 6.0, 8.0])).unwrap();
    run_job(&dir);
    let values: Vec<f64> =
        fs::read(dir.join("values.f64")).unwrap().chunks_exact(8).map(|b| f64::from_le_bytes(b.try_into().unwrap())).collect();
    assert_eq!(values, vec![0.0, -4.0, 6.0]);
    assert_eq!(report(&dir)["nonFiniteSamples"], 0);
    fs::write(dir.join("points.f64"), f64s(&[f64::NAN, 0.0, 0.0])).unwrap();
    fs::write(dir.join("job.json"), json!({"op": "evaluate", "program": sphere_program(), "points": 1}).to_string()).unwrap();
    run_job(&dir);
    assert_eq!(report(&dir)["nonFiniteSamples"], 1);
    fs::write(dir.join("job.json"), json!({"op": "evaluate", "program": sphere_program(), "points": 5}).to_string()).unwrap();
    assert_eq!(llull_field::run(&dir, &mut Vec::new()).unwrap_err().code, "NATIVE_JOB_INPUT");
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn malformed_folders_are_job_errors() {
    let dir = std::env::temp_dir().join(format!("llull-field-job-{}-empty", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    assert_eq!(llull_field::run(&dir, &mut Vec::new()).unwrap_err().code, "NATIVE_JOB_IO");
    fs::write(dir.join("job.json"), "{ not json").unwrap();
    assert_eq!(llull_field::run(&dir, &mut Vec::new()).unwrap_err().code, "NATIVE_JOB_INPUT");
    fs::remove_dir_all(&dir).unwrap();
    let job = json!({"op": "wobble", "program": sphere_program()});
    let dir = folder("unknown-op", &job);
    let error = llull_field::run(&dir, &mut Vec::new()).unwrap_err();
    assert_eq!((error.code, error.message.contains("unknown field op")), ("NATIVE_JOB_INPUT", true));
    let job = json!({"op": "mesh", "program": sphere_program(), "maxSamples": 100});
    fs::write(dir.join("job.json"), job.to_string()).unwrap();
    assert!(llull_field::run(&dir, &mut Vec::new()).unwrap_err().message.contains("grid is missing"));
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn measures_the_node_sign_grid_for_thickness_analyses() {
    let job = json!({"op": "measure", "program": sphere_program(), "grid": grid(), "maxSamples": 1u64 << 30, "request": {"kind": "nodes"}});
    let dir = folder("nodes", &job);
    let (outputs, _) = run_job(&dir);
    assert!(outputs.iter().any(|o| o.path == "nodes.u8"));
    let flags = fs::read(dir.join("nodes.u8")).unwrap();
    assert_eq!(flags.len(), 25 * 25 * 25);
    let inside = flags.iter().filter(|&&f| f == 1).count();
    let expected = 4.0 / 3.0 * std::f64::consts::PI * 64.0 / 0.125;
    assert!((inside as f64 - expected).abs() / expected < 0.05, "{inside} inside nodes vs {expected}");
    assert!(flags.iter().all(|&f| f <= 1));
    assert_eq!(report(&dir)["nodes"], json!([25, 25, 25]));
    let refused = folder(
        "nodes-budget",
        &json!({"op": "measure", "program": sphere_program(), "grid": grid(), "maxSamples": 10, "request": {"kind": "nodes"}}),
    );
    run_job(&refused);
    assert_eq!(report(&refused)["refusal"]["code"], "IMP_GRID_BUDGET");
    fs::remove_dir_all(&dir).unwrap();
    fs::remove_dir_all(&refused).unwrap();
}

fn saddle_program() -> Value {
    json!({
        "instructions": [{"op": "x", "args": []}, {"op": "y", "args": []}, {"op": "mul", "args": [0, 1]}],
        "output": 2, "meshes": 0, "strutSets": []
    })
}

fn dual_job(program: Value, patch: Value) -> Value {
    let mut job = json!({
        "op": "mesh", "program": program, "grid": grid(), "maxSamples": 1u64 << 30, "maxTriangles": 5_000_000,
        "mesher": "dual_contouring", "maxDualContouringSamples": 1u64 << 29
    });
    job.as_object_mut().unwrap().extend(patch.as_object().unwrap().clone());
    job
}

#[test]
fn evaluates_value_and_gradient_when_asked() {
    let job = json!({"op": "evaluate", "program": sphere_program(), "points": 2, "gradient": true});
    let dir = folder("gradient", &job);
    fs::write(dir.join("points.f64"), f64s(&[2.0, 0.0, 0.0, 0.0, 3.0, 0.0])).unwrap();
    let (outputs, _) = run_job(&dir);
    let names: Vec<&str> = outputs.iter().map(|o| o.path.as_str()).collect();
    assert_eq!(names, ["values.f64", "gradients.f64", "report.json"]);
    let read = |name: &str| -> Vec<f64> {
        fs::read(dir.join(name)).unwrap().chunks_exact(8).map(|b| f64::from_le_bytes(b.try_into().unwrap())).collect()
    };
    assert_eq!(read("values.f64"), [-2.0, -1.0]);
    assert_eq!(read("gradients.f64"), [1.0, 0.0, 0.0, 0.0, 1.0, 0.0], "three numbers per point, the unit direction away from the centre");
    let plain = json!({"op": "evaluate", "program": sphere_program(), "points": 2});
    let dir2 = folder("no-gradient", &plain);
    fs::write(dir2.join("points.f64"), f64s(&[2.0, 0.0, 0.0, 0.0, 3.0, 0.0])).unwrap();
    let (outputs, _) = run_job(&dir2);
    assert!(outputs.iter().all(|o| o.path != "gradients.f64"));
    fs::remove_dir_all(&dir).unwrap();
    fs::remove_dir_all(&dir2).unwrap();
}

#[test]
fn dual_contouring_reports_its_mesher_and_streams_progress() {
    let dir = folder("dc", &dual_job(sphere_program(), json!({})));
    let (_, events) = run_job(&dir);
    let r = report(&dir);
    assert_eq!(
        (r["mesher"].as_str(), r["mesherFallback"].as_bool(), r["splitCells"].as_u64()),
        (Some("dual_contouring"), Some(false), Some(0))
    );
    assert_eq!(r["closedManifold"], true);
    assert!(r["triangles"].as_u64().unwrap() > 0);
    assert!(events.contains("\"type\":\"progress\""), "the sign grid reports progress: {events}");
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_dual_contouring_mesh_that_stays_open_falls_back_to_the_tetrahedra_as_a_whole() {
    let dir = folder("dc-fallback", &dual_job(saddle_program(), json!({})));
    run_job(&dir);
    let r = report(&dir);
    assert_eq!((r["mesher"].as_str(), r["mesherFallback"].as_bool(), r["splitCells"].as_u64()), (Some("tetra"), Some(true), Some(0)));
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn dual_contouring_refuses_above_its_cap_by_name_and_above_the_triangle_budget() {
    let refuse = |name: &str, patch: Value| {
        let dir = folder(name, &dual_job(sphere_program(), patch));
        run_job(&dir);
        let r = report(&dir);
        fs::remove_dir_all(&dir).unwrap();
        r["refusal"].clone()
    };
    let capped = refuse("dc-cap", json!({"maxDualContouringSamples": 10}));
    assert_eq!((capped["code"].as_str(), capped["limit"].as_u64()), (Some("IMP_GRID_BUDGET"), Some(10)));
    let message = capped["message"].as_str().unwrap();
    assert!(
        message.contains("dual-contouring limit") && message.contains("mesher tetra") && message.contains("coarser voxel"),
        "{message}"
    );
    let triangles = refuse("dc-tri", json!({"maxTriangles": 50}));
    assert_eq!(triangles["code"], "IMP_TRIANGLE_BUDGET");
    assert!(triangles["samples"].as_u64().unwrap() > 50, "the exact count of the crossed edges, before any datum is computed");
}

//! Job-level behaviour beyond the MBB benchmark: a 3D cantilever that converges, weighted load cases, inactive voxels and
//! keep regions, error codes (`TOP_GRID_TOO_LARGE`, `TOP_SOLVER_FAILED`, `NATIVE_JOB_INPUT`) and the GPU device (run where an
//! adapter exists; otherwise the CPU twin answers with a `TOP_GPU_FALLBACK` warning).

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn folder(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("llull-topopt-cases-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn run(dir: &Path, job: &Value) -> Result<(Value, Vec<f32>, String), (String, String)> {
    std::fs::write(dir.join("job.json"), serde_json::to_vec(job).unwrap()).unwrap();
    let mut events = Vec::new();
    let result = llull_topopt::job::run(dir, &mut events).map_err(|e| (e.code.to_string(), e.message));
    let events = String::from_utf8(events).unwrap();
    result?;
    let result: Value = serde_json::from_slice(&std::fs::read(dir.join("result.json")).unwrap()).unwrap();
    let field =
        std::fs::read(dir.join("field.bin")).unwrap().chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    Ok((result, field, events))
}

/// 3D cantilever: x = 0 face clamped, downward load along the bottom edge of the free end.
fn cantilever(nx: usize, ny: usize, nz: usize, settings: Value) -> Value {
    let fixed: Vec<Value> = (0..=ny).flat_map(|j| (0..=nz).map(move |k| json!({ "node": [0, j, k], "dofs": [0, 1, 2] }))).collect();
    let loads: Vec<Value> = (0..=nz).map(|k| json!({ "node": [nx, 0, k], "force": [0.0, -1.0 / (nz + 1) as f64, 0.0] })).collect();
    json!({
        "version": 1, "dimension": 3, "grid": { "nx": nx, "ny": ny, "nz": nz, "voxel": 2.0 },
        "material": { "e0": 210000.0, "nu": 0.3 }, "volumeFraction": 0.3,
        "fixed": fixed, "loadCases": [{ "name": "tip", "loads": loads }], "settings": settings
    })
}

fn mbb(nx: usize, ny: usize, cases: Value, settings: Value) -> Value {
    let mut fixed: Vec<Value> = (0..=ny).map(|j| json!({ "node": [0, j], "dofs": [0] })).collect();
    fixed.push(json!({ "node": [nx, 0], "dofs": [1] }));
    json!({
        "version": 1, "dimension": 2, "grid": { "nx": nx, "ny": ny }, "material": { "e0": 1.0, "nu": 0.3 },
        "volumeFraction": 0.5, "fixed": fixed, "loadCases": cases, "settings": settings
    })
}

#[test]
fn a_small_3d_cantilever_converges() {
    let dir = folder("cantilever");
    let (result, field, _) =
        run(&dir, &cantilever(16, 8, 4, json!({ "filter": { "kind": "density", "radius": 1.5 }, "maxIterations": 150 }))).unwrap();
    let history = result["history"].as_array().unwrap();
    let first = history[0]["compliance"].as_f64().unwrap();
    let last = result["compliance"].as_f64().unwrap();
    eprintln!("3D cantilever 16x8x4: {} iterations, compliance {first} -> {last}, grey {}", result["iterations"], result["grey"]);
    assert_eq!(result["status"], "converged");
    assert!(last < first, "compliance did not decrease: {first} -> {last}");
    assert!((result["volumeFraction"].as_f64().unwrap() - 0.3).abs() < 1e-3);
    assert_eq!(field.len(), 16 * 8 * 4);
    assert_eq!(result["grid"]["dofs"], 17 * 9 * 5 * 3);
    // material concentrates at the clamped root (top and bottom fibres) rather than at the free end
    let column = |i: usize| (0..8 * 4).map(|jk| f64::from(field[i + 16 * jk])).sum::<f64>();
    assert!(column(0) > column(15), "root {} vs tip {}", column(0), column(15));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn weighted_load_cases_combine_linearly() {
    let tip = json!([{ "node": [0, 10], "force": [0, -1] }]);
    let settings = json!({ "maxIterations": 8 });
    let single = folder("lc-single");
    let (one, _, _) = run(&single, &mbb(30, 10, json!([{ "name": "a", "loads": tip }]), settings.clone())).unwrap();
    let split = folder("lc-split");
    let halves = json!([{ "name": "a", "weight": 0.5, "loads": tip }, { "name": "b", "weight": 0.5, "loads": tip }]);
    let (two, _, _) = run(&split, &mbb(30, 10, halves, settings.clone())).unwrap();
    assert_eq!(std::fs::read(single.join("field.bin")).unwrap(), std::fs::read(split.join("field.bin")).unwrap());
    assert_eq!(one["compliance"], two["compliance"]);
    let other = folder("lc-other");
    let cases = json!([{ "name": "a", "weight": 2.0, "loads": tip }, { "name": "side", "weight": 1.0, "loads": [{ "node": [15, 10], "force": [0.3, -0.5] }] }]);
    let (mixed, _, _) = run(&other, &mbb(30, 10, cases, settings)).unwrap();
    let (a, side) = (mixed["perLoadCase"]["a"].as_f64().unwrap(), mixed["perLoadCase"]["side"].as_f64().unwrap());
    let weighted = mixed["compliance"].as_f64().unwrap();
    assert!((2.0 * a + side - weighted).abs() < 1e-12 * weighted, "{a} {side} {weighted}");
    for dir in [single, split, other] {
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[test]
fn inactive_voxels_and_keep_regions_are_honoured() {
    let (nx, ny) = (30, 10);
    let dir = folder("masks");
    let index = |i: usize, j: usize| i + nx * j;
    let mut active = vec![1u8; nx * ny];
    let mut keep_in = vec![0u8; nx * ny];
    let mut keep_out = vec![0u8; nx * ny];
    for j in 3..7 {
        for i in 12..18 {
            active[index(i, j)] = 0;
        }
    }
    for i in 0..nx {
        keep_in[index(i, ny - 1)] = 1;
    }
    keep_out[index(25, 5)] = 1;
    std::fs::write(dir.join("active.u8"), &active).unwrap();
    std::fs::write(dir.join("in.u8"), &keep_in).unwrap();
    std::fs::write(dir.join("out.u8"), &keep_out).unwrap();
    let mut job = mbb(nx, ny, json!([{ "name": "tip", "loads": [{ "node": [0, 10], "force": [0, -1] }] }]), json!({ "maxIterations": 40 }));
    job["active"] = json!("active.u8");
    job["keepIn"] = json!("in.u8");
    job["keepOut"] = json!("out.u8");
    let (result, field, _) = run(&dir, &job).unwrap();
    assert_eq!(result["grid"]["active"], nx * ny - 24);
    assert_eq!(result["grid"]["keepIn"], nx);
    assert_eq!(result["grid"]["keepOut"], 1);
    for e in 0..nx * ny {
        if active[e] == 0 || keep_out[e] == 1 {
            assert_eq!(field[e], 0.0);
        } else if keep_in[e] == 1 {
            assert_eq!(field[e], 1.0);
        }
    }
    let active_sum: f64 = field.iter().map(|&v| f64::from(v)).sum();
    assert!((active_sum / (nx * ny - 24) as f64 - 0.5).abs() < 2e-3);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn errors_carry_stable_codes() {
    let dir = folder("errors");
    let tip = json!([{ "name": "tip", "loads": [{ "node": [0, 10], "force": [0, -1] }] }]);
    let mut big = mbb(30, 10, tip.clone(), json!({}));
    big["dofCap"] = json!(100);
    assert_eq!(run(&dir, &big).unwrap_err().0, "TOP_GRID_TOO_LARGE");
    let mut huge = cantilever(4, 4, 4, json!({}));
    huge["grid"] = json!({ "nx": 4000, "ny": 4000, "nz": 4000 });
    assert_eq!(run(&dir, &huge).unwrap_err().0, "TOP_GRID_TOO_LARGE");
    let mut floating = mbb(30, 10, tip.clone(), json!({ "maxIterations": 2, "pcgMaxIterations": 200 }));
    floating["fixed"] = json!([]);
    let (code, message) = run(&dir, &floating).unwrap_err();
    assert_eq!(code, "TOP_SOLVER_FAILED", "{message}");
    let mut typo = mbb(30, 10, tip.clone(), json!({}));
    typo["settings"] = json!({ "penalty": 3 });
    assert_eq!(run(&dir, &typo).unwrap_err().0, "NATIVE_JOB_INPUT");
    let outside = mbb(30, 10, json!([{ "name": "tip", "loads": [{ "node": [31, 10], "force": [0, -1] }] }]), json!({}));
    assert_eq!(run(&dir, &outside).unwrap_err().0, "NATIVE_JOB_INPUT");
    let mut fraction = mbb(30, 10, tip, json!({}));
    fraction["volumeFraction"] = json!(1.2);
    assert_eq!(run(&dir, &fraction).unwrap_err().0, "NATIVE_JOB_INPUT");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn gpu_device_matches_the_cpu_twin_or_falls_back_with_a_warning() {
    let tip = json!([{ "name": "tip", "loads": [{ "node": [0, 10], "force": [0, -1] }] }]);
    let cpu_dir = folder("device-cpu");
    let (cpu, _, _) = run(&cpu_dir, &mbb(30, 10, tip.clone(), json!({ "maxIterations": 4 }))).unwrap();
    let gpu_dir = folder("device-gpu");
    let (gpu, _, events) = run(&gpu_dir, &mbb(30, 10, tip, json!({ "maxIterations": 4, "device": "gpu" }))).unwrap();
    if gpu["device"] == "gpu" {
        eprintln!("GPU run on {}", gpu["adapter"]);
        assert_eq!(gpu["deterministic"], false);
        assert_eq!(gpu["precision"], "f32-gpu+f64-refinement");
        let (a, b) = (cpu["compliance"].as_f64().unwrap(), gpu["compliance"].as_f64().unwrap());
        assert!((a - b).abs() / a < 1e-6, "cpu {a} vs gpu {b}");
    } else {
        eprintln!("skipped GPU comparison: {}", gpu["warnings"]);
        assert_eq!(gpu["deterministic"], true);
        assert_eq!(gpu["warnings"][0]["code"], "TOP_GPU_FALLBACK");
        assert!(events.contains(r#""type":"warning","code":"TOP_GPU_FALLBACK""#));
        assert_eq!(std::fs::read(cpu_dir.join("field.bin")).unwrap(), std::fs::read(gpu_dir.join("field.bin")).unwrap());
    }
    let _ = std::fs::remove_dir_all(cpu_dir);
    let _ = std::fs::remove_dir_all(gpu_dir);
}

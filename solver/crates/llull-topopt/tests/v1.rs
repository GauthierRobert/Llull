//! TOP-V1 (TECHNICAL_SPEC §15) through the real job folder: MMA against the OC benchmark, `minVolume`, Heaviside projection,
//! the extrusion constraint, gravity, and the `deadlineS` checkpoint + `startState` resume (bit for bit, OC and MMA).

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn folder(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("llull-topopt-v1-{name}-{}", std::process::id()));
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

/// top88 MBB half beam: ux = 0 on the left edge, uy = 0 at the bottom-right node, unit load down at the top-left node.
fn mbb(nx: usize, ny: usize, settings: Value) -> Value {
    let mut fixed: Vec<Value> = (0..=ny).map(|j| json!({ "node": [0, j], "dofs": [0] })).collect();
    fixed.push(json!({ "node": [nx, 0], "dofs": [1] }));
    json!({
        "version": 1, "dimension": 2, "grid": { "nx": nx, "ny": ny }, "material": { "e0": 1.0, "nu": 0.3 },
        "volumeFraction": 0.5, "fixed": fixed,
        "loadCases": [{ "name": "tip", "loads": [{ "node": [0, ny], "force": [0, -1] }] }], "settings": settings
    })
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

fn files(dir: &Path, names: &[&str]) -> Vec<Vec<u8>> {
    names.iter().map(|name| std::fs::read(dir.join(name)).unwrap()).collect()
}

/// Copies a finished run's outputs into the start files of a continuation and returns the `startX` keys to splice in.
fn start_files(dir: &Path) -> Value {
    for (from, to) in [("design.f64", "start.f64"), ("displacements.f64", "start_u.f64"), ("state.json", "start_state.json")] {
        std::fs::copy(dir.join(from), dir.join(to)).unwrap();
    }
    json!({ "startDesign": "start.f64", "startDisplacements": "start_u.f64", "startState": "start_state.json" })
}

fn with_start(mut job: Value, start: &Value, start_iteration: usize, max_iterations: usize) -> Value {
    for (key, value) in start.as_object().unwrap() {
        job[key] = value.clone();
    }
    job["settings"]["startIteration"] = json!(start_iteration);
    job["settings"]["maxIterations"] = json!(max_iterations);
    job
}

#[test]
fn mma_solves_the_mbb_benchmark_close_to_oc_and_is_deterministic() {
    let oc_dir = folder("mma-oc");
    let (oc, _, _) = run(&oc_dir, &mbb(60, 20, json!({}))).unwrap();
    let dir = folder("mma");
    let (mma, _, _) = run(&dir, &mbb(60, 20, json!({ "optimizer": "mma" }))).unwrap();
    let (c_oc, c_mma) = (oc["compliance"].as_f64().unwrap(), mma["compliance"].as_f64().unwrap());
    eprintln!(
        "MBB 60x20 sensitivity filter: OC {c_oc} in {} iterations, MMA {c_mma} in {} iterations ({}), volume {}, grey {}",
        oc["iterations"], mma["iterations"], mma["status"], mma["volumeFraction"], mma["grey"]
    );
    assert_eq!(mma["optimizer"], "mma");
    assert_eq!(mma["objective"]["kind"], "minCompliance");
    assert_eq!(mma["objective"]["value"], mma["compliance"]);
    assert!((c_mma - c_oc).abs() / c_oc < 0.05, "MMA {c_mma} vs OC {c_oc}");
    assert!(mma["volumeFraction"].as_f64().unwrap() <= 0.5 + 1e-3);
    assert_eq!(mma["constraints"][0]["name"], "volume");
    assert_eq!(mma["constraints"][0]["satisfied"], true);
    assert_eq!(mma["deterministic"], true);
    let state: Value = serde_json::from_slice(&std::fs::read(dir.join("state.json")).unwrap()).unwrap();
    assert_eq!(state["mma"]["file"], "mma.f64");
    assert_eq!(state["mma"]["length"], 4 * 1200);
    assert!(state["objectiveScale"].as_f64().unwrap() > 0.0);
    assert_eq!(std::fs::read(dir.join("mma.f64")).unwrap().len(), 8 * 4 * 1200);
    let again = folder("mma-again");
    run(&again, &mbb(60, 20, json!({ "optimizer": "mma" }))).unwrap();
    assert_eq!(files(&dir, &["field.bin", "design.f64", "mma.f64"]), files(&again, &["field.bin", "design.f64", "mma.f64"]));
    for d in [oc_dir, dir, again] {
        let _ = std::fs::remove_dir_all(d);
    }
}

#[test]
fn min_volume_meets_a_compliance_limit_with_less_material() {
    let reference = folder("minvol-ref");
    let (oc, _, _) = run(&reference, &mbb(30, 10, json!({ "filter": { "kind": "density" } }))).unwrap();
    let limit = 1.5 * oc["compliance"].as_f64().unwrap();
    let dir = folder("minvol");
    let mut job = mbb(30, 10, json!({ "optimizer": "mma", "filter": { "kind": "density" } }));
    job["objective"] = json!({ "kind": "minVolume", "maxCompliance": limit });
    let (result, _, _) = run(&dir, &job).unwrap();
    let (volume, compliance) = (result["volumeFraction"].as_f64().unwrap(), result["compliance"].as_f64().unwrap());
    eprintln!(
        "minVolume: limit {limit}, compliance {compliance}, volume {volume} ({} iterations, {})",
        result["iterations"], result["status"]
    );
    assert_eq!(result["objective"]["kind"], "minVolume");
    assert_eq!(result["objective"]["value"], result["volumeFraction"]);
    assert_eq!(result["constraints"][0]["name"], "compliance");
    assert_eq!(result["constraints"][0]["limit"], limit);
    assert!(compliance <= limit * 1.01, "compliance {compliance} above the limit {limit}");
    assert!(volume < 0.5, "volume {volume} not below the reference 0.5");
    // OC handles one constraint only
    let mut oc_job = mbb(30, 10, json!({ "filter": { "kind": "density" } }));
    oc_job["objective"] = json!({ "kind": "minVolume", "maxCompliance": limit });
    let (code, message) = run(&dir, &oc_job).unwrap_err();
    assert_eq!(code, "NATIVE_JOB_INPUT", "{message}");
    assert!(message.contains("mma"));
    for d in [reference, dir] {
        let _ = std::fs::remove_dir_all(d);
    }
}

#[test]
fn heaviside_projection_lowers_the_grey_level() {
    let plain = folder("proj-plain");
    let (without, _, _) = run(&plain, &mbb(60, 20, json!({ "filter": { "kind": "density" } }))).unwrap();
    let dir = folder("proj");
    let settings = json!({ "filter": { "kind": "density" }, "projection": { "beta": 16, "betaEvery": 40 } });
    let (with, field, _) = run(&dir, &mbb(60, 20, settings)).unwrap();
    let (g0, g1) = (without["grey"].as_f64().unwrap(), with["grey"].as_f64().unwrap());
    eprintln!(
        "projection: grey {g0} -> {g1}, compliance {} -> {}, {} iterations ({}), beta {}",
        without["compliance"], with["compliance"], with["iterations"], with["status"], with["projection"]["beta"]
    );
    assert!(g1 < 0.5 * g0, "grey {g1} not well below {g0}");
    assert_eq!(with["projection"], json!({ "beta": 16.0, "eta": 0.5, "finalBeta": 16.0 }));
    assert!(without.get("projection").is_none());
    assert!((with["volumeFraction"].as_f64().unwrap() - 0.5).abs() < 2e-3);
    assert!(field.iter().all(|v| (0.0..=1.0).contains(v)));
    let state: Value = serde_json::from_slice(&std::fs::read(dir.join("state.json")).unwrap()).unwrap();
    assert!(state["projectionLevel"].as_u64().unwrap() >= 4);
    // the projection needs the density filter
    let (code, _) = run(&dir, &mbb(30, 10, json!({ "projection": { "beta": 8 } }))).unwrap_err();
    assert_eq!(code, "NATIVE_JOB_INPUT");
    for d in [plain, dir] {
        let _ = std::fs::remove_dir_all(d);
    }
}

#[test]
fn extrusion_makes_the_design_uniform_along_the_axis() {
    let (nx, ny, nz) = (12, 6, 4);
    let dir = folder("extrude");
    let settings = json!({ "filter": { "kind": "density", "radius": 1.5 }, "maxIterations": 30, "extrusion": "z" });
    let (result, field, _) = run(&dir, &cantilever(nx, ny, nz, settings)).unwrap();
    for j in 0..ny {
        for i in 0..nx {
            let column: Vec<f32> = (0..nz).map(|k| field[i + nx * (j + ny * k)]).collect();
            assert!(column.iter().all(|v| *v == column[0]), "column ({i}, {j}) is not uniform: {column:?}");
        }
    }
    assert!((result["volumeFraction"].as_f64().unwrap() - 0.3).abs() < 1e-3);
    assert_eq!(result["settings"]["extrusion"], "z");
    // 2D: uniform along y gives a 1D layout; the out-of-plane axis is refused
    let flat = folder("extrude-2d");
    let (_, field2, _) = run(&flat, &mbb(30, 10, json!({ "maxIterations": 20, "extrusion": "y" }))).unwrap();
    for i in 0..30 {
        assert!((0..10).all(|j| field2[i + 30 * j] == field2[i]), "column {i} not uniform");
    }
    let (code, _) = run(&flat, &mbb(30, 10, json!({ "extrusion": "z" }))).unwrap_err();
    assert_eq!(code, "NATIVE_JOB_INPUT");
    for d in [dir, flat] {
        let _ = std::fs::remove_dir_all(d);
    }
}

#[test]
fn gravity_is_a_design_dependent_load() {
    // a 2D plate clamped on its left edge under its own weight only
    let (nx, ny) = (24, 8);
    let fixed: Vec<Value> = (0..=ny).map(|j| json!({ "node": [0, j], "dofs": [0, 1] })).collect();
    let job = |gravity: f64, extra: Value| {
        let mut job = json!({
            "version": 1, "dimension": 2, "grid": { "nx": nx, "ny": ny }, "material": { "e0": 1.0, "nu": 0.3 },
            "volumeFraction": 0.4, "fixed": fixed,
            "loadCases": [{ "name": "weight", "gravity": [0.0, -gravity] }],
            "settings": { "filter": { "kind": "density" }, "maxIterations": 60, "optimizer": "mma" }
        });
        for (key, value) in extra.as_object().unwrap() {
            job["settings"][key] = value.clone();
        }
        job
    };
    let dir = folder("gravity");
    let (result, field, _) = run(&dir, &job(1e-3, json!({}))).unwrap();
    let history = result["history"].as_array().unwrap();
    let (first, last) = (history[0]["compliance"].as_f64().unwrap(), result["compliance"].as_f64().unwrap());
    eprintln!("self weight: compliance {first} -> {last} in {} iterations ({})", result["iterations"], result["status"]);
    assert!(first > 0.0 && last < first, "compliance did not decrease: {first} -> {last}");
    // the compliance of a self-weighted body scales with g² (F ∝ g, U ∝ g) for the same design
    let twice = folder("gravity-2g");
    let (doubled, _, _) = run(&twice, &job(2e-3, json!({ "maxIterations": 1 }))).unwrap();
    let (one, two) = (history[0]["compliance"].as_f64().unwrap(), doubled["history"][0]["compliance"].as_f64().unwrap());
    assert!((two / one - 4.0).abs() < 1e-9, "{one} vs {two}");
    // material gathers at the clamped root
    let column = |i: usize| (0..ny).map(|j| f64::from(field[i + nx * j])).sum::<f64>();
    assert!(column(0) > column(nx - 1), "root {} vs tip {}", column(0), column(nx - 1));
    // gravity needs `dimension` finite components
    let mut bad = job(1e-3, json!({}));
    bad["loadCases"][0]["gravity"] = json!([0.0, -1.0, 0.0]);
    assert_eq!(run(&dir, &bad).unwrap_err().0, "NATIVE_JOB_INPUT");
    // OC assumes non-positive sensitivities: with self-weight it still ends (the volume constraint may stay inactive)
    let oc = folder("gravity-oc");
    let (with_oc, _, _) = run(&oc, &job(1e-3, json!({ "optimizer": "oc", "maxIterations": 5 }))).unwrap();
    assert_eq!(with_oc["iterations"], 5);
    for d in [dir, twice, oc] {
        let _ = std::fs::remove_dir_all(d);
    }
}

#[test]
fn a_deadline_checkpoint_resumes_bit_for_bit_with_oc() {
    let full = folder("deadline-full");
    run(&full, &mbb(30, 10, json!({ "filter": { "kind": "density" }, "maxIterations": 30 }))).unwrap();
    let part = folder("deadline-part");
    let (checkpoint, _, events) =
        run(&part, &mbb(30, 10, json!({ "filter": { "kind": "density" }, "maxIterations": 30, "deadlineS": 0 }))).unwrap();
    assert_eq!(checkpoint["status"], "checkpoint");
    assert_eq!(checkpoint["iterations"], 1);
    assert_eq!(checkpoint["warnings"][0]["code"], "TOP_DEADLINE");
    assert!(events.contains(r#""type":"warning","code":"TOP_DEADLINE""#));
    let start = start_files(&part);
    let resumed = with_start(mbb(30, 10, json!({ "filter": { "kind": "density" } })), &start, 1, 29);
    let (result, _, _) = run(&part, &resumed).unwrap();
    assert_eq!(result["iterations"], 29);
    assert_eq!(result["status"], "max_iterations");
    let names = ["design.f64", "field.bin", "displacements.f64"];
    assert_eq!(files(&full, &names), files(&part, &names));
    let state: Value = serde_json::from_slice(&std::fs::read(part.join("state.json")).unwrap()).unwrap();
    assert_eq!(state["iteration"], 30);
    for d in [full, part] {
        let _ = std::fs::remove_dir_all(d);
    }
}

#[test]
fn an_mma_run_with_projection_resumes_bit_for_bit_from_its_state() {
    let settings = json!({ "optimizer": "mma", "filter": { "kind": "density" }, "projection": { "beta": 8, "betaEvery": 6 } });
    let full = folder("mma-resume-full");
    let mut whole = mbb(30, 10, settings.clone());
    whole["settings"]["maxIterations"] = json!(20);
    run(&full, &whole).unwrap();
    let part = folder("mma-resume-part");
    let mut first = mbb(30, 10, settings.clone());
    first["settings"]["maxIterations"] = json!(8);
    run(&part, &first).unwrap();
    let start = start_files(&part);
    std::fs::copy(part.join("mma.f64"), part.join("mma.f64.start")).unwrap();
    let mut state: Value = serde_json::from_slice(&std::fs::read(part.join("start_state.json")).unwrap()).unwrap();
    state["mma"]["file"] = json!("mma.f64.start");
    std::fs::write(part.join("start_state.json"), serde_json::to_vec(&state).unwrap()).unwrap();
    let (result, _, _) = run(&part, &with_start(mbb(30, 10, settings.clone()), &start, 8, 12)).unwrap();
    assert_eq!(result["iterations"], 12);
    let names = ["design.f64", "field.bin", "displacements.f64", "mma.f64"];
    assert_eq!(files(&full, &names), files(&part, &names));
    // the design alone (no state) restarts the asymptotes and the β continuation: a different run
    let mut cold = mbb(30, 10, settings);
    cold["startDesign"] = json!("start.f64");
    cold["settings"]["maxIterations"] = json!(12);
    let (loose, _, _) = run(&part, &cold).unwrap();
    assert_eq!(loose["iterations"], 12);
    assert_ne!(files(&full, &["field.bin"]), files(&part, &["field.bin"]));
    let state: Value = serde_json::from_slice(&std::fs::read(part.join("state.json")).unwrap()).unwrap();
    assert_eq!(state["mma"]["iteration"], 12);
    for d in [full, part] {
        let _ = std::fs::remove_dir_all(d);
    }
}

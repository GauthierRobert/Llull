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

/// Runs `settings` whole (`total` iterations), then with `deadlineS: 0` (checkpoint after the first iteration) and resumes it; the resumed
/// outputs must equal the whole run's byte for byte (and `extra` is checked on the checkpoint result).
fn checkpoint_equals_whole(name: &str, job: Value, total: usize, extra: impl Fn(&Value)) {
    let full = folder(&format!("{name}-full"));
    let mut whole = job.clone();
    whole["settings"]["maxIterations"] = json!(total);
    let (expected, _, _) = run(&full, &whole).unwrap();
    let part = folder(&format!("{name}-part"));
    let mut first = job.clone();
    first["settings"]["maxIterations"] = json!(total);
    first["settings"]["deadlineS"] = json!(0);
    let (checkpoint, _, _) = run(&part, &first).unwrap();
    assert_eq!(checkpoint["status"], "checkpoint", "{checkpoint}");
    assert_eq!(checkpoint["iterations"], 1);
    extra(&checkpoint);
    let start = start_files(&part);
    let (result, _, _) = run(&part, &with_start(job, &start, 1, total - 1)).unwrap();
    assert_eq!(result["iterations"], total - 1);
    assert_eq!(result["status"], expected["status"]);
    let names = ["design.f64", "field.bin", "displacements.f64"];
    assert_eq!(files(&full, &names), files(&part, &names), "{name}");
    let state = |dir: &Path| -> Value { serde_json::from_slice(&std::fs::read(dir.join("state.json")).unwrap()).unwrap() };
    assert_eq!(state(&full)["projectionLevel"], state(&part)["projectionLevel"]);
    for d in [full, part] {
        let _ = std::fs::remove_dir_all(d);
    }
}

#[test]
fn a_checkpoint_on_a_beta_bump_iteration_carries_the_new_level() {
    // betaEvery 1: the first iteration raises β before the deadline is looked at, so the checkpoint state already holds level 1
    let settings = json!({ "filter": { "kind": "density" }, "projection": { "beta": 8, "betaEvery": 1 } });
    checkpoint_equals_whole("bump", mbb(30, 10, settings), 6, |checkpoint| {
        assert_eq!(checkpoint["projection"]["beta"], 2.0);
    });
}

#[test]
fn a_checkpoint_on_a_converging_iteration_at_an_intermediate_beta_bumps_first() {
    // changeTol 1 converges at once; β is not final, so the run continues at the next level instead of ending
    let settings = json!({ "filter": { "kind": "density" }, "changeTol": 1, "projection": { "beta": 4, "betaEvery": 100 } });
    checkpoint_equals_whole("converge-bump", mbb(30, 10, settings), 3, |checkpoint| {
        assert_eq!(checkpoint["projection"]["beta"], 2.0);
    });
}

#[test]
fn a_converging_iteration_at_the_final_beta_reports_converged_even_past_the_deadline() {
    let settings = json!({ "filter": { "kind": "density" }, "changeTol": 1, "projection": { "beta": 1, "betaStart": 1 }, "deadlineS": 0 });
    let dir = folder("converge-deadline");
    let (with_deadline, field, _) = run(&dir, &mbb(30, 10, settings.clone())).unwrap();
    assert_eq!(with_deadline["status"], "converged");
    assert_eq!(with_deadline["iterations"], 1);
    let plain = folder("converge-plain");
    let mut without = mbb(30, 10, settings);
    without["settings"].as_object_mut().unwrap().remove("deadlineS");
    let (reference, field_ref, _) = run(&plain, &without).unwrap();
    assert_eq!(reference["status"], "converged");
    assert_eq!(field, field_ref);
    // a deadline never turns the last allowed iteration into a checkpoint: the cap reports max_iterations
    let mut capped = mbb(30, 10, json!({ "maxIterations": 1, "deadlineS": 0 }));
    capped["settings"]["changeTol"] = json!(1e-12);
    let (at_cap, _, _) = run(&dir, &capped).unwrap();
    assert_eq!(at_cap["status"], "max_iterations");
    for d in [dir, plain] {
        let _ = std::fs::remove_dir_all(d);
    }
}

#[test]
fn an_extruded_run_resumes_bit_for_bit_from_a_checkpoint() {
    let settings = json!({ "filter": { "kind": "density", "radius": 1.5 }, "extrusion": "z" });
    checkpoint_equals_whole("extrude-resume", cantilever(8, 4, 3, settings), 6, |_| {});
}

/// DOF of the y component of the top-left node of an `nx x ny` 2D grid (the MBB load point).
fn tip_dof(nx: usize, ny: usize) -> usize {
    2 * ((nx + 1) * ny) + 1
}

fn min_volume_job(nx: usize, ny: usize, limit: f64, constraints: Value) -> Value {
    let mut job = mbb(nx, ny, json!({ "optimizer": "mma", "filter": { "kind": "density" } }));
    job["objective"] = json!({ "kind": "minVolume", "maxCompliance": limit });
    job["displacementConstraints"] = constraints;
    job
}

#[test]
fn displacement_constraint_limits_the_tip_and_costs_material() {
    let reference = folder("disp-ref");
    let (oc, _, _) = run(&reference, &mbb(30, 10, json!({ "filter": { "kind": "density" } }))).unwrap();
    let limit = 1.5 * oc["compliance"].as_f64().unwrap();
    let free_dir = folder("disp-free");
    let (free, _, _) = run(&free_dir, &min_volume_job(30, 10, limit, json!([]))).unwrap();
    assert_eq!(free["constraints"].as_array().unwrap().len(), 1);
    // the unit tip load does work 1 * |u| = compliance of the single load case: the free layout deflects by about `compliance`
    let tip = free["compliance"].as_f64().unwrap();
    let cap = 0.7 * tip;
    let dir = folder("disp");
    let constraint = json!([{ "label": "tip", "loadCase": "tip", "dofs": [tip_dof(30, 10)], "maxDisplacement": cap }]);
    let (result, _, _) = run(&dir, &min_volume_job(30, 10, limit, constraint)).unwrap();
    let rows = result["constraints"].as_array().unwrap();
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert_eq!((rows[1]["name"].as_str(), rows[1]["label"].as_str()), (Some("displacement"), Some("tip")));
    let value = rows[1]["value"].as_f64().unwrap();
    eprintln!(
        "displacement constraint: free volume {}, constrained volume {}, |u| {value} <= {cap} ({} iterations)",
        free["volumeFraction"], result["volumeFraction"], result["iterations"]
    );
    assert_eq!(rows[1]["limit"].as_f64().unwrap(), cap);
    assert_eq!(rows[1]["satisfied"], true, "|u| {value} above {cap}");
    assert!(value <= cap * 1.01);
    assert!(value >= 0.99 * cap, "the cap is meant to be active: |u| {value} against {cap}");
    // for the unit load the compliance equals the tip displacement: the displacement limit is the tighter one
    assert!(result["compliance"].as_f64().unwrap() <= cap * 1.01);
    assert!(result["volumeFraction"].as_f64().unwrap() > free["volumeFraction"].as_f64().unwrap());
    let again = folder("disp-again");
    run(&again, &min_volume_job(30, 10, limit, constraint_of(cap))).unwrap();
    assert_eq!(files(&dir, &["field.bin", "design.f64"]), files(&again, &["field.bin", "design.f64"]));
    for d in [reference, free_dir, dir, again] {
        let _ = std::fs::remove_dir_all(d);
    }
}

fn constraint_of(cap: f64) -> Value {
    json!([{ "label": "tip", "loadCase": "tip", "dofs": [tip_dof(30, 10)], "maxDisplacement": cap }])
}

#[test]
fn displacement_constraint_rejects_bad_input() {
    let dir = folder("disp-bad");
    let ok = |extra: Value| min_volume_job(30, 10, 1000.0, extra);
    let cases = [
        (json!([{ "loadCase": "nope", "dofs": [1], "maxDisplacement": 1.0 }]), "unknown load case"),
        (json!([{ "loadCase": "tip", "dofs": [], "maxDisplacement": 1.0 }]), "at least one DOF"),
        (json!([{ "loadCase": "tip", "dofs": [tip_dof(30, 10)], "maxDisplacement": 0.0 }]), "must be > 0"),
        (json!([{ "loadCase": "tip", "dofs": [0], "maxDisplacement": 1.0 }]), "every constrained DOF is fixed"),
    ];
    for (constraints, needle) in cases {
        let (code, message) = run(&dir, &ok(constraints)).unwrap_err();
        assert_eq!(code, "NATIVE_JOB_INPUT", "{message}");
        assert!(message.contains(needle), "{message}");
    }
    // OC cannot hold the extra row
    let mut oc = mbb(30, 10, json!({}));
    oc["displacementConstraints"] = constraint_of(1.0);
    let (code, message) = run(&dir, &oc).unwrap_err();
    assert_eq!(code, "NATIVE_JOB_INPUT");
    assert!(message.contains("mma"), "{message}");
    let _ = std::fs::remove_dir_all(dir);
}

/// min_volume with a self-weight case: the tip cap is the only binding row, so tightening it must cost material, and every row must hold.
#[test]
fn displacement_cap_with_a_self_weight_case_is_active_and_costs_material_monotonically() {
    let mut volumes = Vec::new();
    for cap in [400.0, 300.0, 230.0] {
        let mut job = min_volume_job(30, 10, 1.0e5, constraint_of(cap));
        job["loadCases"][0]["gravity"] = json!([0.0, -0.0002]);
        let dir = folder(&format!("disp-gravity-{cap}"));
        let (result, _, _) = run(&dir, &job).unwrap();
        let rows = result["constraints"].as_array().unwrap();
        eprintln!("gravity cap {cap}: volume {} rows {rows:?} status {}", result["volumeFraction"], result["status"]);
        assert!(rows.iter().all(|row| row["satisfied"] == true), "{rows:?}");
        let value = rows[1]["value"].as_f64().unwrap();
        assert!(value >= 0.99 * cap, "the cap {cap} is meant to be active: |u| {value}");
        volumes.push(result["volumeFraction"].as_f64().unwrap());
        let _ = std::fs::remove_dir_all(dir);
    }
    assert!(volumes.windows(2).all(|pair| pair[1] > pair[0]), "volume must rise as the cap tightens: {volumes:?}");
}

#[test]
fn a_displacement_row_resumes_bit_for_bit_from_a_checkpoint() {
    let job = min_volume_job(30, 10, 1.0e5, constraint_of(300.0));
    checkpoint_equals_whole("disp-resume", job, 6, |_| {});
}

#[test]
fn a_target_that_touches_a_support_keeps_the_fixed_dofs_as_zero_in_the_mean() {
    // the x = 0 column of the MBB is fixed in x: the mean over [fixed ux of node (0, 10), free ux of node (1, 10)] is half the free one,
    // so a cap of 0.5 x the free value of that mean makes the constraint bind without a solver refusal
    let free_dof = 2 + 2 * 31 * 10;
    let fixed_dof = 2 * (31 * 10);
    let probe = |dofs: Value, cap: f64| {
        let dir = folder("disp-fixed-mix");
        let constraint = json!([{ "label": "mix", "loadCase": "tip", "dofs": dofs, "maxDisplacement": cap }]);
        let (result, _, _) = run(&dir, &min_volume_job(30, 10, 400.0, constraint)).unwrap();
        let _ = std::fs::remove_dir_all(dir);
        result["constraints"][1].clone()
    };
    let alone = probe(json!([free_dof]), 1.0e6);
    let free_value = alone["value"].as_f64().unwrap();
    assert!(free_value > 0.0);
    let mixed = probe(json!([fixed_dof, free_dof]), 0.8 * free_value / 2.0);
    assert_eq!((mixed["label"].as_str(), mixed["satisfied"].as_bool()), (Some("mix"), Some(true)), "{mixed}");
    assert!(mixed["value"].as_f64().unwrap() >= 0.99 * mixed["limit"].as_f64().unwrap(), "{mixed}");
}

#[test]
fn a_run_that_ends_with_a_violated_row_warns_and_keeps_its_status() {
    // a compliance limit nobody can miss lets the design vanish; the displacement cap then cannot hold and the run says so
    let dir = folder("unsatisfied");
    let constraint = json!([{ "label": "tip", "loadCase": "tip", "dofs": [tip_dof(30, 10)], "maxDisplacement": 1.0e-6 }]);
    let (result, _, events) = run(&dir, &min_volume_job(30, 10, 1.0e9, constraint)).unwrap();
    let rows = result["constraints"].as_array().unwrap();
    assert!(rows.iter().any(|row| row["satisfied"] == false), "{rows:?}");
    assert_eq!(result["status"], "converged", "{result}");
    assert!(events.contains("TOP_CONSTRAINT_UNSATISFIED"), "{events}");
    let _ = std::fs::remove_dir_all(dir);
}

fn cantilever_min_volume(limit: f64, extra: Value) -> Value {
    let mut job = cantilever(12, 4, 3, json!({ "optimizer": "mma", "filter": { "kind": "density" } }));
    job["objective"] = json!({ "kind": "minVolume", "maxCompliance": limit });
    if let Some(map) = extra.as_object() {
        for (key, value) in map {
            job[key] = value.clone();
        }
    }
    job
}

fn backtracks_in(events: &str) -> usize {
    events
        .lines()
        .filter(|line| line.contains("TOP_DESIGN_BACKTRACK"))
        .filter_map(|line| line.split("backtracked ").nth(1)?.split(' ').next()?.parse().ok())
        .next()
        .unwrap_or(0)
}

/// TOP-V1b follow-up: a slack compliance row (limit 1e5, MBB 30 x 10) let MMA strip the design to a broken load path; the near-void
/// multigrid hierarchy then produced a NaN in the f32 preconditioner (TOP_SOLVER_FAILED). The run must end finite and say what it did.
#[test]
fn a_slack_compliance_row_does_not_collapse_the_design_into_a_solver_failure() {
    let dir = folder("slack");
    let (result, field, events) = run(&dir, &min_volume_job(30, 10, 1.0e5, json!([]))).unwrap();
    let (volume, compliance) = (result["volumeFraction"].as_f64().unwrap(), result["compliance"].as_f64().unwrap());
    eprintln!("slack: volume {volume}, compliance {compliance}, {} iterations, {}", result["iterations"], result["status"]);
    assert!(volume.is_finite() && compliance.is_finite() && field.iter().all(|v| v.is_finite()), "{result}");
    // the first steps strip the design to a broken load path: that step is taken back, the broken multigrid solve falls back to Jacobi
    assert!(events.contains("TOP_DESIGN_BACKTRACK") && backtracks_in(&events) >= 1, "{events}");
    assert!(events.contains("TOP_SOLVER_FALLBACK"), "{events}");
    assert!(!events.contains("TOP_SOLVER_FAILED"), "{events}");
    assert_eq!(result["constraints"][0]["satisfied"], true, "{result}");
    assert!(compliance <= 1.0e5 * 1.0001, "compliance {compliance}");
    assert!(volume > 0.01 && volume < 0.2, "volume {volume}");
    // deterministic, like every CPU run
    let again = folder("slack-again");
    let (second, _, _) = run(&again, &min_volume_job(30, 10, 1.0e5, json!([]))).unwrap();
    assert_eq!(second["volumeFraction"], result["volumeFraction"]);
    assert_eq!(second["iterations"], result["iterations"]);
    for d in [dir, again] {
        let _ = std::fs::remove_dir_all(d);
    }
}

/// The collapse rule is scale free (a jump over the last accepted design, with the row violated): a 3D cantilever in a large unit
/// system, limit 1000 (the old absolute threshold of 100 x limit missed it: volume 0 at iteration 3) ends feasible.
#[test]
fn a_3d_collapse_under_a_large_limit_is_backtracked() {
    let dir = folder("cantilever-1000");
    let (result, field, events) = run(&dir, &cantilever_min_volume(1000.0, json!({}))).unwrap();
    let (volume, compliance) = (result["volumeFraction"].as_f64().unwrap(), result["compliance"].as_f64().unwrap());
    eprintln!("cantilever 1000: volume {volume}, compliance {compliance}, {} it, {}\n{events}", result["iterations"], result["status"]);
    assert!(field.iter().all(|v| v.is_finite()) && backtracks_in(&events) >= 1, "{events}");
    assert!(volume > 0.0 && result["constraints"][0]["satisfied"] == true, "the design must stay feasible: {result}");
    let _ = std::fs::remove_dir_all(dir);
}

/// A limit the design cannot meet after the backtracks: the run says so (TOP_CONSTRAINT_UNSATISFIED), never a NaN.
#[test]
fn a_3d_collapse_that_cannot_be_repaired_ends_unsatisfied_and_says_so() {
    let dir = folder("cantilever-10");
    let (result, field, events) = run(&dir, &cantilever_min_volume(10.0, json!({}))).unwrap();
    eprintln!("cantilever 10: {} {} it\n{events}", result["constraints"], result["iterations"]);
    assert!(field.iter().all(|v| v.is_finite()) && backtracks_in(&events) >= 1, "{events}");
    assert!(events.contains("TOP_CONSTRAINT_UNSATISFIED") && !events.contains("TOP_SOLVER_FAILED"), "{events}");
    assert_eq!(result["constraints"][0]["satisfied"], false);
    let value = result["constraints"][0]["value"].as_f64().unwrap();
    assert!((13.0..13.5).contains(&value), "pinned at 13.2226 against the limit 10, got {value}");
    let _ = std::fs::remove_dir_all(dir);
}

/// A checkpoint right before and right after a backtrack iteration (the collapse of the slack scenario is analysed at iteration 4)
/// resumes bit for bit, and the backtrack count in `state.json` carries over (no re-count).
#[test]
fn a_run_resumes_bit_for_bit_across_a_backtrack() {
    let total = 9;
    let job = min_volume_job(30, 10, 1.0e5, json!([]));
    let full = folder("backtrack-full");
    let mut whole = job.clone();
    whole["settings"]["maxIterations"] = json!(total);
    let (expected, _, whole_events) = run(&full, &whole).unwrap();
    let state_of = |dir: &Path| -> Value { serde_json::from_slice(&std::fs::read(dir.join("state.json")).unwrap()).unwrap() };
    assert!(state_of(&full)["backtracks"].as_u64().unwrap() >= 2, "{}", state_of(&full));
    assert!(backtracks_in(&whole_events) >= 2);
    for cut in [3, 4, 5] {
        let part = folder(&format!("backtrack-part{cut}"));
        let mut first = job.clone();
        first["settings"]["maxIterations"] = json!(cut);
        let (_, _, first_events) = run(&part, &first).unwrap();
        let start = start_files(&part);
        std::fs::copy(part.join("mma.f64"), part.join("mma.f64.start")).unwrap();
        let mut state = state_of(&part);
        state["mma"]["file"] = json!("mma.f64.start");
        std::fs::write(part.join("start_state.json"), serde_json::to_vec(&state).unwrap()).unwrap();
        let (result, _, second_events) = run(&part, &with_start(job.clone(), &start, cut, total - cut)).unwrap();
        assert_eq!(result["iterations"], total - cut);
        let names = ["design.f64", "field.bin", "displacements.f64", "mma.f64"];
        assert_eq!(files(&full, &names), files(&part, &names), "cut at {cut}");
        assert_eq!(state_of(&full), state_of(&part), "cut at {cut}");
        assert_eq!(result["compliance"], expected["compliance"]);
        // each run reports only its own backtracks; the totals add up to the whole run's
        let (a, b) = (backtracks_in(&first_events), backtracks_in(&second_events));
        assert_eq!(a + b, backtracks_in(&whole_events), "cut at {cut}: {first_events} / {second_events}");
        let _ = std::fs::remove_dir_all(part);
    }
    let _ = std::fs::remove_dir_all(full);
}

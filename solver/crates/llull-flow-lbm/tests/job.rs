//! The `llull-compute flow` job contract: outputs and their hashes, progress events, the not-converged step limit (VC-CFD-55:
//! `converged: false`, still written), and the refusals (`CFD_UNSTABLE_PARAMS`, `CFD_MEMORY_EXCEEDED`, `NATIVE_JOB_INPUT`).

mod common;

use common::{cube_job_in, result_json, run_job, sphere_job};
use llull_protocol::sha256_hex;
use std::fs;

#[test]
fn a_step_limited_run_writes_every_output_hashed_and_reports_not_converged() {
    let job = sphere_job(
        "job-outputs",
        6,
        20.0,
        [1.2, 2.5, 1.2],
        r#"{ "maxSteps": 60, "sampleEvery": 10, "historyCap": 4 }"#,
        r#"{ "probesM": [[1.0, 0, 0], [0, 0, 0]], "slices": [{ "originM": [0, 0, 0], "normal": [0, 1, 0], "field": "speed" }], "surfaceFields": ["p", "cp", "speed"] }"#,
    );
    let (events, result) = run_job(&job.dir);
    let outputs = result.unwrap();
    let names: Vec<&str> = outputs.iter().map(|o| o.path.as_str()).collect();
    assert_eq!(names, ["surface.bin", "slice-0.bin", "result.json"]);
    for output in &outputs {
        let bytes = fs::read(job.dir.join(&output.path)).unwrap();
        assert_eq!(sha256_hex(&bytes), output.sha256, "{}", output.path);
    }
    let json = result_json(&job.dir);
    assert_eq!(json["status"], "max_steps");
    assert_eq!(json["converged"], false);
    assert_eq!(json["steps"], 60);
    assert_eq!(json["device"], "cpu");
    assert_eq!(json["deterministic"], true);
    assert_eq!(json["solver"], "lbm");
    assert!(json["history"].as_array().unwrap().len() <= 4);
    assert_eq!(json["history"].as_array().unwrap().last().unwrap()["step"], 60);
    assert_eq!(json["probes"].as_array().unwrap().len(), 2);
    assert!(json["probes"][1]["pressurePa"].is_null(), "a probe inside the body samples nothing");
    assert!(json["probes"][0]["speedMS"].is_number());
    assert_eq!(json["peaks"][0]["field"], "p");
    assert!(json["lattice"]["tau"].as_f64().unwrap() > 0.5);
    assert!(json["grid"]["solidCells"].as_u64().unwrap() > 0);
    let progress: Vec<&serde_json::Value> = events.iter().filter(|e| e["type"] == "progress").collect();
    assert_eq!(progress.len(), 6);
    assert_eq!(progress[0]["step"], 10);
    assert!(progress[0]["dragN"].is_number());
    let surface = fs::read(job.dir.join("surface.bin")).unwrap();
    assert_eq!(&surface[..4], b"LLSF");
    let fields = u32::from_le_bytes([surface[12], surface[13], surface[14], surface[15]]);
    assert_eq!(fields, 3);
    let slice = fs::read(job.dir.join("slice-0.bin")).unwrap();
    assert_eq!(&slice[..4], b"LLSL");
}

#[test]
fn a_viscosity_that_puts_tau_at_one_half_is_refused_without_les() {
    let job = sphere_job("job-unstable", 6, 1e9, [1.2, 2.5, 1.2], r#"{ "maxSteps": 10, "les": false }"#, "{}");
    let (_, result) = run_job(&job.dir);
    let error = result.unwrap_err();
    assert_eq!(error.code, "CFD_UNSTABLE_PARAMS");
    assert!(error.message.contains("latticeMach"), "{}", error.message);
}

#[test]
fn a_grid_above_the_cell_cap_is_refused_before_running() {
    let job = sphere_job("job-cap", 6, 20.0, [1.2, 2.5, 1.2], r#"{ "maxSteps": 10, "cellCap": 100 }"#, "{}");
    let (events, result) = run_job(&job.dir);
    assert_eq!(result.unwrap_err().code, "CFD_MEMORY_EXCEEDED");
    assert!(events.is_empty());
    assert!(!job.dir.join("result.json").exists());
}

#[test]
fn a_body_on_the_domain_boundary_and_unknown_fields_are_input_errors() {
    let job = sphere_job("job-touching", 6, 20.0, [0.3, 0.3, 0.3], r#"{ "maxSteps": 10 }"#, "{}");
    let (_, result) = run_job(&job.dir);
    let error = result.unwrap_err();
    assert_eq!(error.code, "NATIVE_JOB_INPUT");
    assert!(error.message.contains("boundary"), "{}", error.message);

    let job = sphere_job("job-unknown", 6, 20.0, [1.2, 2.5, 1.2], r#"{ "maxSteps": 10, "bogus": 1 }"#, "{}");
    let (_, result) = run_job(&job.dir);
    assert_eq!(result.unwrap_err().code, "NATIVE_JOB_INPUT");
}

#[test]
fn a_symmetry_face_halves_the_model_and_reports_whole_body_forces() {
    // Full box y in [-2, 2] (y = 0 on a cell boundary) against the half box y in [0, 2] closed by a symmetry face. A unit cube
    // voxelises exactly mirror-symmetric (a UV sphere does not: its quad diagonals differ between the halves), so the half model
    // must reproduce the whole one to round-off.
    let settings = r#"{ "maxSteps": 80, "sampleEvery": 10, "les": false }"#;
    let full = cube_job_in("job-full", 8, 20.0, [-2.0, -2.0, -2.0], [4.0, 2.0, 2.0], settings, "{}", "{}");
    let half = cube_job_in("job-half", 8, 20.0, [-2.0, 0.0, -2.0], [4.0, 2.0, 2.0], settings, "{}", r#"{ "yMin": "symmetry" }"#);
    run_job(&full.dir).1.unwrap();
    run_job(&half.dir).1.unwrap();
    let whole = result_json(&full.dir);
    let mirrored = result_json(&half.dir);
    assert_eq!(whole["halfModel"], false);
    assert_eq!(mirrored["halfModel"], true);
    assert!(mirrored["grid"]["solidCells"].as_u64().unwrap() < whole["grid"]["solidCells"].as_u64().unwrap());
    let drag = |json: &serde_json::Value| json["forces"]["dragN"].as_f64().unwrap();
    let relative = (drag(&mirrored) - drag(&whole)).abs() / drag(&whole).abs();
    eprintln!("symmetry: half-model drag {:.6e} vs whole {:.6e} ({relative:.2e})", drag(&mirrored), drag(&whole));
    assert!(relative < 1e-9, "half model drag {} vs {}", drag(&mirrored), drag(&whole));
    let lift = |json: &serde_json::Value| json["forces"]["liftN"].as_f64().unwrap();
    assert!((lift(&mirrored) - lift(&whole)).abs() < 1e-9 * drag(&whole).abs());
    assert_eq!(mirrored["forces"]["sideN"], 0.0);
    assert_eq!(mirrored["forces"]["cs"], 0.0);
    assert_eq!(mirrored["forces"]["momentNm"][0], 0.0);
    assert_eq!(mirrored["forces"]["momentNm"][2], 0.0);
    assert_eq!(mirrored["perBody"][0]["forceN"][1], 0.0);
    assert!(mirrored["notModelled"].as_array().unwrap().iter().any(|note| note.as_str().unwrap().starts_with("half model")));
    let memory = &mirrored["memory"];
    assert_eq!(memory["cpuBytesPerCell"], 395);
    assert_eq!(memory["gpuBytesPerCell"], 204);
    assert_eq!(memory["bytesPerCell"], 395);
    assert_eq!(memory["bytes"].as_u64().unwrap(), 395 * mirrored["grid"]["cells"].as_u64().unwrap());
}

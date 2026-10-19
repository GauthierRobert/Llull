//! VC-TOP-10 / 11 (MBB 60×20 half-beam, top88 default call) and VC-TOP-04 (30×10) through the real job folder, against
//! `docs/physics/17-topology-optimization/validation/` (expected_results.json, mbb_60x20_{sensitivity,density}.txt):
//! compliance 1e-6 relative, iterations ±2 (TECHNICAL_SPEC §5.7), volume 1e-3, grey 1e-4, density digits.
//! Also: determinism (two runs, identical bytes, any thread count) and resume (bit-identical continuation).

use serde_json::Value;
use std::path::{Path, PathBuf};

fn validation(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../docs/physics/17-topology-optimization/validation").join(name)
}

fn expected(id: &str) -> f64 {
    let all: Value = serde_json::from_str(&std::fs::read_to_string(validation("expected_results.json")).unwrap()).unwrap();
    let case = all["cases"].as_array().unwrap().iter().find(|c| c["id"] == id).unwrap_or_else(|| panic!("{id} missing"));
    case["value"].as_f64().unwrap()
}

fn folder(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("llull-topopt-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// top88 MBB: ux = 0 on the left edge, uy = 0 at the bottom-right node, unit load down at the top-left node.
fn mbb_job(nx: usize, ny: usize, filter: &str, extra: &str) -> String {
    let fixed: Vec<String> = (0..=ny).map(|j| format!(r#"{{"node":[0,{j}],"dofs":[0]}}"#)).collect();
    format!(
        r#"{{"version":1,"dimension":2,"grid":{{"nx":{nx},"ny":{ny}}},"material":{{"e0":1,"nu":0.3}},"volumeFraction":0.5,
        "fixed":[{},{{"node":[{nx},0],"dofs":[1]}}],
        "loadCases":[{{"name":"tip","loads":[{{"node":[0,{ny}],"force":[0,-1]}}]}}],
        "settings":{{"filter":{{"kind":"{filter}","radius":1.5}}{extra}}}}}"#,
        fixed.join(",")
    )
}

fn run(dir: &Path, job: &str) -> (Value, Vec<f32>, Vec<u8>) {
    std::fs::write(dir.join("job.json"), job).unwrap();
    let mut events = Vec::new();
    let outputs = llull_topopt::job::run(dir, &mut events).unwrap_or_else(|e| panic!("{}: {}", e.code, e.message));
    assert_eq!(
        outputs.iter().map(|o| o.path.as_str()).collect::<Vec<_>>(),
        ["field.bin", "design.f64", "displacements.f64", "result.json"]
    );
    let result: Value = serde_json::from_slice(&std::fs::read(dir.join("result.json")).unwrap()).unwrap();
    let field: Vec<f32> =
        std::fs::read(dir.join("field.bin")).unwrap().chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    (result, field, events)
}

fn digits(field: &[f32], nx: usize, ny: usize) -> Vec<String> {
    (0..ny)
        .map(|row| (0..nx).map(|i| ((9.0 * f64::from(field[i + nx * (ny - 1 - row)])).round_ties_even() as u8).to_string()).collect())
        .collect()
}

fn check_mbb(vc: &str, filter: &str, picture: &str) {
    let dir = folder(vc);
    let (result, field, events) = run(&dir, &mbb_job(60, 20, filter, ""));
    let rel = |key: &str, id: &str| {
        let (got, want) = (result[key].as_f64().unwrap(), expected(id));
        (got - want).abs() / want.abs()
    };
    let iterations = result["iterations"].as_i64().unwrap();
    eprintln!(
        "{vc}: iterations {iterations}, last-iteration compliance {}, final {}, volume {}, grey {}, PCG iterations {}",
        result["lastIterationCompliance"],
        result["compliance"],
        result["volumeFraction"],
        result["grey"],
        result["solver"]["pcgIterations"]
    );
    assert!((iterations - expected(&format!("{vc}.a")) as i64).abs() <= 2, "iterations {iterations}");
    assert!(rel("lastIterationCompliance", &format!("{vc}.b")) < 1e-6);
    assert!(rel("compliance", &format!("{vc}.c")) < 1e-6);
    assert!((result["volumeFraction"].as_f64().unwrap() - expected(&format!("{vc}.d"))).abs() < 1e-3);
    assert!((result["grey"].as_f64().unwrap() - expected(&format!("{vc}.e"))).abs() < 1e-4);
    assert_eq!(result["status"], "converged");
    assert_eq!(result["deterministic"], true);
    assert_eq!(result["perLoadCase"]["tip"], result["compliance"]);
    assert_eq!(result["history"].as_array().unwrap().len() as i64, iterations);
    let reference: Vec<String> = std::fs::read_to_string(validation(picture)).unwrap().lines().map(str::to_string).collect();
    let ours = digits(&field, 60, 20);
    let mismatches: Vec<(usize, usize)> =
        (0..20).flat_map(|r| (0..60).map(move |c| (r, c))).filter(|&(r, c)| ours[r].as_bytes()[c] != reference[r].as_bytes()[c]).collect();
    for &(r, c) in &mismatches {
        let (a, b) = (ours[r].as_bytes()[c] as i32, reference[r].as_bytes()[c] as i32);
        assert!((a - b).abs() <= 1, "digit at row {r} col {c}: {} vs {}", a - 48, b - 48);
    }
    assert!(mismatches.len() <= 6, "{} density digits differ:\n{}", mismatches.len(), ours.join("\n"));
    let lines = String::from_utf8(events).unwrap();
    let progress: Vec<Value> =
        lines.lines().map(|l| serde_json::from_str::<Value>(l).unwrap()).filter(|e| e["type"] == "progress").collect();
    assert_eq!(progress.len() as i64, iterations);
    assert_eq!(progress[0]["it"], 1);
    assert!(
        progress[0]["compliance"].as_f64().unwrap() > 0.0
            && progress[0]["change"].as_f64().is_some()
            && progress[0]["volume"].as_f64().is_some()
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn vc_top_10_mbb_60x20_sensitivity_filter() {
    check_mbb("VC-TOP-10", "sensitivity", "mbb_60x20_sensitivity.txt");
}

#[test]
fn vc_top_11_mbb_60x20_density_filter() {
    check_mbb("VC-TOP-11", "density", "mbb_60x20_density.txt");
}

#[test]
fn vc_top_04_mbb_30x10_first_iteration_compliance_scales_by_p() {
    // one iteration from x = 0.5 analyses the uniform design: c(0.5) = c(1) / (Emin + 0.5³(1 − Emin))
    let dir = folder("VC-TOP-04");
    let (result, _, _) = run(&dir, &mbb_job(30, 10, "sensitivity", r#","maxIterations":1"#));
    let c_half = result["history"][0]["compliance"].as_f64().unwrap();
    let ratio = expected("VC-TOP-04.b");
    let c_solid = expected("VC-TOP-04.a");
    assert!((c_half / ratio - c_solid).abs() / c_solid < 1e-8, "c(0.5) = {c_half}");
    assert_eq!(result["status"], "max_iterations");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn two_runs_and_thread_counts_give_identical_bytes() {
    let job = mbb_job(30, 10, "density", r#","maxIterations":25"#);
    let bytes = |threads: usize, name: &str| {
        let dir = folder(name);
        rayon::ThreadPoolBuilder::new().num_threads(threads).build().unwrap().install(|| run(&dir, &job));
        let read = |f: &str| std::fs::read(dir.join(f)).unwrap();
        let out = (read("field.bin"), read("design.f64"), read("displacements.f64"), read("result.json"));
        let _ = std::fs::remove_dir_all(dir);
        out
    };
    let first = bytes(4, "det-a");
    assert_eq!(first, bytes(4, "det-b"), "two runs differ");
    assert_eq!(first, bytes(1, "det-c"), "1 thread differs from 4");
    assert_eq!(first, bytes(3, "det-d"), "3 threads differ from 4");
}

#[test]
fn a_resumed_run_continues_bit_for_bit() {
    let full = folder("resume-full");
    let (complete, _, _) = run(&full, &mbb_job(30, 10, "density", r#","maxIterations":30"#));
    let part = folder("resume-part");
    run(&part, &mbb_job(30, 10, "density", r#","maxIterations":12"#));
    std::fs::copy(part.join("design.f64"), part.join("start.f64")).unwrap();
    std::fs::copy(part.join("displacements.f64"), part.join("start_u.f64")).unwrap();
    let resumed = |files: &str| {
        mbb_job(30, 10, "density", r#","maxIterations":18"#).replacen(r#""version":1,"#, &format!(r#""version":1,{files}"#), 1)
    };
    let (result, _, _) = run(&part, &resumed(r#""startDesign":"start.f64","startDisplacements":"start_u.f64","#));
    assert_eq!(result["iterations"], 18);
    for file in ["design.f64", "field.bin", "displacements.f64"] {
        assert_eq!(std::fs::read(full.join(file)).unwrap(), std::fs::read(part.join(file)).unwrap(), "{file}");
    }
    // without the warm start the solves start from zero: the same answer to the PCG tolerance, not bit for bit
    let (cold, _, _) = run(&part, &resumed(r#""startDesign":"start.f64","#));
    let (a, b) = (complete["compliance"].as_f64().unwrap(), cold["compliance"].as_f64().unwrap());
    assert!((a - b).abs() / a < 1e-6, "{a} vs {b}");
    let _ = std::fs::remove_dir_all(full);
    let _ = std::fs::remove_dir_all(part);
}

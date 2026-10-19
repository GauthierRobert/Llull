//! VC-TOP-34 measurement (ignored by default; numbers go to TECHNICAL_SPEC §13):
//!
//! ```sh
//! cargo test --release -p llull-topopt --test scaling -- --ignored --nocapture
//! LLULL_TOPOPT_SCALING="20,40,60" LLULL_TOPOPT_SCALING_ITERATIONS=5 LLULL_TOPOPT_SCALING_DEVICES="cpu,gpu" cargo test …
//! ```
//!
//! 3D cantilevers of `2n × n × n` voxels (density filter, rmin 1.5, volume fraction 0.3, multigrid PCG to 1e-10), a fixed
//! number of SIMP iterations (`changeTol` 0); prints DOFs, wall time per iteration and PCG iterations per solve per device.

use serde_json::{json, Value};
use std::time::Instant;

fn cantilever(n: usize, iterations: usize, device: &str) -> Value {
    let (nx, ny, nz) = (2 * n, n, n);
    let fixed: Vec<Value> = (0..=ny).flat_map(|j| (0..=nz).map(move |k| json!({ "node": [0, j, k], "dofs": [0, 1, 2] }))).collect();
    let loads: Vec<Value> = (0..=nz).map(|k| json!({ "node": [nx, 0, k], "force": [0.0, -1.0 / (nz + 1) as f64, 0.0] })).collect();
    json!({
        "version": 1, "dimension": 3, "grid": { "nx": nx, "ny": ny, "nz": nz }, "material": { "e0": 1.0, "nu": 0.3 },
        "volumeFraction": 0.3, "fixed": fixed, "loadCases": [{ "name": "tip", "loads": loads }], "dofCap": 100_000_000,
        "settings": { "filter": { "kind": "density", "radius": 1.5 }, "maxIterations": iterations, "changeTol": 0.0, "device": device }
    })
}

fn env_list(name: &str, default: &str) -> Vec<String> {
    std::env::var(name).unwrap_or_else(|_| default.to_string()).split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
}

#[test]
#[ignore = "measurement (VC-TOP-34): run with --release --ignored --nocapture"]
fn vc_top_34_cantilever_scaling() {
    let sizes: Vec<usize> = env_list("LLULL_TOPOPT_SCALING", "10,20,30").iter().map(|s| s.parse().unwrap()).collect();
    let iterations: usize = std::env::var("LLULL_TOPOPT_SCALING_ITERATIONS").ok().and_then(|s| s.parse().ok()).unwrap_or(5);
    let devices = env_list("LLULL_TOPOPT_SCALING_DEVICES", "cpu");
    eprintln!("threads: {}", rayon::current_num_threads());
    eprintln!("| device | grid | voxels | DOFs | s / iteration | PCG iterations / solve | adapter |");
    for device in &devices {
        for &n in &sizes {
            let dir = std::env::temp_dir().join(format!("llull-topopt-scaling-{device}-{n}-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("job.json"), serde_json::to_vec(&cantilever(n, iterations, device)).unwrap()).unwrap();
            let started = Instant::now();
            llull_topopt::job::run(&dir, &mut std::io::sink()).unwrap_or_else(|e| panic!("{}: {}", e.code, e.message));
            let seconds = started.elapsed().as_secs_f64();
            let result: Value = serde_json::from_slice(&std::fs::read(dir.join("result.json")).unwrap()).unwrap();
            let pcg = result["solver"]["pcgIterations"].as_f64().unwrap() / (iterations + 1) as f64;
            eprintln!(
                "| {} | {}x{}x{} | {} | {} | {:.3} | {:.1} | {} |",
                result["device"],
                2 * n,
                n,
                n,
                result["grid"]["elements"],
                result["grid"]["dofs"],
                seconds / iterations as f64,
                pcg,
                result["adapter"].as_str().unwrap_or("-")
            );
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

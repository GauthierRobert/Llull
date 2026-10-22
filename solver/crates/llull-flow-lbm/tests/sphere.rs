//! VC-CFD-21: drag of a sphere against Schiller-Naumann `Cd = 24 / Re (1 + 0.15 Re^0.687)`. The pack's gate (32 cells per
//! diameter, 10 %, Re 20 / 50 / 100 / 200) is the ignored test (minutes on the CPU twin: `cargo test --release -- --ignored`);
//! the CI test runs Re 20 at 8 cells per diameter in a 4 D box and only checks the drag is of the right size and sign.

mod common;

use common::{result_json, run_job, sphere_job};

fn schiller_naumann(re: f64) -> f64 {
    24.0 / re * (1.0 + 0.15 * re.powf(0.687))
}

#[test]
fn sphere_re20_smoke_drag_has_the_right_magnitude() {
    let job = sphere_job(
        "sphere-smoke",
        8,
        20.0,
        [2.0, 4.5, 2.0],
        r#"{ "maxSteps": 8000, "sampleEvery": 20, "startAveragingTol": 0.01, "stopTol": 0.002, "les": false }"#,
        r#"{ "probesM": [[1.5, 0, 0]] }"#,
    );
    let (events, result) = run_job(&job.dir);
    result.unwrap();
    let json = result_json(&job.dir);
    let cd = json["forces"]["cd"].as_f64().unwrap();
    let expected = schiller_naumann(20.0);
    eprintln!(
        "VC-CFD-21 smoke: Cd {cd:.4} vs Schiller-Naumann {expected:.4} after {} steps (converged {})",
        json["steps"], json["converged"]
    );
    // 8 cells per diameter in a 4 D x 4 D box (blockage 4.9 %): a staircase sphere in a confined channel reads high.
    assert!(cd > 0.5 * expected && cd < 1.8 * expected, "Cd {cd} vs {expected}");
    assert!(json["forces"]["cl"].as_f64().unwrap().abs() < 0.1 * cd, "lift ~ 0 by symmetry");
    assert_eq!(json["perBody"][0]["entityId"], "ball");
    assert!(events.iter().any(|event| event["type"] == "progress" && event["phase"] == "averaging"));
    assert!(json["probes"][0]["speedMS"].as_f64().unwrap() < 1.0, "the wake is slower than the free stream");
}

#[test]
#[ignore = "VC-CFD-21 at 32 cells per diameter: minutes on the CPU twin; run with --ignored (device auto uses the GPU when present)"]
fn sphere_drag_matches_schiller_naumann_at_32_cells_per_diameter() {
    for re in [20.0, 50.0, 100.0, 200.0] {
        let job = sphere_job(
            &format!("sphere-re{re}"),
            32,
            re,
            [4.0, 8.0, 4.0],
            r#"{ "maxSteps": 400000, "device": "auto", "les": false }"#,
            "{}",
        );
        let (_, result) = run_job(&job.dir);
        result.unwrap();
        let json = result_json(&job.dir);
        let cd = json["forces"]["cd"].as_f64().unwrap();
        let expected = schiller_naumann(re);
        eprintln!("VC-CFD-21 Re {re}: Cd {cd:.4} vs {expected:.4} ({} steps, converged {})", json["steps"], json["converged"]);
        assert!((cd - expected).abs() / expected < 0.1, "Re {re}: Cd {cd} vs {expected}");
    }
}

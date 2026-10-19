//! VC-AER-33 at crate level: the influence matrix equals the TypeScript one bit for bit, and the faer LU solves to the TypeScript Γ within
//! round-off (fixture written by `tests/unit/native/panelReference.test.ts`); a rerun gives identical bits.

use llull_panel::{influence_matrix, run, solve};
use serde_json::Value;

fn fixture() -> Value {
    let path = format!("{}/tests/fixtures/lattice.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn numbers(value: &Value) -> Vec<f64> {
    value.as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect()
}

#[test]
fn the_influence_matrix_is_bit_identical_to_typescript() {
    let fixture = fixture();
    let matrix = influence_matrix(&numbers(&fixture["panels"]));
    let expected = numbers(&fixture["influence"]);
    assert_eq!(matrix.len(), expected.len());
    for (k, (a, b)) in matrix.iter().zip(&expected).enumerate() {
        assert_eq!(a.to_bits(), b.to_bits(), "entry {k}: {a} vs {b}");
    }
}

#[test]
fn circulations_match_typescript_and_reruns_are_identical() {
    let fixture = fixture();
    let panels = numbers(&fixture["panels"]);
    let (gx, gz, report) = solve(&panels).unwrap();
    for (native, reference) in [(&gx, numbers(&fixture["gammaX"])), (&gz, numbers(&fixture["gammaZ"]))] {
        let scale = reference.iter().fold(0.0f64, |m, v| m.max(v.abs()));
        for (a, b) in native.iter().zip(&reference) {
            assert!((a - b).abs() <= 1e-12 * scale, "{a} vs {b}");
        }
    }
    assert!(report.residual_x < 1e-13 && report.residual_z < 1e-13, "{report:?}");
    let (gx2, gz2, _) = solve(&panels).unwrap();
    assert!(gx.iter().chain(&gz).zip(gx2.iter().chain(&gz2)).all(|(a, b)| a.to_bits() == b.to_bits()));
}

#[test]
fn the_job_writes_gamma_and_refuses_bad_input() {
    let dir = std::env::temp_dir().join(format!("llull-panel-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let panels = numbers(&fixture()["panels"]);
    let bytes: Vec<u8> = panels.iter().flat_map(|v| v.to_le_bytes()).collect();
    std::fs::write(dir.join("panels.f64"), &bytes).unwrap();
    std::fs::write(dir.join("job.json"), format!("{{\"panels\":{}}}", panels.len() / 12)).unwrap();
    let outputs = run(&dir).unwrap();
    assert_eq!(outputs.iter().map(|o| o.path.as_str()).collect::<Vec<_>>(), ["gamma.f64", "solve.json"]);
    assert_eq!(std::fs::read(dir.join("gamma.f64")).unwrap().len(), panels.len() / 12 * 2 * 8);

    std::fs::write(dir.join("job.json"), "{\"panels\":3}").unwrap();
    assert_eq!(run(&dir).unwrap_err().code, "NATIVE_JOB_INPUT");
    std::fs::write(dir.join("job.json"), "{").unwrap();
    assert_eq!(run(&dir).unwrap_err().code, "NATIVE_JOB_INPUT");
    assert_eq!(solve(&[1.0; 5]).unwrap_err().code, "NATIVE_JOB_INPUT");
    assert_eq!(solve(&[f64::NAN; 12]).unwrap_err().code, "NATIVE_JOB_INPUT");
    let mut twice = panels[..12].to_vec();
    twice.extend_from_slice(&panels[..12]);
    assert_eq!(solve(&twice).unwrap_err().code, "NATIVE_PANEL_SINGULAR");
    std::fs::remove_dir_all(&dir).unwrap();
    assert_eq!(run(&dir).unwrap_err().code, "NATIVE_JOB_IO");
}

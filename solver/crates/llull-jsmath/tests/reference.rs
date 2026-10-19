//! Bit-exact agreement with V8 on the samples `tests/unit/native/nativeReference.test.ts` writes from the JavaScript `Math` functions.

use serde_json::Value;

fn cases(name: &str) -> Vec<Vec<f64>> {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/jsmath.json")).unwrap();
    let all: Value = serde_json::from_str(&text).unwrap();
    all[name].as_array().unwrap().iter().map(|row| row.as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect()).collect()
}

#[test]
fn pow_matches_v8_bit_for_bit() {
    let rows = cases("pow");
    assert!(rows.len() > 800);
    for row in rows {
        assert_eq!(llull_jsmath::pow(row[0], row[1]).to_bits(), row[2].to_bits(), "pow({}, {})", row[0], row[1]);
    }
}

#[test]
fn exp_matches_v8_bit_for_bit() {
    let rows = cases("exp");
    assert!(rows.len() > 1000);
    for row in rows {
        assert_eq!(llull_jsmath::exp(row[0]).to_bits(), row[1].to_bits(), "exp({})", row[0]);
    }
}

#[test]
fn log10_matches_v8_bit_for_bit() {
    for row in cases("log10") {
        assert_eq!(llull_jsmath::log10(row[0]).to_bits(), row[1].to_bits(), "log10({})", row[0]);
    }
}

#[test]
fn hypot_and_round_match_v8() {
    for row in cases("hypot") {
        assert_eq!(llull_jsmath::hypot(&row[..3]).to_bits(), row[3].to_bits(), "hypot({:?})", &row[..3]);
    }
    for row in cases("round") {
        assert_eq!(llull_jsmath::round(row[0]), row[1], "round({})", row[0]);
    }
}

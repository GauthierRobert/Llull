//! VC-DYN-48 at crate level: `llull_post::random` against the TypeScript reference fields written by
//! `tests/unit/native/dynamicsReference.test.ts` (Euler-Bernoulli strip of VC-DYN-21 and seeded synthetic modal bases, viscous and
//! structural damping). Every value must be identical bit for bit, for any rayon thread count.

use llull_post::random::{self, RandomJob};
use serde_json::Value;

fn cases() -> Vec<Value> {
    let path = format!("{}/tests/fixtures/random_jobs.json", env!("CARGO_MANIFEST_DIR"));
    let all: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    all.as_array().unwrap().clone()
}

fn numbers(value: &Value) -> Vec<f64> {
    value.as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect()
}

#[test]
fn random_fields_are_identical_for_every_node_and_component() {
    let cases = cases();
    assert_eq!(cases.len(), 3);
    for case in &cases {
        let name = case["name"].as_str().unwrap();
        let job: RandomJob = serde_json::from_value(case["job"].clone()).unwrap();
        let field = random::run(&job, &numbers(&case["modal"])).unwrap();
        let expected = numbers(&case["field"]);
        assert_eq!(field.len(), expected.len(), "{name}");
        for (index, (actual, wanted)) in field.iter().zip(&expected).enumerate() {
            assert_eq!(actual.to_bits(), wanted.to_bits(), "{name}: value {index}: {actual} vs {wanted}");
        }
    }
}

#[test]
fn the_field_does_not_depend_on_the_thread_count() {
    let case = &cases()[1];
    let job: RandomJob = serde_json::from_value(case["job"].clone()).unwrap();
    let modal = numbers(&case["modal"]);
    let single = rayon::ThreadPoolBuilder::new().num_threads(1).build().unwrap().install(|| random::run(&job, &modal).unwrap());
    let many = rayon::ThreadPoolBuilder::new().num_threads(4).build().unwrap().install(|| random::run(&job, &modal).unwrap());
    assert_eq!(single, many);
}

#[test]
fn malformed_jobs_are_refused() {
    let case = &cases()[2];
    let job: RandomJob = serde_json::from_value(case["job"].clone()).unwrap();
    let modal = numbers(&case["modal"]);
    let short = random::run(&job, &modal[1..]).unwrap_err();
    assert_eq!(short.code, "NATIVE_JOB_INPUT");
    let mut bad_gamma = job.clone();
    bad_gamma.gamma.pop();
    assert!(random::run(&bad_gamma, &modal).unwrap_err().message.contains("gamma"));
    let mut bad_source = job.clone();
    bad_source.components[0].source = 99;
    assert!(random::run(&bad_source, &modal).unwrap_err().message.contains("source"));
    let mut bad_grid = job.clone();
    bad_grid.weight.pop();
    assert!(random::run(&bad_grid, &modal).unwrap_err().message.contains("weight"));
    let mut empty = job;
    empty.components.clear();
    assert!(random::run(&empty, &modal).unwrap().is_empty());
}

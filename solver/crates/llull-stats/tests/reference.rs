//! VC-GDT-37 at crate level: the native Monte Carlo reproduces the TypeScript sampler bit for bit (fixtures written by
//! `tests/unit/native/stackupReference.test.ts`), and its result does not depend on the thread count.

use llull_stats::{run, sample, StatsJob};
use serde_json::Value;

fn fixture() -> Vec<Value> {
    let path = format!("{}/tests/fixtures/stackup.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn same(actual: f64, expected: &Value) -> bool {
    actual.to_bits() == expected.as_f64().unwrap().to_bits()
}

#[test]
fn statistics_are_bit_identical_to_the_typescript_reference() {
    for case in fixture() {
        let job: StatsJob = serde_json::from_value(case["job"].clone()).unwrap();
        let stats = sample(&job, |_, _| {}).unwrap();
        let expected = &case["stats"];
        let name = case["name"].as_str().unwrap();
        assert!(same(stats.mean, &expected["mean"]), "{name}: mean {} vs {}", stats.mean, expected["mean"]);
        assert!(same(stats.std, &expected["std"]), "{name}: std {} vs {}", stats.std, expected["std"]);
        assert!(same(stats.min, &expected["min"]), "{name}: min");
        assert!(same(stats.max, &expected["max"]), "{name}: max");
        assert_eq!(stats.below, expected["below"].as_u64().unwrap(), "{name}: below");
        assert_eq!(stats.above, expected["above"].as_u64().unwrap(), "{name}: above");
        assert_eq!(stats.non_finite, 0);
        assert_eq!(stats.samples, expected["samples"].as_u64().unwrap());
    }
}

#[test]
fn results_do_not_depend_on_the_thread_count() {
    let case = &fixture()[4];
    let mut job: StatsJob = serde_json::from_value(case["job"].clone()).unwrap();
    job.samples = 300_001;
    let on = |threads: usize| {
        let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).build().unwrap();
        pool.install(|| sample(&job, |_, _| {}).unwrap())
    };
    let one = on(1);
    for threads in [3, 8] {
        let many = on(threads);
        assert_eq!(many.threads, threads);
        assert_eq!(
            (many.mean.to_bits(), many.std.to_bits(), many.min.to_bits(), many.max.to_bits(), many.below),
            (one.mean.to_bits(), one.std.to_bits(), one.min.to_bits(), one.max.to_bits(), one.below)
        );
    }
}

#[test]
fn the_job_writes_stats_json_and_refuses_bad_input() {
    let dir = std::env::temp_dir().join(format!("llull-stats-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("job.json"), fixture()[0]["job"].to_string()).unwrap();
    let mut events = Vec::new();
    let outputs = run(&dir, &mut events).unwrap();
    assert_eq!(outputs[0].path, "stats.json");
    let written: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("stats.json")).unwrap()).unwrap();
    assert!(same(written["mean"].as_f64().unwrap(), &fixture()[0]["stats"]["mean"]));
    assert!(String::from_utf8(events).unwrap().contains("\"type\":\"progress\""));

    let mut bad = fixture()[0]["job"].clone();
    bad["samples"] = Value::from(1);
    std::fs::write(dir.join("job.json"), bad.to_string()).unwrap();
    assert_eq!(run(&dir, &mut Vec::new()).unwrap_err().code, "NATIVE_JOB_INPUT");
    bad["samples"] = Value::from(1000);
    bad["contributors"] = Value::Array(vec![]);
    std::fs::write(dir.join("job.json"), bad.to_string()).unwrap();
    assert!(run(&dir, &mut Vec::new()).unwrap_err().message.contains("contributors"));
    std::fs::write(dir.join("job.json"), "{").unwrap();
    assert_eq!(run(&dir, &mut Vec::new()).unwrap_err().code, "NATIVE_JOB_INPUT");
    std::fs::remove_dir_all(&dir).unwrap();
    assert_eq!(run(&dir, &mut Vec::new()).unwrap_err().code, "NATIVE_JOB_IO");
}

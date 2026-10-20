//! Statistics jobs of `llull-compute stats` (03 GDT M5n, TR-GDT-22, RS1 RS-7): `stackup` runs the Monte Carlo of a tolerance stack-up above
//! the TypeScript cap. Counter-based Philox4x32-10 streams and fixed-order block reductions make the result a pure function of
//! (seed, samples, inputs): bit-identical for any thread count (VC-GDT-37).
//!
//! Job folder: `job.json` in, `result.json` out (reported with its sha256).

pub mod expr;
pub mod mc;
pub mod philox;

use expr::{Expr, Node};
use llull_protocol::{sha256_hex, Output};
use mc::{Config, Contributor, Model};
use serde::Deserialize;
use std::fs;
use std::path::Path;

/// Largest sample count one job accepts (10^10 draws x contributors is hours of CPU: refuse rather than hang the host).
pub const MAX_SAMPLES: u64 = 10_000_000_000;

/// A job failure: stable code + message (the host maps it to its own codes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobError {
    pub code: &'static str,
    pub message: String,
}

fn input(message: impl Into<String>) -> JobError {
    JobError { code: "NATIVE_JOB_INPUT", message: message.into() }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ContributorJob {
    centre: f64,
    spread: f64,
    normal: bool,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum ModelJob {
    Linear { sensitivities: Vec<f64> },
    Expression { tree: Node },
}

#[derive(Deserialize)]
struct StackupJob {
    seed: i64,
    samples: u64,
    contributors: Vec<ContributorJob>,
    model: ModelJob,
    lower: Option<f64>,
    upper: Option<f64>,
}

/// Runs the job in `folder`.
pub fn run(task: &str, folder: &Path) -> Result<Vec<Output>, JobError> {
    if task != "stackup" {
        return Err(JobError { code: "NATIVE_JOB_UNKNOWN", message: format!("unknown stats task '{task}'") });
    }
    let path = folder.join("job.json");
    let text =
        fs::read_to_string(&path).map_err(|error| JobError { code: "NATIVE_JOB_IO", message: format!("{}: {error}", path.display()) })?;
    let job: StackupJob = serde_json::from_str(&text).map_err(|error| input(format!("job.json: {error}")))?;
    if job.samples == 0 || job.samples > MAX_SAMPLES {
        return Err(input(format!("samples must be 1 to {MAX_SAMPLES}, got {}", job.samples)));
    }
    if job.contributors.is_empty() {
        return Err(input("at least one contributor is required"));
    }
    if job.contributors.iter().any(|c| !c.centre.is_finite() || !c.spread.is_finite() || c.spread < 0.0) {
        return Err(input("contributor centres and spreads must be finite, spreads not negative"));
    }
    let model = match job.model {
        ModelJob::Linear { sensitivities } if sensitivities.len() == job.contributors.len() => Model::Linear(sensitivities),
        ModelJob::Linear { sensitivities } => {
            return Err(input(format!("{} sensitivities for {} contributors", sensitivities.len(), job.contributors.len())))
        }
        ModelJob::Expression { tree } => Model::Expression(Expr::build(tree, job.contributors.len()).map_err(input)?),
    };
    let contributors: Vec<Contributor> =
        job.contributors.iter().map(|c| Contributor { centre: c.centre, spread: c.spread, normal: c.normal }).collect();
    let summary = mc::simulate(&Config {
        seed: job.seed,
        samples: job.samples,
        contributors: &contributors,
        model: &model,
        lower: job.lower,
        upper: job.upper,
    });
    if summary.count == 0 {
        return Err(input("the stack result is not finite for any sample"));
    }
    let result = serde_json::json!({
        "seed": job.seed,
        "samples": job.samples,
        "counted": summary.count,
        "nonFinite": summary.non_finite,
        "mean": summary.mean,
        "std": summary.std(),
        "min": summary.min,
        "max": summary.max,
        "below": job.lower.map(|_| summary.below),
        "above": job.upper.map(|_| summary.above),
        "prng": "Philox4x32-10, counter [sample, contributor], key = seed; uniform from the top 24 bits; normal by Box-Muller (cosine); fixed 8192-sample blocks merged in order",
    });
    let bytes = serde_json::to_vec(&result).map_err(|error| input(error.to_string()))?;
    let out = folder.join("result.json");
    fs::write(&out, &bytes).map_err(|error| JobError { code: "NATIVE_JOB_IO", message: format!("{}: {error}", out.display()) })?;
    Ok(vec![Output { path: "result.json".to_string(), sha256: sha256_hex(&bytes) }])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_job(json: &str) -> Result<serde_json::Value, JobError> {
        let folder = std::env::temp_dir().join(format!("llull-stats-test-{}-{}", std::process::id(), sha256_hex(json.as_bytes())));
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("job.json"), json).unwrap();
        let outputs = run("stackup", &folder);
        let result = outputs.map(|outputs| {
            let bytes = fs::read(folder.join(&outputs[0].path)).unwrap();
            assert_eq!(outputs[0].sha256, sha256_hex(&bytes));
            serde_json::from_slice(&bytes).unwrap()
        });
        let _ = fs::remove_dir_all(&folder);
        result
    }

    #[test]
    fn a_linear_stack_reports_mean_std_and_limit_counts() {
        let job = r#"{"seed":1,"samples":20000,"lower":9.0,"upper":11.0,
            "contributors":[{"centre":10.0,"spread":0.5,"normal":true},{"centre":0.0,"spread":0.25,"normal":false}],
            "model":{"kind":"linear","sensitivities":[1.0,1.0]}}"#;
        let result = run_job(job).unwrap();
        assert_eq!(result["samples"], 20000);
        assert!((result["mean"].as_f64().unwrap() - 10.0).abs() < 0.02);
        assert!(result["below"].is_u64() && result["above"].is_u64());
        let again = run_job(job).unwrap();
        assert_eq!(result, again);
    }

    #[test]
    fn an_expression_stack_runs_and_limits_may_be_absent() {
        let job = r#"{"seed":-5,"samples":1000,
            "contributors":[{"centre":3.0,"spread":0.0,"normal":false},{"centre":4.0,"spread":0.0,"normal":false}],
            "model":{"kind":"expression","tree":{"kind":"call","name":"hypot","args":[{"kind":"var","index":0},{"kind":"var","index":1}]}}}"#;
        let result = run_job(job).unwrap();
        assert_eq!(result["mean"].as_f64().unwrap(), 5.0);
        assert!(result["below"].is_null() && result["above"].is_null());
    }

    #[test]
    fn refuses_bad_jobs_with_a_stable_code() {
        let base = |samples: u64, model: &str, contributors: &str| {
            format!(r#"{{"seed":1,"samples":{samples},"contributors":{contributors},"model":{model}}}"#)
        };
        let one = r#"[{"centre":1.0,"spread":0.1,"normal":true}]"#;
        let linear = r#"{"kind":"linear","sensitivities":[1.0]}"#;
        for (job, expect) in [
            (base(0, linear, one), "samples must be"),
            (base(MAX_SAMPLES + 1, linear, one), "samples must be"),
            (base(10, linear, "[]"), "at least one contributor"),
            (base(10, r#"{"kind":"linear","sensitivities":[1.0,2.0]}"#, one), "2 sensitivities for 1"),
            (base(10, r#"{"kind":"expression","tree":{"kind":"var","index":3}}"#, one), "out of range"),
            (base(10, linear, r#"[{"centre":1.0,"spread":-1.0,"normal":true}]"#), "not negative"),
            ("not json".to_string(), "job.json"),
        ] {
            let error = run_job(&job).unwrap_err();
            assert_eq!(error.code, "NATIVE_JOB_INPUT");
            assert!(error.message.contains(expect), "{}: {}", expect, error.message);
        }
        assert_eq!(run("nope", Path::new(".")).unwrap_err().code, "NATIVE_JOB_UNKNOWN");
        assert_eq!(run("stackup", Path::new("/nonexistent-llull-stats-folder")).unwrap_err().code, "NATIVE_JOB_IO");
    }
}

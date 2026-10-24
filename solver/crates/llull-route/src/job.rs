//! `llull-compute route <job-folder>` (plant 02 RTE §2.A).
//!
//! # Input: `job.json` (camelCase)
//!
//! `{ "problemHash": "<sha256 from route_problem>", "problem": <route_problem data.problem>, "maxExpansions": 2000000 }`
//! (`maxExpansions` optional, default [`DEFAULT_MAX_EXPANSIONS`], the budget of each first-move candidate; `maxTotalExpansions` optional, default
//! [`DEFAULT_MAX_TOTAL_EXPANSIONS`], a memory guard across the candidates: each gets `min(maxExpansions, maxTotalExpansions / candidates)`).
//!
//! # Output: `result.json`
//!
//! `{ "status": "found" | "no_path" | "budget", "problemHash", "expansions", "engine": "llull-route", "version" }` plus, when found,
//! `"pisUm": [[x, y, z], ...]` (world µm), `"lengthUm"` (port to port, stubs included), `"bends"`, `"cost"` (integer µm) and
//! `"optimal"` (false when a first-move candidate ran out of budget while it could still beat the route) and `"candidate"` (axis index 0..5
//! of the winning first move; `expansions` is the winner's, `maxExpansions` the budget of each candidate). `no_path` / `budget` are results, not job errors: the host turns them into `RTE_AUTOROUTE_NO_PATH` /
//! `RTE_AUTOROUTE_BUDGET`.
//!
//! # Events (stdout NDJSON, `llull-protocol`)
//!
//! `progress` every [`crate::search::PROGRESS_EVERY`] expansions (`step` = expansions, `total` = maxExpansions), then `done` with
//! `result.json` and its sha256, or `error` with `NATIVE_JOB_IO` / `NATIVE_JOB_INPUT`.

use crate::problem::{Int3, RouteProblem};
use crate::search::{search, Outcome};
use llull_protocol::{emit, sha256_hex, Event, Output};
use serde::Deserialize;
use serde_json::json;
use std::fs;
use std::io::Write;
use std::path::Path;

/// 02 RTE §8 budget: 2·10⁶ expansions.
pub const DEFAULT_MAX_EXPANSIONS: u64 = 2_000_000;

/// Ceiling on the expansions of all candidates together.
pub const DEFAULT_MAX_TOTAL_EXPANSIONS: u64 = 20_000_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobError {
    pub code: &'static str,
    pub message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RouteJob {
    problem_hash: String,
    problem: RouteProblem,
    max_expansions: Option<u64>,
    max_total_expansions: Option<u64>,
}

fn manhattan(a: &Int3, b: &Int3) -> i64 {
    (0..3).map(|d| (a[d] - b[d]).abs()).sum()
}

/// The `result.json` value of a finished search.
pub fn result_json(problem: &RouteProblem, problem_hash: &str, outcome: &Outcome) -> serde_json::Value {
    let base = |status: &str, expansions: u64| json!({ "status": status, "problemHash": problem_hash, "expansions": expansions, "engine": "llull-route", "version": env!("CARGO_PKG_VERSION") });
    match outcome {
        Outcome::NoPath { expansions } => base("no_path", *expansions),
        Outcome::Budget { expansions } => base("budget", *expansions),
        Outcome::Found(found) => {
            let pis: Vec<Int3> = found.bend_cells.iter().map(|&cell| problem.cell_point(cell)).collect();
            let mut points = vec![problem.from.point_um];
            points.extend(pis.iter().copied());
            points.push(problem.to.point_um);
            let length: i64 = points.windows(2).map(|w| manhattan(&w[0], &w[1])).sum();
            let mut value = base("found", found.expansions);
            if let Some(object) = value.as_object_mut() {
                object.insert("pisUm".into(), json!(pis));
                object.insert("lengthUm".into(), json!(length));
                object.insert("bends".into(), json!(pis.len()));
                object.insert("cost".into(), json!(found.cost));
                object.insert("optimal".into(), json!(found.optimal));
                object.insert("candidate".into(), json!(found.candidate));
            }
            value
        }
    }
}

/// Runs the job in `folder`, streaming progress to `out`.
pub fn run(folder: &Path, out: &mut impl Write) -> Result<Vec<Output>, JobError> {
    let path = folder.join("job.json");
    let text =
        fs::read_to_string(&path).map_err(|error| JobError { code: "NATIVE_JOB_IO", message: format!("{}: {error}", path.display()) })?;
    let job: RouteJob =
        serde_json::from_str(&text).map_err(|error| JobError { code: "NATIVE_JOB_INPUT", message: format!("job.json: {error}") })?;
    job.problem.validate().map_err(|message| JobError { code: "NATIVE_JOB_INPUT", message })?;
    let max = job.max_expansions.unwrap_or(DEFAULT_MAX_EXPANSIONS);
    let total = job.max_total_expansions.unwrap_or(DEFAULT_MAX_TOTAL_EXPANSIONS);
    let outcome = search(&job.problem, max, total, &mut |expansions| {
        let _ = emit(out, &Event::Progress { step: expansions, total: max, message: "route: expanding lattice states", detail: None });
    });
    let bytes = serde_json::to_vec(&result_json(&job.problem, &job.problem_hash, &outcome))
        .map_err(|error| JobError { code: "NATIVE_JOB_INPUT", message: error.to_string() })?;
    let target = folder.join("result.json");
    fs::write(&target, &bytes).map_err(|error| JobError { code: "NATIVE_JOB_IO", message: format!("{}: {error}", target.display()) })?;
    Ok(vec![Output { path: "result.json".to_string(), sha256: sha256_hex(&bytes) }])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job_folder(name: &str, body: &str) -> std::path::PathBuf {
        let folder = std::env::temp_dir().join(format!("llull-route-test-{name}-{}", std::process::id()));
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("job.json"), body).unwrap();
        folder
    }

    const SC_RTE_08: &str = r#"{"version":1,"cellUm":50000,"originUm":[200000,0,0],"bounds":{"min":[-40,-40,-40],"max":[96,80,56]},
        "from":{"pointUm":[0,0,0],"axis":0,"stubUm":200000},"to":{"pointUm":[3000000,2000000,1000000],"axis":4,"stubUm":200000},
        "goal":{"cell":[56,40,16],"axis":4},"minLegCells":7,"bendCostUm":1000000,"preferredK":[],"offElevationPenaltyPerCellUm":0,"obstacles":[]}"#;

    #[test]
    fn writes_the_found_route_with_its_hash() {
        let folder = job_folder("found", &format!(r#"{{"problemHash":"abc","problem":{SC_RTE_08}}}"#));
        let mut events = Vec::new();
        let outputs = run(&folder, &mut events).unwrap();
        let bytes = fs::read(folder.join("result.json")).unwrap();
        assert_eq!(outputs, vec![Output { path: "result.json".into(), sha256: sha256_hex(&bytes) }]);
        let result: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(result["status"], "found");
        assert_eq!(result["problemHash"], "abc");
        assert_eq!(result["pisUm"], json!([[3_000_000, 0, 0], [3_000_000, 2_000_000, 0]]));
        assert_eq!(result["lengthUm"], 6_000_000);
        assert_eq!(result["bends"], 2);
        assert_eq!(result["cost"], 7_600_000);
        assert_eq!(result["optimal"], true);
        fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn reports_the_budget_as_a_result_and_bad_input_as_an_error() {
        let folder = job_folder("budget", &format!(r#"{{"problemHash":"h","problem":{SC_RTE_08},"maxExpansions":2}}"#));
        run(&folder, &mut Vec::new()).unwrap();
        let result: serde_json::Value = serde_json::from_slice(&fs::read(folder.join("result.json")).unwrap()).unwrap();
        assert_eq!((result["status"].as_str(), result["expansions"].as_u64()), (Some("budget"), Some(10)));
        fs::remove_dir_all(&folder).unwrap();
        let bad = job_folder("bad", &format!(r#"{{"problemHash":"h","problem":{}}}"#, SC_RTE_08.replace("\"version\":1", "\"version\":2")));
        assert_eq!(run(&bad, &mut Vec::new()).unwrap_err().code, "NATIVE_JOB_INPUT");
        fs::remove_dir_all(&bad).unwrap();
        let missing = std::env::temp_dir().join("llull-route-test-missing-folder");
        assert_eq!(run(&missing, &mut Vec::new()).unwrap_err().code, "NATIVE_JOB_IO");
    }
}

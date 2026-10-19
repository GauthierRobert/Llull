//! `llull-compute <job> [<task>] <job-folder>`: dispatches one job (RS1 §2). `llull-compute --version` prints the version.
//! Jobs: `post fatigue|map <folder>` (crate `llull-post`). An unknown job ends with an `error` event and exit code 2.

use llull_protocol::{emit, Event, Output};
use std::io::stdout;
use std::path::Path;
use std::process::ExitCode;

const USAGE: &str = "usage: llull-compute post <fatigue|map> <job-folder>";

fn run_job(job: &str, rest: &[String]) -> Result<Vec<Output>, (String, String)> {
    match (job, rest) {
        ("post", [task, folder, ..]) => llull_post::run(task, Path::new(folder)).map_err(|error| (error.code.to_string(), error.message)),
        ("post", _) => Err(("NATIVE_USAGE".to_string(), USAGE.to_string())),
        _ => Err(("NATIVE_JOB_UNKNOWN".to_string(), format!("unknown job '{job}'"))),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--version") {
        println!("llull-compute {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    let mut out = stdout().lock();
    let Some(job) = args.first() else {
        let _ = emit(&mut out, &Event::Error { code: "NATIVE_USAGE", message: USAGE });
        return ExitCode::from(2);
    };
    match run_job(job, &args[1..]) {
        Ok(outputs) => {
            let _ = emit(&mut out, &Event::Done { ok: true, outputs });
            ExitCode::SUCCESS
        }
        Err((code, message)) => {
            let _ = emit(&mut out, &Event::Error { code: &code, message: &message });
            ExitCode::from(2)
        }
    }
}

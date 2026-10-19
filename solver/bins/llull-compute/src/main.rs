//! `llull-compute <job> <job-folder>`: dispatches one job (RS1 §2). `llull-compute --version` prints the version.
//! Jobs register in `run_job`; an unknown job ends with an `error` event and exit code 2.

use llull_protocol::{emit, Event};
use std::io::stdout;
use std::path::Path;
use std::process::ExitCode;

fn run_job(job: &str, _folder: &Path) -> Result<Vec<llull_protocol::Output>, (String, String)> {
    Err(("NATIVE_JOB_UNKNOWN".to_string(), format!("unknown job '{job}'")))
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--version") {
        println!("llull-compute {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    let mut out = stdout().lock();
    let (Some(job), Some(folder)) = (args.first(), args.get(1)) else {
        let _ = emit(&mut out, &Event::Error { code: "NATIVE_USAGE", message: "usage: llull-compute <job> <job-folder>" });
        return ExitCode::from(2);
    };
    match run_job(job, Path::new(folder)) {
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

//! `llull-compute <job> [<task>] <job-folder>`: dispatches one job (RS1 §2). `llull-compute --version` prints the version.
//! Jobs: `post fatigue|map <folder>` (crate `llull-post`), `raster <folder>` (crate `llull-raster`), `topopt <folder>` (crate
//! `llull-topopt`, PHY-17 SIMP; one `progress` event per iteration, contract in `llull_topopt::job`), `stats stackup <folder>` (crate
//! `llull-stats`, 03 GDT M5n Monte Carlo, Philox4x32-10). An unknown job ends with an `error`
//! event and exit code 2. The raster job reports a `warning` event when it was asked for the GPU but drew with the CPU twin.

use llull_protocol::{emit, Event, Output};
use llull_raster::Produced;
use std::io::{stdout, Write};
use std::path::Path;
use std::process::ExitCode;

const USAGE: &str =
    "usage: llull-compute post <fatigue|map> <job-folder> | llull-compute raster <job-folder> | llull-compute topopt <job-folder> | llull-compute stats stackup <job-folder>";

fn run_job(job: &str, rest: &[String], out: &mut impl Write) -> Result<Vec<Output>, (String, String)> {
    match (job, rest) {
        ("post", [task, folder, ..]) => llull_post::run(task, Path::new(folder)).map_err(|error| (error.code.to_string(), error.message)),
        ("raster", [folder, ..]) => {
            let (outputs, produced) = llull_raster::run(Path::new(folder)).map_err(|error| (error.code.to_string(), error.message))?;
            let note = match produced {
                Produced::Cpu => None,
                Produced::Gpu { adapter } => {
                    Some(("NATIVE_RASTER_GPU", format!("drawn on the GPU ({adapter}): a picture, not bit-identical")))
                }
                Produced::CpuFallback { reason } => {
                    Some(("NATIVE_RASTER_CPU_FALLBACK", format!("GPU raster unavailable ({reason}); drawn by the CPU twin")))
                }
            };
            if let Some((code, message)) = note {
                let _ = emit(out, &Event::Warning { code, message: &message });
            }
            Ok(outputs)
        }
        ("topopt", [folder, ..]) => llull_topopt::job::run(Path::new(folder), out).map_err(|error| (error.code.to_string(), error.message)),
        ("stats", [task, folder, ..]) => llull_stats::run(task, Path::new(folder)).map_err(|error| (error.code.to_string(), error.message)),
        ("post" | "raster" | "topopt" | "stats", _) => Err(("NATIVE_USAGE".to_string(), USAGE.to_string())),
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
    match run_job(job, &args[1..], &mut out) {
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

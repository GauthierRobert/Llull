//! `llull-compute <job> [<task>] <job-folder>`: dispatches one job (RS1 §2). `llull-compute --version` prints the version.
//! Jobs: `post fatigue|map|random <folder>` (crate `llull-post`), `raster <folder>` (crate `llull-raster`), `topopt <folder>` (crate
//! `llull-topopt`, PHY-17 SIMP; one `progress` event per iteration, contract in `llull_topopt::job`), `route <folder>` (crate
//! `llull-route`, plant 02 RTE V2 auto-router; contract in `llull_route::job`), `stats <folder>` (crate `llull-stats`,
//! GDT stack-up Monte Carlo, contract in `llull_stats`), `panel <folder>` (crate `llull-panel`, AER vortex-lattice influence + LU, faer),
//! `explicit <folder>` (crate `llull-explicit`, PHY-19 RS-8a; contract in `llull_explicit::job`), `geomq <folder>` (crate `llull-geomq`,
//! RS-6 clearance / thickness / view-factor batches; contract in `llull_geomq`), `meshops <folder>` (crate `llull-meshops`, 07 MSH M3 decimate / smooth, bit-identical to the TypeScript mesh engine, and M6 `quad_remesh` by the vendored QuadriFlow), `flow <folder>` (crate `llull-flow-lbm`, 12 CFD M2
//! lattice-Boltzmann steady flow; one `progress` event per drag sample, contract in `llull_flow_lbm::job`), `field <folder>` (crate `llull-field`, 05 IMP M4 voxel meshing / measures of a FieldProgram tape, bit-identical to the TypeScript engine; contract in `llull_field`).
//! An unknown job ends with an `error`
//! event and exit code 2. `cloud import|op <folder>`: crate `llull-cloud` (plant 10 point clouds, RS-3 / RS-4). The raster job reports a `warning` event when it was asked for the GPU but drew with the CPU twin.

use llull_protocol::{emit, Event, Output};
use llull_raster::Produced;
use std::io::{stdin, stdout, ErrorKind, Read, Write};
use std::path::Path;
use std::process::ExitCode;

const USAGE: &str =
    "usage: llull-compute post <fatigue|map|random> <job-folder> | llull-compute raster <job-folder> | llull-compute topopt <job-folder> | llull-compute homogenize <job-folder> | llull-compute stats <job-folder> | llull-compute panel <job-folder> | llull-compute route <job-folder> | llull-compute explicit <job-folder> | llull-compute cloud <import|op> <job-folder> | llull-compute geomq <job-folder> | llull-compute meshops <job-folder> | llull-compute flow <job-folder> | llull-compute field <job-folder>";

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
        ("homogenize", [folder, ..]) => {
            llull_voxfe::homogenize_job::run(Path::new(folder)).map_err(|error| (error.code.to_string(), error.message))
        }
        ("route", [folder, ..]) => llull_route::job::run(Path::new(folder), out).map_err(|error| (error.code.to_string(), error.message)),
        ("stats", [folder, ..]) => llull_stats::run(Path::new(folder), out).map_err(|error| (error.code.to_string(), error.message)),
        ("panel", [folder, ..]) => llull_panel::run(Path::new(folder)).map_err(|error| (error.code.to_string(), error.message)),
        ("explicit", [folder, ..]) => {
            llull_explicit::job::run_job(Path::new(folder), out).map_err(|error| (error.code.to_string(), error.message))
        }
        ("cloud", [task, folder, ..]) => {
            llull_cloud::job::run(task, Path::new(folder), out).map_err(|error| (error.code.to_string(), error.message))
        }
        ("geomq", [folder, ..]) => llull_geomq::run(Path::new(folder)).map_err(|error| (error.code.to_string(), error.message)),
        ("meshops", [folder, ..]) => llull_meshops::run(Path::new(folder), out).map_err(|error| (error.code.to_string(), error.message)),
        ("field", [folder, ..]) => llull_field::run(Path::new(folder), out).map_err(|error| (error.code.to_string(), error.message)),
        ("flow", [folder, ..]) => llull_flow_lbm::job::run(Path::new(folder), out).map_err(|error| (error.code.to_string(), error.message)),
        (
            "post" | "raster" | "topopt" | "homogenize" | "route" | "stats" | "panel" | "explicit" | "cloud" | "geomq" | "meshops" | "flow"
            | "field",
            _,
        ) => Err(("NATIVE_USAGE".to_string(), USAGE.to_string())),
        _ => Err(("NATIVE_JOB_UNKNOWN".to_string(), format!("unknown job '{job}'"))),
    }
}

/// Exit code of a job whose host died (its stdin pipe closed).
const HOST_GONE_EXIT: i32 = 4;

/// Parent-death watchdog, asked for by the host with `LLULL_EXIT_ON_STDIN_EOF=1`: the host starts the job with a stdin pipe it never writes to and never
/// closes while it lives, so end of input on stdin means the host is gone (the pipe closes with the process, however it died: a hard kill, a crash,
/// `process.exit`) and the job stops within milliseconds instead of running on, detached, for its whole timeout. Off by default: other callers give
/// the job a null stdin, which is at end of input from the start.
fn exit_when_host_dies() {
    if std::env::var_os("LLULL_EXIT_ON_STDIN_EOF").is_none_or(|value| value != "1") {
        return;
    }
    std::thread::spawn(|| {
        let mut buffer = [0u8; 256];
        let mut input = stdin().lock();
        loop {
            match input.read(&mut buffer) {
                Ok(0) => break,
                Ok(_) => {}
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
        std::process::exit(HOST_GONE_EXIT);
    });
}

fn main() -> ExitCode {
    exit_when_host_dies();
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

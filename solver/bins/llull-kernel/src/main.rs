//! `llull-kernel`: long-lived native OCCT kernel answering `KernelOps` requests as NDJSON on stdin/stdout (RS-1; protocol in
//! `session.rs`). `llull-kernel --version` prints the version and the OCCT version.
//!
//! stdin is read on its own thread, so end of input is seen even while an operation runs. By default queued requests are still
//! answered, then the process exits (`llull-kernel < requests.ndjson` works). With `--exit-on-eof` (what the server passes) it exits
//! at once: the host is gone, and a long or hung OCCT call must not outlive it.

mod exchange;
mod meshbrep;
mod queries;
mod session;

use std::io::{BufRead, Write};
use std::process::ExitCode;
use std::sync::mpsc;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--version") {
        println!("llull-kernel {} (OCCT {})", env!("CARGO_PKG_VERSION"), llull_kernel_occt::occt_version());
        return ExitCode::SUCCESS;
    }
    let exit_on_eof = args.iter().any(|arg| arg == "--exit-on-eof");
    llull_kernel_occt::init_runtime();

    let (sender, receiver) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if sender.send(line).is_err() {
                return;
            }
        }
        if exit_on_eof {
            std::process::exit(0);
        }
    });

    let mut session = session::Session::new();
    let mut out = std::io::stdout().lock();
    for line in receiver {
        if line.trim().is_empty() {
            continue;
        }
        let reply = session.handle_line(&line);
        if writeln!(out, "{reply}").and_then(|()| out.flush()).is_err() {
            return ExitCode::from(1);
        }
    }
    ExitCode::SUCCESS
}

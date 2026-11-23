//! `llull-kernel`: long-lived native OCCT kernel answering `KernelOps` requests as NDJSON on stdin/stdout (RS-1; protocol in
//! `session.rs`). `llull-kernel --version` prints the version and the OCCT version.
//!
//! stdin is read on its own thread, so end of input is seen even while an operation runs. By default queued requests are still
//! answered, then the process exits (`llull-kernel < requests.ndjson` works). With `--exit-on-eof` (what the server passes) it exits
//! at once: the host is gone, and a long or hung OCCT call must not outlive it.

mod exchange;
mod meshbrep;
mod queries;
mod request;
mod session;

use std::io::{BufRead, Write};
use std::process::ExitCode;
use std::sync::mpsc;

/// The cancel message of the host channel: `{"cancel": <request id>}` with no `op`; the id of the request to stop.
fn cancel_id(line: &str) -> Option<i64> {
    if !line.starts_with("{\"cancel\"") {
        return None;
    }
    serde_json::from_str::<serde_json::Value>(line).ok()?.get("cancel")?.as_i64().filter(|id| *id > 0)
}

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
            // `{"cancel": <id>}` is not a request: it stops the running operation of request <id> at its next progress poll (KRN_TIMEOUT), at once
            if line.starts_with("{\"cancel\"") {
                if let Some(id) = cancel_id(&line) {
                    llull_kernel_occt::request_cancel(id);
                }
                continue;
            }
            if sender.send(line).is_err() {
                return;
            }
        }
        if exit_on_eof {
            std::process::exit(0);
        }
    });

    // parsing, evaluating and dropping a request recurse once per nesting level (request.rs): a large stack, not the main thread's
    let worker =
        std::thread::Builder::new().name("session".into()).stack_size(request::SESSION_STACK_BYTES).spawn(move || serve(&receiver));
    match worker.map(std::thread::JoinHandle::join) {
        Ok(Ok(code)) => code,
        _ => ExitCode::from(1),
    }
}

fn serve(receiver: &mpsc::Receiver<String>) -> ExitCode {
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

#[cfg(test)]
mod tests {
    use super::cancel_id;

    #[test]
    fn only_a_cancel_object_with_a_positive_id_is_a_cancel_message() {
        assert_eq!(cancel_id(r#"{"cancel":7}"#), Some(7));
        assert_eq!(cancel_id(r#"{"cancel":true}"#), None);
        assert_eq!(cancel_id(r#"{"cancel":0}"#), None);
        assert_eq!(cancel_id(r#"{"cancel":-3}"#), None);
        assert_eq!(cancel_id(r#"{"id":1,"op":"info","args":[]}"#), None);
        assert_eq!(cancel_id("not json"), None);
    }
}

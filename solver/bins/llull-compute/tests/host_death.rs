//! The parent-death watchdog of `llull-compute` (`LLULL_EXIT_ON_STDIN_EOF=1`): a job the host started with a stdin pipe stops when that pipe closes,
//! and a job started without the variable (null stdin, the way other callers run it) is left alone.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// A job that takes seconds: decimation of a 300 x 300 grid (180 000 triangles) down to 100.
fn long_job(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("llull-compute-hostdeath-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let n = 300usize;
    let mut positions: Vec<u8> = Vec::new();
    for j in 0..=n {
        for i in 0..=n {
            for value in [i as f64 * 0.02, j as f64 * 0.02, ((i * j) as f64 * 0.0001).sin() * 0.01] {
                positions.extend(value.to_le_bytes());
            }
        }
    }
    let id = |i: usize, j: usize| (j * (n + 1) + i) as u32;
    let mut indices: Vec<u8> = Vec::new();
    for j in 0..n {
        for i in 0..n {
            for v in [id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j), id(i + 1, j + 1), id(i, j + 1)] {
                indices.extend(v.to_le_bytes());
            }
        }
    }
    fs::write(dir.join("positions.f64"), positions).unwrap();
    fs::write(dir.join("indices.u32"), indices).unwrap();
    fs::write(dir.join("job.json"), r#"{"op":"decimate","params":{"targetTriangles":100,"preserveBoundary":true}}"#).unwrap();
    dir
}

fn start(dir: &Path, watchdog: bool, stdin: Stdio) -> Child {
    let mut command = Command::new(env!("CARGO_BIN_EXE_llull-compute"));
    command.arg("meshops").arg(dir).stdin(stdin).stdout(Stdio::piped()).stderr(Stdio::null());
    if watchdog {
        command.env("LLULL_EXIT_ON_STDIN_EOF", "1");
    }
    command.spawn().unwrap()
}

/// Waits for the first progress event, so the job is known to be running.
fn wait_until_running(child: &mut Child) {
    let stdout = child.stdout.as_mut().unwrap();
    let mut line = String::new();
    BufReader::new(stdout).read_line(&mut line).unwrap();
    assert!(line.contains("\"progress\""), "{line}");
}

#[test]
fn a_closed_stdin_stops_a_job_that_asked_for_the_watchdog_within_a_moment() {
    let dir = long_job("watchdog");
    let mut child = start(&dir, true, Stdio::piped());
    wait_until_running(&mut child);
    drop(child.stdin.take()); // the host died: its end of the pipe closes
    let closed = Instant::now();
    let status = child.wait().unwrap();
    assert!(closed.elapsed() < Duration::from_secs(2), "the job kept running for {:?}", closed.elapsed());
    assert_eq!(status.code(), Some(4));
}

#[test]
fn an_open_stdin_does_not_disturb_a_job_and_a_job_without_the_variable_ignores_a_null_stdin() {
    let dir = long_job("alive");
    let mut held = start(&dir, true, Stdio::piped());
    let output = {
        let stdin = held.stdin.take().unwrap(); // kept open until the job is done
        let output = held.wait_with_output().unwrap();
        drop(stdin);
        output
    };
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("\"done\""));
    let other = long_job("plain");
    let plain = start(&other, false, Stdio::null()).wait_with_output().unwrap();
    assert!(plain.status.success());
}

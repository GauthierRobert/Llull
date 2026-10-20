//! Vortex-lattice solve of `llull-compute panel` (aerospace 10 AER M3, RS1 RS-7): influence build (bit-identical to the TypeScript
//! `vlmKernel.ts`, rows in parallel) and a dense LU with partial pivoting (faer) solving the two basis right-hand sides (free streams
//! x̂ and ẑ; Γ(α) = cos α Γx + sin α Γz), plus the O(n²) Trefftz-plane wake velocities of both bases. The host computes the loads in
//! TypeScript from them, as for its own solve.
//!
//! Job folder: `job.json` = `{ "panels": n }`, `panels.f64` = n × 12 little-endian f64 (`kernel` layout). Outputs: `gamma.f64` (Γx then
//! Γz, 2n f64), `trefftz.f64` (4n f64, the TS `trefftzBasis` layout) and `solve.json` = `{ panels, threads, buildMs, factorMs,
//! residualX, residualZ }` (relative residuals ‖AΓ − b‖∞ / ‖b‖∞).

pub mod kernel;

use faer::linalg::solvers::Solve;
use faer::Mat;
use kernel::{basis_rhs, influence_row, trefftz_basis, PANEL_STRIDE};
use llull_protocol::{sha256_hex, Output};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::time::Instant;

/// Largest lattice accepted (the dense matrix is n² f64: 20 000² × 8 B = 3.2 GB).
pub const MAX_PANELS: usize = 20_000;

/// A job failure: stable code + message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobError {
    pub code: &'static str,
    pub message: String,
}

fn input_error(message: String) -> JobError {
    JobError { code: "NATIVE_JOB_INPUT", message }
}

fn io_error(path: &Path, error: &std::io::Error) -> JobError {
    JobError { code: "NATIVE_JOB_IO", message: format!("{}: {error}", path.display()) }
}

#[derive(Debug, Deserialize)]
struct PanelJob {
    panels: usize,
}

/// Solve report (`solve.json`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SolveReport {
    pub panels: usize,
    pub threads: usize,
    pub build_ms: u128,
    pub factor_ms: u128,
    pub residual_x: f64,
    pub residual_z: f64,
}

/// The influence matrix, row-major (rows built in parallel; each entry is computed by one thread in a fixed order).
pub fn influence_matrix(panels: &[f64]) -> Vec<f64> {
    let n = panels.len() / PANEL_STRIDE;
    let mut a = vec![0.0; n * n];
    a.par_chunks_mut(n.max(1)).enumerate().for_each(|(i, row)| influence_row(panels, i, row));
    a
}

fn residual(a: &Mat<f64>, x: &[f64], b: &[f64]) -> f64 {
    let n = b.len();
    let mut worst = 0.0f64;
    let mut scale = 0.0f64;
    for i in 0..n {
        let mut sum = -b[i];
        for (j, xj) in x.iter().enumerate() {
            sum += a[(i, j)] * xj;
        }
        worst = worst.max(sum.abs());
        scale = scale.max(b[i].abs());
    }
    if scale == 0.0 {
        worst
    } else {
        worst / scale
    }
}

/// Γx and Γz of the lattice `panels` (n × 12 f64).
pub fn solve(panels: &[f64]) -> Result<(Vec<f64>, Vec<f64>, SolveReport), JobError> {
    if panels.is_empty() || !panels.len().is_multiple_of(PANEL_STRIDE) {
        return Err(input_error(format!("panels.f64 must hold {PANEL_STRIDE} values per panel")));
    }
    let n = panels.len() / PANEL_STRIDE;
    if n > MAX_PANELS {
        return Err(input_error(format!("{n} panels exceed the cap of {MAX_PANELS}")));
    }
    if panels.iter().any(|v| !v.is_finite()) {
        return Err(input_error("panel values must be finite".to_string()));
    }
    let started = Instant::now();
    let dense = influence_matrix(panels);
    let a = Mat::<f64>::from_fn(n, n, |i, j| dense[i * n + j]);
    let build_ms = started.elapsed().as_millis();
    let (bx, bz) = basis_rhs(panels);
    let rhs = Mat::<f64>::from_fn(n, 2, |i, j| if j == 0 { bx[i] } else { bz[i] });
    let started = Instant::now();
    let lu = a.partial_piv_lu();
    let x = lu.solve(&rhs);
    let factor_ms = started.elapsed().as_millis();
    let gamma_x: Vec<f64> = (0..n).map(|i| x[(i, 0)]).collect();
    let gamma_z: Vec<f64> = (0..n).map(|i| x[(i, 1)]).collect();
    if gamma_x.iter().chain(&gamma_z).any(|v| !v.is_finite()) {
        return Err(JobError { code: "NATIVE_PANEL_SINGULAR", message: "the influence matrix is singular".to_string() });
    }
    let report = SolveReport {
        panels: n,
        threads: rayon::current_num_threads(),
        build_ms,
        factor_ms,
        residual_x: residual(&a, &gamma_x, &bx),
        residual_z: residual(&a, &gamma_z, &bz),
    };
    Ok((gamma_x, gamma_z, report))
}

/// Runs `llull-compute panel <folder>`.
pub fn run(folder: &Path) -> Result<Vec<Output>, JobError> {
    let job_path = folder.join("job.json");
    let text = fs::read_to_string(&job_path).map_err(|error| io_error(&job_path, &error))?;
    let job: PanelJob = serde_json::from_str(&text).map_err(|error| input_error(format!("job.json: {error}")))?;
    let panels_path = folder.join("panels.f64");
    let bytes = fs::read(&panels_path).map_err(|error| io_error(&panels_path, &error))?;
    if bytes.len() != job.panels * PANEL_STRIDE * 8 {
        return Err(input_error(format!(
            "panels.f64 holds {} bytes, {} panels need {}",
            bytes.len(),
            job.panels,
            job.panels * PANEL_STRIDE * 8
        )));
    }
    let panels: Vec<f64> = bytes.chunks_exact(8).map(|c| f64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]])).collect();
    let (gamma_x, gamma_z, report) = solve(&panels)?;
    let gamma: Vec<u8> = gamma_x.iter().chain(&gamma_z).flat_map(|v| v.to_le_bytes()).collect();
    let report_bytes = serde_json::to_vec(&report).map_err(|error| input_error(error.to_string()))?;
    let mut outputs = Vec::new();
    let wake: Vec<u8> = trefftz_basis(&panels, &gamma_x, &gamma_z).iter().flat_map(|v| v.to_le_bytes()).collect();
    for (name, content) in [("gamma.f64", gamma), ("trefftz.f64", wake), ("solve.json", report_bytes)] {
        let path = folder.join(name);
        fs::write(&path, &content).map_err(|error| io_error(&path, &error))?;
        outputs.push(Output { path: name.to_string(), sha256: sha256_hex(&content) });
    }
    Ok(outputs)
}

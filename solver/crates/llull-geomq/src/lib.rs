//! `llull-compute geomq <folder>` (RS1 RS-6, PHY-21 TR-FPR-19, PHY-03 TR-THM-20): the native `GeometryQueryEngine` batches.
//! Rust CPU, rayon over independent items, every number bit-identical to the TypeScript engine (`meshBvh.ts`, `viewFactorContour.ts`),
//! so the results are deterministic (`deterministic: true`) and the TS engine stays the oracle (VC-FPR-37, VC-THM-64).
//!
//! Job folder: `job.json` = `{ "op": "distance" | "ray" | "viewfactor", "surfaces"?: n, "obstruction"?: bool }` plus little-endian f64
//! files (`f64` NaN = "none"):
//! - `distance`: `meshes.f64` = mesh count, then per mesh its triangle count and 9 corners per triangle; `queries.f64` = 16 per query
//!   (a, b, placed 0/1, rotation 9 row-major, translation 3, maxDistance (may be +Inf)). Out `result.f64` = 7 per query: distance (NaN =
//!   none within maxDistance), witness on a (3), witness on b in a's frame (3).
//! - `ray`: `mesh.f64` = triangle count + corners; `rays.f64` = 8 per ray (origin 3, direction 3, tMin, maxT). Out `result.f64` = 5 per
//!   ray: t (NaN = miss), triangle index, point (3).
//! - `viewfactor`: `facets.f64` = 17 per facet (surface index or -1 for a blocker, corners 9, normal 3, centroid 3, area), owners in
//!   surface-major order before the blockers. Out `result.f64` = the n × n exchange matrix A_I F_IJ, row-major.
//!
//! Every op also writes `report.json` = `{ op, items, threads, ms }`.

pub mod tree;
pub mod triangle;
pub mod viewfactor;

use llull_protocol::{sha256_hex, Output};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::time::Instant;
use tree::{min_distance, ray_cast, MeshTree, Placement};
use viewfactor::{exchange_matrix, Facet};

/// A job failure: stable code + message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobError {
    pub code: &'static str,
    pub message: String,
}

fn input_error(message: impl Into<String>) -> JobError {
    JobError { code: "NATIVE_JOB_INPUT", message: message.into() }
}

#[derive(Debug, Deserialize)]
struct GeomqJob {
    op: String,
    #[serde(default)]
    surfaces: usize,
    #[serde(default)]
    obstruction: bool,
}

#[derive(Debug, Serialize)]
struct Report<'a> {
    op: &'a str,
    items: usize,
    threads: usize,
    ms: u128,
}

fn read_f64(folder: &Path, name: &str) -> Result<Vec<f64>, JobError> {
    let path = folder.join(name);
    let bytes = fs::read(&path).map_err(|error| JobError { code: "NATIVE_JOB_IO", message: format!("{}: {error}", path.display()) })?;
    if !bytes.len().is_multiple_of(8) {
        return Err(input_error(format!("{name}: {} bytes is not a whole number of f64", bytes.len())));
    }
    Ok(bytes.chunks_exact(8).map(|b| f64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]])).collect())
}

fn write(folder: &Path, name: &str, bytes: &[u8]) -> Result<Output, JobError> {
    let path = folder.join(name);
    fs::write(&path, bytes).map_err(|error| JobError { code: "NATIVE_JOB_IO", message: format!("{}: {error}", path.display()) })?;
    Ok(Output { path: name.to_string(), sha256: sha256_hex(bytes) })
}

fn f64_bytes(values: &[f64]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
}

fn count_of(value: f64, what: &str) -> Result<usize, JobError> {
    if value.is_finite() && value >= 0.0 && value.fract() == 0.0 {
        Ok(value as usize)
    } else {
        Err(input_error(format!("{what} {value} is not a count")))
    }
}

/// Triangle soups of `meshes.f64`.
pub fn parse_meshes(values: &[f64]) -> Result<Vec<Vec<f64>>, JobError> {
    let count = count_of(*values.first().ok_or_else(|| input_error("meshes.f64 is empty"))?, "mesh count")?;
    let mut meshes = Vec::with_capacity(count);
    let mut at = 1;
    for m in 0..count {
        let triangles =
            count_of(*values.get(at).ok_or_else(|| input_error(format!("mesh {m}: missing triangle count")))?, "triangle count")?;
        let end = triangles
            .checked_mul(9)
            .and_then(|n| n.checked_add(at + 1))
            .ok_or_else(|| input_error(format!("mesh {m}: {triangles} triangles")))?;
        let corners = values.get(at + 1..end).ok_or_else(|| input_error(format!("mesh {m}: {triangles} triangles past the end")))?;
        if !corners.iter().all(|v| v.is_finite()) {
            return Err(input_error(format!("mesh {m}: non-finite corner (the TS engine answers it)")));
        }
        meshes.push(corners.to_vec());
        at = end;
    }
    if at != values.len() {
        return Err(input_error(format!("meshes.f64 has {} trailing values", values.len() - at)));
    }
    Ok(meshes)
}

fn witness_row(hit: Option<triangle::ClosestPair>) -> [f64; 7] {
    hit.map_or([f64::NAN; 7], |h| [h.distance, h.point_a[0], h.point_a[1], h.point_a[2], h.point_b[0], h.point_b[1], h.point_b[2]])
}

/// `distance`: one closest pair per query (TS `placedDistanceBatch`), 7 numbers each.
pub fn distance_batch(meshes: Vec<Vec<f64>>, queries: &[f64]) -> Result<Vec<f64>, JobError> {
    if !queries.len().is_multiple_of(16) {
        return Err(input_error("queries.f64 is not 16 numbers per query"));
    }
    let trees: Vec<MeshTree> = meshes.into_par_iter().map(MeshTree::build).collect();
    let parsed: Vec<(usize, usize, Option<Placement>, f64)> = queries
        .chunks_exact(16)
        .enumerate()
        .map(|(k, q)| {
            let a = count_of(q[0], "mesh index")?;
            let b = count_of(q[1], "mesh index")?;
            if a >= trees.len() || b >= trees.len() {
                return Err(input_error(format!("query {k}: mesh index out of range")));
            }
            let mut rotation = [0.0; 9];
            rotation.copy_from_slice(&q[3..12]);
            let placement = (q[2] != 0.0).then_some(Placement { rotation, translation: [q[12], q[13], q[14]] });
            Ok((a, b, placement, q[15]))
        })
        .collect::<Result<_, JobError>>()?;
    let rows: Vec<[f64; 7]> = parsed
        .par_iter()
        .map(|(a, b, placement, max)| witness_row(min_distance(&trees[*a], &trees[*b], *max, placement.as_ref())))
        .collect();
    Ok(rows.into_iter().flatten().collect())
}

/// `ray`: first hit per ray (TS `rayCastBatch`), 5 numbers each.
pub fn ray_batch(mesh: Vec<f64>, rays: &[f64]) -> Result<Vec<f64>, JobError> {
    if !rays.len().is_multiple_of(8) {
        return Err(input_error("rays.f64 is not 8 numbers per ray"));
    }
    let tree = MeshTree::build(mesh);
    let rows: Vec<[f64; 5]> = rays
        .par_chunks_exact(8)
        .map(|r| {
            ray_cast(&tree, &[r[0], r[1], r[2]], &[r[3], r[4], r[5]], r[7], r[6])
                .map_or([f64::NAN; 5], |hit| [hit.t, hit.triangle as f64, hit.point[0], hit.point[1], hit.point[2]])
        })
        .collect();
    Ok(rows.into_iter().flatten().collect())
}

/// `viewfactor`: the exchange matrix of the owners, obstruction by owners + blockers when asked.
pub fn view_factor_batch(values: &[f64], surfaces: usize, obstruction: bool) -> Result<Vec<f64>, JobError> {
    if !values.len().is_multiple_of(17) {
        return Err(input_error("facets.f64 is not 17 numbers per facet"));
    }
    let mut owners: Vec<(usize, Facet)> = Vec::new();
    let mut blockers: Vec<Facet> = Vec::new();
    for (k, f) in values.chunks_exact(17).enumerate() {
        if !f.iter().all(|v| v.is_finite()) {
            return Err(input_error(format!("facet {k}: non-finite value (the TS engine answers it)")));
        }
        let facet = Facet {
            corners: [[f[1], f[2], f[3]], [f[4], f[5], f[6]], [f[7], f[8], f[9]]],
            normal: [f[10], f[11], f[12]],
            centroid: [f[13], f[14], f[15]],
            area: f[16],
        };
        if f[0] == -1.0 {
            blockers.push(facet);
            continue;
        }
        let surface = count_of(f[0], "surface index")?;
        if surface >= surfaces || !blockers.is_empty() || owners.last().is_some_and(|(s, _)| *s > surface) {
            return Err(input_error(format!("facet {k}: owners must be in surface-major order, before the blockers, below {surfaces}")));
        }
        owners.push((surface, facet));
    }
    Ok(exchange_matrix(&owners, obstruction.then_some(&blockers[..]), surfaces))
}

/// Runs the job in `folder`; returns the written outputs.
pub fn run(folder: &Path) -> Result<Vec<Output>, JobError> {
    let started = Instant::now();
    let text = fs::read_to_string(folder.join("job.json"))
        .map_err(|error| JobError { code: "NATIVE_JOB_IO", message: format!("job.json: {error}") })?;
    let job: GeomqJob = serde_json::from_str(&text).map_err(|error| input_error(format!("job.json: {error}")))?;
    let (result, items) = match job.op.as_str() {
        "distance" => {
            let queries = read_f64(folder, "queries.f64")?;
            (distance_batch(parse_meshes(&read_f64(folder, "meshes.f64")?)?, &queries)?, queries.len() / 16)
        }
        "ray" => {
            let mut meshes = parse_meshes(&[&[1.0][..], &read_f64(folder, "mesh.f64")?].concat())?;
            let rays = read_f64(folder, "rays.f64")?;
            (ray_batch(meshes.remove(0), &rays)?, rays.len() / 8)
        }
        "viewfactor" => {
            let facets = read_f64(folder, "facets.f64")?;
            (view_factor_batch(&facets, job.surfaces, job.obstruction)?, facets.len() / 17)
        }
        other => return Err(input_error(format!("unknown geomq op '{other}' (distance, ray, viewfactor)"))),
    };
    let report = Report { op: &job.op, items, threads: rayon::current_num_threads(), ms: started.elapsed().as_millis() };
    let report_json = serde_json::to_vec(&report).map_err(|error| input_error(error.to_string()))?;
    Ok(vec![write(folder, "result.f64", &f64_bytes(&result))?, write(folder, "report.json", &report_json)?])
}

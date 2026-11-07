//! `llull-compute flow-query <job-folder>` (12 CFD M3a; host `server/src/cfd/flowQuery.ts`, job builder
//! `packages/domain-aero/src/cfd/flowQuery.ts`): probes, a plane slice or streamlines on the recorded field of a solve.
//!
//! # Input: `job.json` (camelCase, unknown fields rejected) + the `field.bin` of the solve (`LLFD`, [`crate::field`])
//!
//! ```json
//! { "version": 1, "field": "field.bin", "fieldSha256": "…64 hex…",
//!   "frame": { "x": [1, 0, 0], "y": [0, 1, 0], "z": [0, 0, 1] },
//!   "op": "probe", "probe": { "pointsM": [[2, 0, 0]] } }
//! ```
//!
//! - `frame`: the case axes in world coordinates (orthonormal, right-handed). Every point, normal and vector of the job and of
//!   its outputs is WORLD metres / m/s; the job converts to the case frame of the field (`case = (p·x, p·y, p·z)`) and back.
//! - `fieldSha256`: the field file must hash to it (`NATIVE_JOB_INPUT` otherwise): a query never reads another solve.
//! - `op: "slice"`, `slice: { originM, normal, field: speed|p|cp|ux|uy|uz, spacingM, extentM, dynamicPressurePa }`: the square
//!   patch through `originM` (world components for `ux`..`uz`; `cp` = p / dynamicPressurePa).
//! - `op: "streamlines"`, `streamlines: { seedsM, stepM, maxLengthM, maxSteps, minSpeedMS, direction: both|forward|backward,
//!   toleranceM, device: cpu|gpu|auto }` ([`crate::streamline`]; at most 4096 seeds and 20000 steps per direction).
//!
//! # Outputs
//!
//! - `query.json`: `probe` → `{ probes: [{ pointM, velocityMS, speedMS, pressurePa, miss }] }` (`miss` null, `"outside"` or `"solid"`);
//!   `slice` → `{ slice: { file, field, samples, spacingM, originM, axisU, axisV, validSamples, min, max } }`; `streamlines` →
//!   `{ streamlines: { file, device, adapter?, deterministic, precision, points, lines: [{ seed, points, lengthM, stopBackward, stopForward }] } }`.
//! - `slice.bin` (`LLSL`, world frame) or `streamlines.bin`: `LLST`, u32 version 1, u32 lines, u32 points, u32 offsets[lines + 1],
//!   f32 xyz[points × 3] (world metres), f32 speed[points] (m/s).
//!
//! Events: `warning` `CFD_GPU_UNAVAILABLE` when a GPU was asked for and the CPU traced; `done` / `error` (`NATIVE_JOB_IO`,
//! `NATIVE_JOB_INPUT`).

use crate::field::{FlowField, Miss};
use crate::slice::square_plane;
use crate::streamline::{polyline, trace_cpu, Line, Settings, Traced};
use llull_protocol::{emit, sha256_hex, Event, Output};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::Path;

/// Named guards of the streamline job (TECHNICAL_SPEC §5.5: 4096 seeds).
pub const MAX_SEEDS: usize = 4096;
pub const MAX_STEPS: usize = 20_000;
pub const MAX_PROBES: usize = 100_000;
/// Seeds traced together on the CPU (bounds the undecimated points held at once).
const CPU_CHUNK: usize = 64;

#[derive(Debug, Clone, PartialEq)]
pub struct JobError {
    pub code: &'static str,
    pub message: String,
}

fn input(message: impl Into<String>) -> JobError {
    JobError { code: "NATIVE_JOB_INPUT", message: message.into() }
}

fn io(message: impl Into<String>) -> JobError {
    JobError { code: "NATIVE_JOB_IO", message: message.into() }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Frame {
    x: [f64; 3],
    y: [f64; 3],
    z: [f64; 3],
}

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Op {
    Probe,
    Slice,
    Streamlines,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProbeQuery {
    points_m: Vec<[f64; 3]>,
}

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum SliceField {
    Speed,
    P,
    Cp,
    Ux,
    Uy,
    Uz,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SliceQuery {
    origin_m: [f64; 3],
    normal: [f64; 3],
    field: SliceField,
    spacing_m: f64,
    extent_m: f64,
    dynamic_pressure_pa: f64,
}

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Direction {
    Both,
    Forward,
    Backward,
}

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Device {
    Cpu,
    Gpu,
    Auto,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StreamlineQuery {
    seeds_m: Vec<[f64; 3]>,
    step_m: f64,
    max_length_m: f64,
    max_steps: usize,
    #[serde(rename = "minSpeedMS")]
    min_speed_ms: f64,
    direction: Direction,
    tolerance_m: f64,
    device: Device,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueryFile {
    version: u32,
    field: String,
    field_sha256: String,
    frame: Frame,
    op: Op,
    probe: Option<ProbeQuery>,
    slice: Option<SliceQuery>,
    streamlines: Option<StreamlineQuery>,
}

/// World <-> case frame rotation.
struct Rotation {
    axes: [[f64; 3]; 3],
}

impl Rotation {
    fn new(frame: &Frame) -> Result<Rotation, JobError> {
        let axes = [frame.x, frame.y, frame.z];
        let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        for (i, a) in axes.iter().enumerate() {
            for (j, b) in axes.iter().enumerate() {
                let expected = if i == j { 1.0 } else { 0.0 };
                if (dot(*a, *b) - expected).abs().is_nan() || (dot(*a, *b) - expected).abs() > 1e-9 {
                    return Err(input("frame axes must be orthonormal"));
                }
            }
        }
        Ok(Rotation { axes })
    }

    fn to_case(&self, v: [f64; 3]) -> [f64; 3] {
        let dot = |a: [f64; 3]| a[0] * v[0] + a[1] * v[1] + a[2] * v[2];
        [dot(self.axes[0]), dot(self.axes[1]), dot(self.axes[2])]
    }

    fn to_world(&self, v: [f64; 3]) -> [f64; 3] {
        let [x, y, z] = self.axes;
        [x[0] * v[0] + y[0] * v[1] + z[0] * v[2], x[1] * v[0] + y[1] * v[1] + z[1] * v[2], x[2] * v[0] + y[2] * v[1] + z[2] * v[2]]
    }
}

fn finite(values: &[f64]) -> bool {
    values.iter().all(|v| v.is_finite())
}

fn probe_output(field: &FlowField, rotation: &Rotation, query: &ProbeQuery) -> Result<Value, JobError> {
    if query.points_m.len() > MAX_PROBES || query.points_m.iter().any(|p| !finite(p)) {
        return Err(input(format!("probe.pointsM must be at most {MAX_PROBES} finite points")));
    }
    let probes: Vec<Value> = query
        .points_m
        .iter()
        .map(|point| match field.sample(rotation.to_case(*point)) {
            Ok(sample) => {
                let velocity = rotation.to_world(sample.velocity);
                let speed = (velocity[0] * velocity[0] + velocity[1] * velocity[1] + velocity[2] * velocity[2]).sqrt();
                json!({ "pointM": point, "velocityMS": velocity, "speedMS": speed, "pressurePa": sample.pressure, "miss": null })
            }
            Err(miss) => json!({
                "pointM": point, "velocityMS": null, "speedMS": null, "pressurePa": null,
                "miss": if miss == Miss::Outside { "outside" } else { "solid" },
            }),
        })
        .collect();
    Ok(json!({ "probes": probes }))
}

fn slice_output(field: &FlowField, rotation: &Rotation, query: &SliceQuery) -> Result<(Value, Vec<u8>), JobError> {
    if !finite(&query.origin_m) || !finite(&query.normal) || !(query.dynamic_pressure_pa > 0.0 && query.dynamic_pressure_pa.is_finite()) {
        return Err(input("slice.originM / normal must be finite and dynamicPressurePa > 0"));
    }
    let plane = square_plane(query.origin_m, query.normal, query.spacing_m, query.extent_m).map_err(input)?;
    let value = |point: [f64; 3]| -> Option<f64> {
        let sample = field.sample(rotation.to_case(point)).ok()?;
        let velocity = rotation.to_world(sample.velocity);
        Some(match query.field {
            SliceField::Speed => (velocity[0] * velocity[0] + velocity[1] * velocity[1] + velocity[2] * velocity[2]).sqrt(),
            SliceField::P => sample.pressure,
            SliceField::Cp => sample.pressure / query.dynamic_pressure_pa,
            SliceField::Ux => velocity[0],
            SliceField::Uy => velocity[1],
            SliceField::Uz => velocity[2],
        })
    };
    let values = plane.sample(value);
    let name = match query.field {
        SliceField::Speed => "speed",
        SliceField::P => "p",
        SliceField::Cp => "cp",
        SliceField::Ux => "ux",
        SliceField::Uy => "uy",
        SliceField::Uz => "uz",
    };
    let finite_values: Vec<f32> = values.iter().copied().filter(|v| v.is_finite()).collect();
    let min = finite_values.iter().copied().reduce(f32::min).map(f64::from);
    let max = finite_values.iter().copied().reduce(f32::max).map(f64::from);
    let summary = json!({ "slice": {
        "file": "slice.bin", "field": name, "samples": plane.samples, "spacingM": plane.spacing, "originM": plane.origin,
        "axisU": plane.axis_u, "axisV": plane.axis_v, "validSamples": finite_values.len(), "min": min, "max": max,
    }});
    Ok((summary, plane.encode(name, &values)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LineInfo {
    seed: usize,
    points: usize,
    length_m: f64,
    stop_backward: &'static str,
    stop_forward: &'static str,
}

/// The traced seeds (case frame) on the requested device; `(traced, device, adapter, warning)`.
fn trace(
    field: &FlowField,
    seeds: &[[f64; 3]],
    settings: &Settings,
    device: Device,
) -> (Vec<Traced>, &'static str, Option<String>, Option<String>) {
    if device != Device::Cpu {
        match gpu_trace(field, seeds, settings) {
            Ok((traced, adapter)) => return (traced, "gpu", Some(adapter), None),
            Err(reason) => {
                let traced = seeds.chunks(CPU_CHUNK).flat_map(|chunk| trace_cpu(field, chunk, settings)).collect();
                return (traced, "cpu", None, Some(reason));
            }
        }
    }
    (seeds.chunks(CPU_CHUNK).flat_map(|chunk| trace_cpu(field, chunk, settings)).collect(), "cpu", None, None)
}

#[cfg(feature = "gpu")]
fn gpu_trace(field: &FlowField, seeds: &[[f64; 3]], settings: &Settings) -> Result<(Vec<Traced>, String), String> {
    crate::gpu_streamline::trace_gpu(field, seeds, settings)
}

#[cfg(not(feature = "gpu"))]
fn gpu_trace(_field: &FlowField, _seeds: &[[f64; 3]], _settings: &Settings) -> Result<(Vec<Traced>, String), String> {
    Err("llull-compute was built without the gpu feature".to_string())
}

fn streamlines_output(
    field: &FlowField,
    rotation: &Rotation,
    query: &StreamlineQuery,
    out: &mut impl Write,
) -> Result<(Value, Vec<u8>), JobError> {
    if query.seeds_m.is_empty() || query.seeds_m.len() > MAX_SEEDS || query.seeds_m.iter().any(|p| !finite(p)) {
        return Err(input(format!("streamlines.seedsM must hold 1..{MAX_SEEDS} finite points")));
    }
    if query.max_steps == 0 || query.max_steps > MAX_STEPS {
        return Err(input(format!("streamlines.maxSteps must be in 1..{MAX_STEPS}")));
    }
    let positive = [query.step_m, query.max_length_m, query.tolerance_m];
    if !positive.iter().all(|v| *v > 0.0 && v.is_finite()) || !(query.min_speed_ms >= 0.0 && query.min_speed_ms.is_finite()) {
        return Err(input("streamlines.stepM, maxLengthM, toleranceM must be > 0 and minSpeedMS >= 0"));
    }
    let settings = Settings {
        step_m: query.step_m,
        max_length_m: query.max_length_m,
        max_steps: query.max_steps,
        min_speed_ms: query.min_speed_ms,
        forward: query.direction != Direction::Backward,
        backward: query.direction != Direction::Forward,
    };
    let seeds: Vec<[f64; 3]> = query.seeds_m.iter().map(|seed| rotation.to_case(*seed)).collect();
    let (traced, device, adapter, fallback) = trace(field, &seeds, &settings, query.device);
    if let Some(reason) = &fallback {
        if query.device == Device::Gpu {
            let message = format!("no usable GPU adapter ({reason}): the CPU traced the streamlines");
            let _ = emit(out, &Event::Warning { code: "CFD_GPU_UNAVAILABLE", message: &message });
        }
    }
    let lines: Vec<Line> = seeds.iter().zip(&traced).map(|(seed, t)| polyline(*seed, t, query.tolerance_m)).collect();
    let total: usize = lines.iter().map(|line| line.points.len()).sum();
    let mut bytes = b"LLST".to_vec();
    for value in [1u32, lines.len() as u32, total as u32] {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    let mut offset = 0u32;
    bytes.extend_from_slice(&offset.to_le_bytes());
    for line in &lines {
        offset += line.points.len() as u32;
        bytes.extend_from_slice(&offset.to_le_bytes());
    }
    for point in lines.iter().flat_map(|line| &line.points) {
        for value in rotation.to_world(*point) {
            bytes.extend_from_slice(&(value as f32).to_le_bytes());
        }
    }
    for speed in lines.iter().flat_map(|line| &line.speeds) {
        bytes.extend_from_slice(&(*speed as f32).to_le_bytes());
    }
    let info: Vec<LineInfo> = lines
        .iter()
        .enumerate()
        .map(|(seed, line)| LineInfo {
            seed,
            points: line.points.len(),
            length_m: line.length_m,
            stop_backward: line.stop_backward.name(),
            stop_forward: line.stop_forward.name(),
        })
        .collect();
    let mut summary = json!({
        "file": "streamlines.bin", "device": device, "deterministic": device == "cpu",
        "precision": if device == "cpu" { "f64" } else { "f32" }, "points": total, "lines": info,
    });
    if let Some(adapter) = adapter {
        summary["adapter"] = json!(adapter);
    }
    if let (Some(reason), Device::Auto) = (fallback, query.device) {
        summary["gpuFallback"] = json!(reason);
    }
    Ok((json!({ "streamlines": summary }), bytes))
}

/// Runs the query in `folder`; returns the outputs with their hashes.
pub fn run(folder: &Path, out: &mut impl Write) -> Result<Vec<Output>, JobError> {
    let text = fs::read_to_string(folder.join("job.json")).map_err(|error| io(format!("job.json: {error}")))?;
    let job: QueryFile = serde_json::from_str(&text).map_err(|error| input(format!("job.json: {error}")))?;
    if job.version != 1 {
        return Err(input(format!("job.json version {} is not 1", job.version)));
    }
    let rotation = Rotation::new(&job.frame)?;
    let bytes = fs::read(folder.join(&job.field)).map_err(|error| io(format!("{}: {error}", job.field)))?;
    if sha256_hex(&bytes) != job.field_sha256 {
        return Err(input(format!("{} does not hash to fieldSha256", job.field)));
    }
    let field = FlowField::from_bytes(&bytes).map_err(input)?;
    drop(bytes);
    let missing = |name: &str| input(format!("op {name} needs the '{name}' section"));
    let (mut summary, file) = match job.op {
        Op::Probe => (probe_output(&field, &rotation, job.probe.as_ref().ok_or_else(|| missing("probe"))?)?, None),
        Op::Slice => {
            let (summary, bytes) = slice_output(&field, &rotation, job.slice.as_ref().ok_or_else(|| missing("slice"))?)?;
            (summary, Some(("slice.bin", bytes)))
        }
        Op::Streamlines => {
            let query = job.streamlines.as_ref().ok_or_else(|| missing("streamlines"))?;
            let (summary, bytes) = streamlines_output(&field, &rotation, query, out)?;
            (summary, Some(("streamlines.bin", bytes)))
        }
    };
    summary["version"] = json!(1);
    let mut outputs = Vec::new();
    let mut write = |name: &str, bytes: &[u8]| -> Result<(), JobError> {
        fs::write(folder.join(name), bytes).map_err(|error| io(format!("{name}: {error}")))?;
        outputs.push(Output { path: name.to_string(), sha256: sha256_hex(bytes) });
        Ok(())
    };
    if let Some((name, bytes)) = file {
        write(name, &bytes)?;
    }
    let json = serde_json::to_vec(&summary).map_err(|error| io(format!("query.json: {error}")))?;
    write("query.json", &json)?;
    Ok(outputs)
}

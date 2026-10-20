//! `llull-compute explicit <job-folder>`: the job folder contract (PHY-19 TECHNICAL_SPEC §13.3; host side
//! `server/src/native/explicitJobFiles.ts`).
//!
//! # Input: `job.json` (camelCase, unknown fields rejected)
//!
//! ```json
//! {
//!   "version": 1,
//!   "nodes": "nodes.f64", "hex8": "hex8.u32", "tet4": "tet4.u32", "elementMaterial": "elmat.u32", "initialVelocity": "velocity.f64",
//!   "materials": [{ "density": 7.85e-9, "youngsModulus": 200000, "poisson": 0.3,
//!                   "johnsonCook": { "a": 300, "b": 500, "n": 0.5, "c": 0.02, "referenceRate": 1, "m": 1, "meltK": 1800, "transitionK": 293 },
//!                   "johnsonCookFailure": { "d": [0.05, 3.44, -2.12, 0.002, 0.61] } }],
//!   "gravity": [0, 0, 0],
//!   "walls": [{ "name": "anvil", "point": [5, 5, 0], "normal": [0, 0, 1] }],
//!   "controls": { "endTime": 1.6e-4, "historyInterval": 1e-6, "timeStepScale": 0.9, "minTimeStep": 1e-12, "hourglassCoefficient": 0.1,
//!                 "bulkLinear": 0.06, "bulkQuadratic": 1.5, "massScaling": { "targetTimeStep": 1e-7, "maxAddedMassRatio": 0.05 },
//!                 "maxCycles": 50000000 },
//!   "device": "cpu"
//! }
//! ```
//!
//! - Units are consistent and never converted (N-mm-t-s: mm, s, t, MPa, mJ; N-m-kg-s: SI).
//! - Binary arrays are little-endian: `nodes` 3 × f64 per node, `hex8` 8 × u32 per element, `tet4` 4 × u32 per element (either may be
//!   absent, not both), `elementMaterial` one u32 per element (hex8 first, then tet4), `initialVelocity` 3 × f64 per node.
//! - Optional shells (RS-8c): `shell4` (4 × u32 per Belytschko–Tsay shell, after hex8 and tet4 in `elementMaterial` order),
//!   `shellThickness` (f64 per shell), `shellPoints` (Gauss points through the thickness, 1..5, default 2), `fixedRotation` (u8 per
//!   rotational DOF).
//! - Optional (RS-8c): `elementPart` (u32 per element, parts 0..), `fixed` (u8 per DOF, non-zero = velocity held at 0) and `contacts`:
//!   `[{ "name", "kind": "surface_to_surface" | "nodes_to_surface" | "self", "a": [parts] (the slaves of
//!   nodes_to_surface), "b": [parts], "staticFriction", "dynamicFriction", "decay",
//!   "penaltyScale" }]` (friction 0 by default, dynamic = static when absent, penalty scale 0.1 = LS-DYNA SLSFAC).
//! - Optional (RS-8): per material `heating` `{ "taylorQuinney": 0.9, "specificHeat": 4.6e8 }` (adiabatic heating of the Johnson–Cook
//!   plastic work), `initialTemperature` (K; default: each Johnson–Cook material at its transition temperature), `shellWarping`
//!   (Belytschko–Leviathan warping projection of the shells, default true).
//! - `device`: `cpu` (default, deterministic Rust path) | `gpu` | `auto`. Without the GPU kernels (feature) or an f64 adapter a GPU
//!   request runs the CPU twin and reports the warning `EXP_GPU_FALLBACK`; contacts, fixed DOFs and shells run on the GPU path (contact
//!   and shells as its deterministic host part, `gpu.rs`).
//!
//! # Events (stdout NDJSON, `llull-protocol`)
//!
//! `progress` about every 1 % of the end time: `{"step":k,"total":100,"cycle":…,"time":…,"endTime":…,"dt":…}`; `warning`; then `done`
//! with the outputs and their sha256, or `error` with `NATIVE_JOB_IO`, `NATIVE_JOB_INPUT` or `EXP_SOLVER_FAILED`.
//!
//! # Outputs
//!
//! - `result.json`: `version`, `termination` (`normal` | `abnormal`), `message`, `cycles`, `finalTime`, `minTimeStep`, `initialMass`,
//!   `addedMass`, `elements` {hex8, tet4}, `device` (`cpu` | `gpu`), `adapter` (GPU only), `deterministic` (true), `energy` (rows
//!   `[t, kinetic, internal, hourglass, wall, contact, externalWork]`, one per history interval plus t = 0 and the end), `walls` ([{name, t[], force[]}], the normal force averaged
//!   over each history interval = impulse / interval).
//! - `fields.f64`: per element `[von Mises, equivalent plastic strain, failed (0/1), centroid x, y, z]` at the end, little-endian f64.
//!   Every output is byte-identical across runs and thread counts.

use crate::model::{
    Contact, ContactKind, Controls, Friction, Heating, JohnsonCook, JohnsonCookFailure, MassScaling, Material, Model, Wall,
};
use crate::solver::{run, Outcome, Progress};
use llull_protocol::{emit, sha256_hex, Event, Output};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::Path;

/// A job failure: a stable code and a message.
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
struct JohnsonCookSpec {
    a: f64,
    b: f64,
    n: f64,
    c: f64,
    reference_rate: f64,
    m: f64,
    melt_k: f64,
    transition_k: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MaterialSpec {
    density: f64,
    youngs_modulus: f64,
    poisson: f64,
    johnson_cook: Option<JohnsonCookSpec>,
    johnson_cook_failure: Option<FailureSpec>,
    heating: Option<HeatingSpec>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HeatingSpec {
    taylor_quinney: f64,
    specific_heat: f64,
    #[serde(default)]
    specific_heat_table: Vec<[f64; 2]>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FailureSpec {
    d: [f64; 5],
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WallSpec {
    name: String,
    point: [f64; 3],
    normal: [f64; 3],
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MassScalingSpec {
    target_time_step: f64,
    max_added_mass_ratio: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ControlsSpec {
    end_time: f64,
    history_interval: f64,
    time_step_scale: f64,
    min_time_step: Option<f64>,
    hourglass_coefficient: f64,
    bulk_linear: f64,
    bulk_quadratic: f64,
    mass_scaling: Option<MassScalingSpec>,
    max_cycles: Option<u64>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum DeviceName {
    #[default]
    Cpu,
    Gpu,
    Auto,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ContactKindName {
    SurfaceToSurface,
    NodesToSurface,
    #[serde(rename = "self")]
    SelfContact,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContactSpec {
    name: String,
    kind: ContactKindName,
    a: Vec<u32>,
    #[serde(default)]
    b: Vec<u32>,
    #[serde(default)]
    static_friction: f64,
    dynamic_friction: Option<f64>,
    #[serde(default)]
    decay: f64,
    penalty_scale: Option<f64>,
}

/// LS-DYNA SLSFAC default ([E3] *CONTROL_CONTACT).
const DEFAULT_PENALTY_SCALE: f64 = 0.1;

fn contact_of(spec: ContactSpec) -> Result<Contact, JobError> {
    let dynamic = spec.dynamic_friction.unwrap_or(spec.static_friction);
    let penalty = spec.penalty_scale.unwrap_or(DEFAULT_PENALTY_SCALE);
    if !(spec.static_friction >= 0.0 && dynamic >= 0.0 && spec.decay >= 0.0 && penalty > 0.0)
        || !finite(&[spec.static_friction, dynamic, spec.decay, penalty])
    {
        return Err(input(format!("contact '{}' needs friction and decay >= 0 and penaltyScale > 0", spec.name)));
    }
    let kind = match spec.kind {
        ContactKindName::SurfaceToSurface if !spec.a.is_empty() && !spec.b.is_empty() => {
            ContactKind::SurfaceToSurface { a: spec.a, b: spec.b }
        }
        ContactKindName::NodesToSurface if !spec.a.is_empty() && !spec.b.is_empty() => {
            ContactKind::NodesToSurface { slave: spec.a, master: spec.b }
        }
        ContactKindName::SelfContact if !spec.a.is_empty() => ContactKind::SelfContact { parts: spec.a },
        _ => return Err(input(format!("contact '{}' needs parts in a (and b for surface_to_surface / nodes_to_surface)", spec.name))),
    };
    Ok(Contact {
        name: spec.name,
        kind,
        friction: Friction { static_coefficient: spec.static_friction, dynamic_coefficient: dynamic, decay: spec.decay },
        penalty_scale: penalty,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JobSpec {
    version: u32,
    nodes: String,
    hex8: Option<String>,
    tet4: Option<String>,
    element_material: String,
    initial_velocity: String,
    materials: Vec<MaterialSpec>,
    #[serde(default)]
    gravity: [f64; 3],
    #[serde(default)]
    walls: Vec<WallSpec>,
    controls: ControlsSpec,
    #[serde(default)]
    device: DeviceName,
    element_part: Option<String>,
    fixed: Option<String>,
    shell4: Option<String>,
    shell_thickness: Option<String>,
    shell_points: Option<usize>,
    shell_warping: Option<bool>,
    initial_temperature: Option<f64>,
    fixed_rotation: Option<String>,
    #[serde(default)]
    contacts: Vec<ContactSpec>,
}

/// Default cap on cycles when the job gives none.
const DEFAULT_MAX_CYCLES: u64 = 50_000_000;

fn read_bytes(folder: &Path, name: &str) -> Result<Vec<u8>, JobError> {
    if Path::new(name).file_name().map(|file| file != name).unwrap_or(true) {
        return Err(input(format!("'{name}' is not a plain file name")));
    }
    fs::read(folder.join(name)).map_err(|error| io(format!("cannot read {name}: {error}")))
}

fn read_f64(folder: &Path, name: &str) -> Result<Vec<f64>, JobError> {
    let bytes = read_bytes(folder, name)?;
    if bytes.len() % 8 != 0 {
        return Err(input(format!("{name} is not a whole number of f64 values")));
    }
    Ok(bytes.chunks_exact(8).map(|chunk| f64::from_le_bytes(chunk.try_into().unwrap_or([0; 8]))).collect())
}

fn read_u32(folder: &Path, name: &str) -> Result<Vec<u32>, JobError> {
    let bytes = read_bytes(folder, name)?;
    if bytes.len() % 4 != 0 {
        return Err(input(format!("{name} is not a whole number of u32 values")));
    }
    Ok(bytes.chunks_exact(4).map(|chunk| u32::from_le_bytes(chunk.try_into().unwrap_or([0; 4]))).collect())
}

fn finite(values: &[f64]) -> bool {
    values.iter().all(|value| value.is_finite())
}

fn material_of(spec: MaterialSpec) -> Result<Material, JobError> {
    if !(spec.density > 0.0 && spec.youngs_modulus > 0.0 && spec.poisson > -1.0 && spec.poisson < 0.5)
        || !finite(&[spec.density, spec.youngs_modulus])
    {
        return Err(input("a material needs density > 0, youngsModulus > 0 and poisson in (-1, 0.5)"));
    }
    let johnson_cook = match spec.johnson_cook {
        None => None,
        Some(jc) => {
            if !(jc.a > 0.0 && jc.b >= 0.0 && jc.n >= 0.0 && jc.c >= 0.0 && jc.reference_rate > 0.0 && jc.melt_k > jc.transition_k)
                || !finite(&[jc.a, jc.b, jc.n, jc.c, jc.reference_rate, jc.m])
            {
                return Err(input("johnsonCook needs a > 0, b, n, c >= 0, referenceRate > 0 and meltK > transitionK"));
            }
            Some(JohnsonCook {
                a: jc.a,
                b: jc.b,
                n: jc.n,
                c: jc.c,
                reference_rate: jc.reference_rate,
                m: jc.m,
                melt_k: jc.melt_k,
                transition_k: jc.transition_k,
            })
        }
    };
    let failure = match (spec.johnson_cook_failure, johnson_cook) {
        (None, _) => None,
        (Some(failure), Some(strength)) if finite(&failure.d) => {
            Some(JohnsonCookFailure { d: failure.d, reference_rate: strength.reference_rate })
        }
        (Some(_), _) => return Err(input("johnsonCookFailure needs five finite D values and a johnsonCook strength (its plastic strain)")),
    };
    let heating = match spec.heating {
        None => None,
        Some(heat)
            if (0.0..=1.0).contains(&heat.taylor_quinney)
                && heat.specific_heat > 0.0
                && heat.specific_heat.is_finite()
                && heat.specific_heat_table.iter().all(|[t, c]| t.is_finite() && *c > 0.0 && c.is_finite())
                && heat.specific_heat_table.windows(2).all(|pair| pair[0][0] < pair[1][0]) =>
        {
            Some(Heating {
                taylor_quinney: heat.taylor_quinney,
                specific_heat: heat.specific_heat,
                specific_heat_table: heat.specific_heat_table,
            })
        }
        Some(_) => {
            return Err(input(
                "heating needs taylorQuinney in [0, 1], specificHeat > 0 and a specificHeatTable increasing in T with c_p > 0",
            ))
        }
    };
    Ok(Material { density: spec.density, youngs_modulus: spec.youngs_modulus, poisson: spec.poisson, johnson_cook, failure, heating })
}

fn controls_of(spec: ControlsSpec) -> Result<Controls, JobError> {
    let ControlsSpec {
        end_time, history_interval, time_step_scale, min_time_step, hourglass_coefficient, bulk_linear, bulk_quadratic, ..
    } = spec;
    if !(end_time > 0.0 && history_interval > 0.0 && history_interval <= end_time) || !end_time.is_finite() {
        return Err(input("controls need 0 < historyInterval <= endTime"));
    }
    if !(time_step_scale > 0.0 && time_step_scale <= 1.0)
        || !(hourglass_coefficient >= 0.0)
        || !(bulk_linear >= 0.0 && bulk_quadratic >= 0.0)
    {
        return Err(input("controls need timeStepScale in (0, 1] and non-negative hourglass and bulk viscosity coefficients"));
    }
    let mass_scaling = match spec.mass_scaling {
        None => None,
        Some(scaling) if scaling.target_time_step > 0.0 && scaling.max_added_mass_ratio >= 0.0 => {
            Some(MassScaling { target_time_step: scaling.target_time_step, max_added_mass_ratio: scaling.max_added_mass_ratio })
        }
        Some(_) => return Err(input("massScaling needs targetTimeStep > 0 and maxAddedMassRatio >= 0")),
    };
    Ok(Controls {
        end_time,
        history_interval,
        time_step_scale,
        min_time_step,
        hourglass_coefficient,
        bulk_linear,
        bulk_quadratic,
        mass_scaling,
        max_cycles: spec.max_cycles.unwrap_or(DEFAULT_MAX_CYCLES),
    })
}

/// The model of a job folder, validated (indices in range, unit wall normals, finite values).
pub fn load(folder: &Path) -> Result<(Model, bool), JobError> {
    let text = fs::read_to_string(folder.join("job.json")).map_err(|error| io(format!("cannot read job.json: {error}")))?;
    let spec: JobSpec = serde_json::from_str(&text).map_err(|error| input(format!("job.json: {error}")))?;
    if spec.version != 1 {
        return Err(input(format!("job.json version {} is not supported (1)", spec.version)));
    }
    let coordinates = read_f64(folder, &spec.nodes)?;
    let hex8 = match &spec.hex8 {
        Some(name) => read_u32(folder, name)?,
        None => Vec::new(),
    };
    let tet4 = match &spec.tet4 {
        Some(name) => read_u32(folder, name)?,
        None => Vec::new(),
    };
    let element_material = read_u32(folder, &spec.element_material)?;
    let initial_velocity = read_f64(folder, &spec.initial_velocity)?;
    let materials = spec.materials.into_iter().map(material_of).collect::<Result<Vec<_>, _>>()?;
    let walls = spec
        .walls
        .into_iter()
        .map(|wall| {
            let length = wall.normal.iter().map(|value| value * value).sum::<f64>().sqrt();
            if !(length > 0.0) || !finite(&wall.point) || !length.is_finite() {
                return Err(input(format!("wall '{}' needs a finite point and a non-zero normal", wall.name)));
            }
            Ok(Wall { name: wall.name, point: wall.point, normal: wall.normal.map(|value| value / length) })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let model = Model {
        coordinates,
        hex8,
        tet4,
        element_material,
        materials,
        initial_velocity,
        gravity: spec.gravity,
        walls,
        controls: controls_of(spec.controls)?,
        element_part: match &spec.element_part {
            Some(name) => read_u32(folder, name)?,
            None => Vec::new(),
        },
        contacts: spec.contacts.into_iter().map(contact_of).collect::<Result<Vec<_>, _>>()?,
        fixed: match &spec.fixed {
            Some(name) => read_bytes(folder, name)?.into_iter().map(|byte| byte != 0).collect(),
            None => Vec::new(),
        },
        shell4: match &spec.shell4 {
            Some(name) => read_u32(folder, name)?,
            None => Vec::new(),
        },
        shell_thickness: match &spec.shell_thickness {
            Some(name) => read_f64(folder, name)?,
            None => Vec::new(),
        },
        shell_points: spec.shell_points.unwrap_or(2),
        shell_warping: spec.shell_warping.unwrap_or(true),
        initial_temperature: spec.initial_temperature,
        fixed_rotation: match &spec.fixed_rotation {
            Some(name) => read_bytes(folder, name)?.into_iter().map(|byte| byte != 0).collect(),
            None => Vec::new(),
        },
    };
    validate(&model)?;
    Ok((model, spec.device != DeviceName::Cpu))
}

/// Shape and index checks of a model.
pub fn validate(model: &Model) -> Result<(), JobError> {
    let nodes = model.node_count();
    if !model.coordinates.len().is_multiple_of(3) || nodes == 0 || !finite(&model.coordinates) {
        return Err(input("nodes must hold 3 finite values per node"));
    }
    if !model.hex8.len().is_multiple_of(8) || !model.tet4.len().is_multiple_of(4) || model.element_count() == 0 {
        return Err(input("hex8 needs 8 and tet4 4 indices per element, and there must be at least one element"));
    }
    if !model.shell4.len().is_multiple_of(4)
        || model.shell_thickness.len() != model.shell_count()
        || model.shell_thickness.iter().any(|&t| !(t > 0.0 && t.is_finite()))
        || !(1..=5).contains(&model.shell_points)
        || (!model.fixed_rotation.is_empty() && model.fixed_rotation.len() != 3 * nodes)
    {
        return Err(input("shell4 needs 4 indices and one thickness > 0 per shell, shellPoints 1..5, fixedRotation one byte per DOF"));
    }
    if model.hex8.iter().chain(model.tet4.iter()).chain(model.shell4.iter()).any(|&node| node as usize >= nodes) {
        return Err(input("an element references a node that does not exist"));
    }
    if model.element_material.len() != model.element_count()
        || model.element_material.iter().any(|&index| index as usize >= model.materials.len())
    {
        return Err(input("elementMaterial needs one valid material index per element"));
    }
    if (!model.element_part.is_empty() && model.element_part.len() != model.element_count())
        || (!model.fixed.is_empty() && model.fixed.len() != 3 * nodes)
    {
        return Err(input("elementPart needs one value per element and fixed one byte per DOF"));
    }
    if model.initial_velocity.len() != 3 * nodes || !finite(&model.initial_velocity) || !finite(&model.gravity) {
        return Err(input("initialVelocity needs 3 finite values per node and gravity 3 finite values"));
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ElementCounts {
    hex8: usize,
    tet4: usize,
    shell4: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WallOutput<'a> {
    name: &'a str,
    t: &'a [f64],
    force: &'a [f64],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResultFile<'a> {
    version: u32,
    termination: &'static str,
    message: &'a str,
    cycles: u64,
    final_time: f64,
    min_time_step: f64,
    initial_mass: f64,
    added_mass: f64,
    elements: ElementCounts,
    device: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    adapter: Option<&'a str>,
    deterministic: bool,
    energy: Vec<[f64; 7]>,
    walls: Vec<WallOutput<'a>>,
}

/// The bytes of `result.json` and `fields.f64` for an outcome.
/// `adapter` is the GPU that ran the kernels, `None` for the CPU path. Both paths are deterministic (no atomics, fixed-order sums).
pub fn outputs(model: &Model, outcome: &Outcome, adapter: Option<&str>) -> Result<(Vec<u8>, Vec<u8>), JobError> {
    let result = ResultFile {
        version: 1,
        termination: if outcome.normal { "normal" } else { "abnormal" },
        message: &outcome.message,
        cycles: outcome.cycles,
        final_time: outcome.final_time,
        min_time_step: outcome.min_time_step,
        initial_mass: outcome.initial_mass,
        added_mass: outcome.added_mass,
        elements: ElementCounts { hex8: model.hex_count(), tet4: model.tet_count(), shell4: model.shell_count() },
        device: if adapter.is_some() { "gpu" } else { "cpu" },
        adapter,
        deterministic: true,
        energy: outcome
            .energy
            .iter()
            .map(|row| [row.time, row.kinetic, row.internal, row.hourglass, row.wall, row.contact, row.external_work])
            .collect(),
        walls: outcome.walls.iter().map(|wall| WallOutput { name: &wall.name, t: &wall.times, force: &wall.forces }).collect(),
    };
    let json = serde_json::to_vec(&result).map_err(|error| io(format!("result.json: {error}")))?;
    let mut fields = Vec::with_capacity(model.element_count() * crate::solver::FIELD_STRIDE * 8);
    for value in &outcome.fields {
        fields.extend_from_slice(&value.to_le_bytes());
    }
    Ok((json, fields))
}

/// The run on the requested device: `(outcome, adapter, fallback reason)`.
#[allow(clippy::type_complexity)]
fn solve(model: &Model, wants_gpu: bool, report: &mut impl FnMut(Progress)) -> Result<(Outcome, Option<String>, Option<String>), JobError> {
    let failed = |message: String| JobError { code: "EXP_SOLVER_FAILED", message };
    if !wants_gpu {
        return Ok((run(model, report).map_err(failed)?, None, None));
    }
    #[cfg(feature = "gpu")]
    {
        match crate::gpu::run(model, report) {
            Ok((outcome, adapter)) => Ok((outcome, Some(adapter), None)),
            Err(reason) => Ok((run(model, report).map_err(failed)?, None, Some(reason))),
        }
    }
    #[cfg(not(feature = "gpu"))]
    {
        Ok((run(model, report).map_err(failed)?, None, Some("this llull-compute was built without the gpu feature".to_string())))
    }
}

/// Runs the job in `folder`: progress events to `out`, outputs written next to `job.json`.
pub fn run_job(folder: &Path, out: &mut impl Write) -> Result<Vec<Output>, JobError> {
    let (model, wants_gpu) = load(folder)?;
    let mut last_step = 0u64;
    let end_time = model.controls.end_time;
    let mut report = |progress: Progress| {
        let step = ((progress.time / end_time) * 100.0).floor().clamp(0.0, 100.0) as u64;
        if step > last_step {
            last_step = step;
            let mut detail = serde_json::Map::new();
            detail.insert("cycle".into(), serde_json::json!(progress.cycle));
            detail.insert("time".into(), serde_json::json!(progress.time));
            detail.insert("endTime".into(), serde_json::json!(end_time));
            detail.insert("dt".into(), serde_json::json!(progress.dt));
            let _ = emit(out, &Event::Progress { step, total: 100, message: "explicit", detail: Some(detail) });
        }
    };
    let (outcome, adapter, fallback) = solve(&model, wants_gpu, &mut report)?;
    if let Some(reason) = fallback {
        let message = format!("GPU kernels not used ({reason}): the deterministic CPU twin ran");
        let _ = emit(out, &Event::Warning { code: "EXP_GPU_FALLBACK", message: &message });
    }
    let (json, fields) = outputs(&model, &outcome, adapter.as_deref())?;
    let mut written = Vec::new();
    for (name, bytes) in [("fields.f64", fields), ("result.json", json)] {
        fs::write(folder.join(name), &bytes).map_err(|error| io(format!("cannot write {name}: {error}")))?;
        written.push(Output { path: name.to_string(), sha256: sha256_hex(&bytes) });
    }
    Ok(written)
}

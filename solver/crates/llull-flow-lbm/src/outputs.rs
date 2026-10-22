//! Physical results of a run: SI fields from the lattice averages, force coefficients, peaks, probes, the capped history, and the
//! binary files M3 reads (`surface.bin`: `LLSF`, u32 version 1, u32 triangles, u32 fields, then per field a 16-byte ASCII name and
//! f32 × triangles; `slice-<k>.bin`: `LLSL`, u32 version 1, u32 nu, u32 nv, f32 origin[3], f32 axisU[3], f32 axisV[3], f32 spacing,
//! 16-byte field name, f32 × nu × nv row-major in v then u; NaN where the sample falls in a solid or outside the grid).

use crate::domain::Domain;
use crate::job::{JobError, SliceField, SliceSpec};
use crate::solver::{Phase, RunOutcome};
use crate::units::Lattice;
use llull_flow_core::reduce::extrema;
use llull_flow_core::sample::{surface_values, trilinear};
use llull_flow_core::stl::Triangle;
use serde::Serialize;

/// Largest slice resolution per axis.
const MAX_SLICE_SAMPLES: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WarningEntry {
    pub code: String,
    pub message: String,
}

/// SI fields per cell (time averaged).
pub struct Fields {
    pub pressure_pa: Vec<f32>,
    pub speed_ms: Vec<f32>,
    pub velocity_ms: Vec<[f32; 3]>,
    pub valid: Vec<bool>,
}

pub fn convert_fields(domain: &Domain, outcome: &RunOutcome, lattice: &Lattice) -> Fields {
    let scale = (lattice.h / lattice.dt) as f32;
    let velocity_ms: Vec<[f32; 3]> = outcome.vel.iter().map(|u| [u[0] * scale, u[1] * scale, u[2] * scale]).collect();
    Fields {
        pressure_pa: outcome.rho.iter().map(|rho| lattice.pressure_pa(f64::from(*rho)) as f32).collect(),
        speed_ms: velocity_ms.iter().map(|u| (u[0] * u[0] + u[1] * u[1] + u[2] * u[2]).sqrt()).collect(),
        velocity_ms,
        valid: (0..domain.grid.cells()).map(|cell| domain.is_fluid(cell)).collect(),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Coefficients {
    pub total_n: [f64; 3],
    pub moment_nm: [f64; 3],
    pub drag_n: f64,
    pub lift_n: f64,
    pub side_n: f64,
    pub cd: f64,
    pub cl: f64,
    pub cs: f64,
    pub cm: [f64; 3],
    pub cd_a_m2: f64,
    pub dynamic_pressure_pa: f64,
    pub reference_area_m2: f64,
    pub reference_length_m: f64,
    pub drag_axis: [f64; 3],
    pub lift_axis: [f64; 3],
    pub side_axis: [f64; 3],
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn unit(v: [f64; 3]) -> Option<[f64; 3]> {
    let length = dot(v, v).sqrt();
    (length > 1e-12).then(|| [v[0] / length, v[1] / length, v[2] / length])
}

/// Lift is along `up` made perpendicular to the free stream (any perpendicular when `up` is parallel to it); side = lift × drag.
pub fn coefficients(
    outcome: &RunOutcome,
    lattice: &Lattice,
    direction: [f64; 3],
    up: [f64; 3],
    dynamic_pressure: f64,
    area_m2: f64,
    length_m: f64,
) -> Coefficients {
    let total_lat = outcome.force_per_body.iter().fold([0.0; 3], |acc, f| [acc[0] + f[0], acc[1] + f[1], acc[2] + f[2]]);
    let total_n = [lattice.force_newton(total_lat[0]), lattice.force_newton(total_lat[1]), lattice.force_newton(total_lat[2])];
    let moment_nm = [
        lattice.moment_newton_metre(outcome.moment[0]),
        lattice.moment_newton_metre(outcome.moment[1]),
        lattice.moment_newton_metre(outcome.moment[2]),
    ];
    let d = direction;
    let along = dot(up, d);
    let lift_axis = unit([up[0] - along * d[0], up[1] - along * d[1], up[2] - along * d[2]])
        .or_else(|| unit(cross(d, [0.0, 1.0, 0.0])))
        .or_else(|| unit(cross(d, [1.0, 0.0, 0.0])))
        .unwrap_or([0.0, 0.0, 1.0]);
    let side_axis = cross(lift_axis, d);
    let drag_n = dot(total_n, d);
    let lift_n = dot(total_n, lift_axis);
    let side_n = dot(total_n, side_axis);
    let q_area = dynamic_pressure * area_m2;
    Coefficients {
        total_n,
        moment_nm,
        drag_n,
        lift_n,
        side_n,
        cd: drag_n / q_area,
        cl: lift_n / q_area,
        cs: side_n / q_area,
        cm: [moment_nm[0] / (q_area * length_m), moment_nm[1] / (q_area * length_m), moment_nm[2] / (q_area * length_m)],
        cd_a_m2: drag_n / dynamic_pressure,
        dynamic_pressure_pa: dynamic_pressure,
        reference_area_m2: area_m2,
        reference_length_m: length_m,
        drag_axis: d,
        lift_axis,
        side_axis,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Peak {
    pub field: &'static str,
    pub min: f64,
    pub max: f64,
    pub min_at: [f64; 3],
    pub max_at: [f64; 3],
    pub unit: &'static str,
}

fn centre_of(domain: &Domain, cell: usize) -> [f64; 3] {
    let (i, j, k) = domain.grid.coords(cell);
    domain.grid.centre(i, j, k)
}

/// Pressure and speed extrema over the fluid cells.
pub fn peaks(domain: &Domain, fields: &Fields) -> Vec<Peak> {
    [("p", &fields.pressure_pa, "Pa"), ("speed", &fields.speed_ms, "m/s")]
        .into_iter()
        .filter_map(|(field, values, unit)| {
            let ((min, min_cell), (max, max_cell)) = extrema(values, &fields.valid)?;
            Some(Peak {
                field,
                min: f64::from(min),
                max: f64::from(max),
                min_at: centre_of(domain, min_cell),
                max_at: centre_of(domain, max_cell),
                unit,
            })
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub point_m: [f64; 3],
    #[serde(rename = "velocityMS")]
    pub velocity_ms: Option<[f64; 3]>,
    #[serde(rename = "speedMS")]
    pub speed_ms: Option<f64>,
    pub pressure_pa: Option<f64>,
}

/// Field values at points (None inside the body or outside the grid).
pub fn probes(domain: &Domain, fields: &Fields, points: &[[f64; 3]]) -> Vec<Probe> {
    let component = |axis: usize| -> Vec<f32> { fields.velocity_ms.iter().map(|u| u[axis]).collect() };
    let (ux, uy, uz) = (component(0), component(1), component(2));
    points
        .iter()
        .map(|point| {
            let sample = |values: &[f32]| trilinear(&domain.grid, values, &fields.valid, *point);
            let velocity = match (sample(&ux), sample(&uy), sample(&uz)) {
                (Some(x), Some(y), Some(z)) => Some([x, y, z]),
                _ => None,
            };
            Probe {
                point_m: *point,
                velocity_ms: velocity,
                speed_ms: velocity.map(|u| dot(u, u).sqrt()),
                pressure_pa: sample(&fields.pressure_pa),
            }
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub step: u64,
    pub time_s: f64,
    pub drag_n: f64,
    pub cd: f64,
    pub force_n: [f64; 3],
    pub change: Option<f64>,
    pub phase: &'static str,
}

/// At most `cap` rows, evenly spread, always ending with the last sample.
pub fn history_rows(outcome: &RunOutcome, lattice: &Lattice, q_area: f64, cap: usize) -> Vec<HistoryEntry> {
    let rows = &outcome.history;
    let cap = cap.max(1);
    let stride = rows.len().div_ceil(cap).max(1);
    rows.iter()
        .enumerate()
        .filter(|(index, _)| index % stride == 0 || *index + 1 == rows.len())
        .map(|(_, row)| {
            let drag_n = lattice.force_newton(row.drag);
            HistoryEntry {
                step: row.step,
                time_s: lattice.time_s(row.step),
                drag_n,
                cd: drag_n / q_area,
                force_n: [lattice.force_newton(row.force[0]), lattice.force_newton(row.force[1]), lattice.force_newton(row.force[2])],
                change: row.change.is_finite().then_some(row.change),
                phase: if row.phase == Phase::Averaging { "averaging" } else { "transient" },
            }
        })
        .collect()
}

fn push_name(bytes: &mut Vec<u8>, name: &str) {
    let mut field = [0u8; 16];
    for (slot, byte) in field.iter_mut().zip(name.bytes()) {
        *slot = byte;
    }
    bytes.extend_from_slice(&field);
}

fn push_f32s(bytes: &mut Vec<u8>, values: impl IntoIterator<Item = f32>) {
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
}

/// `surface.bin` with the requested fields among `p` (Pa), `cp`, `speed` (m/s); unknown names are skipped.
pub fn surface_file(domain: &Domain, triangles: &[Triangle], fields: &Fields, names: &[String], dynamic_pressure: f64) -> Vec<u8> {
    let known: Vec<&String> = names.iter().filter(|name| matches!(name.as_str(), "p" | "cp" | "speed")).collect();
    let mut bytes = b"LLSF".to_vec();
    bytes.extend_from_slice(&1u32.to_le_bytes());
    bytes.extend_from_slice(&(triangles.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&(known.len() as u32).to_le_bytes());
    let pressure = surface_values(&domain.grid, triangles, &fields.pressure_pa, &fields.valid);
    for name in known {
        push_name(&mut bytes, name);
        match name.as_str() {
            "p" => push_f32s(&mut bytes, pressure.iter().copied()),
            "cp" => push_f32s(&mut bytes, pressure.iter().map(|p| p / dynamic_pressure as f32)),
            _ => push_f32s(&mut bytes, surface_values(&domain.grid, triangles, &fields.speed_ms, &fields.valid)),
        }
    }
    bytes
}

/// `slice-<k>.bin`: the field sampled on a square patch of the plane, centred on the slice origin, as wide as the grid, one
/// sample per cell.
pub fn slice_file(domain: &Domain, fields: &Fields, slice: &SliceSpec) -> Result<Vec<u8>, JobError> {
    let normal =
        unit(slice.normal).ok_or_else(|| JobError { code: "NATIVE_JOB_INPUT", message: "a slice normal must be non-zero".into() })?;
    let helper = if normal[0].abs() < 0.9 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
    let axis_u = unit(cross(normal, helper)).unwrap_or([0.0, 1.0, 0.0]);
    let axis_v = cross(normal, axis_u);
    let grid = &domain.grid;
    let extent = (grid.nx.max(grid.ny).max(grid.nz) as f64) * grid.h;
    let samples = ((extent / grid.h).ceil() as usize + 1).min(MAX_SLICE_SAMPLES);
    let spacing = extent / (samples.max(2) - 1) as f64;
    let values: Vec<f32> = match slice.field {
        SliceField::Speed => fields.speed_ms.clone(),
        SliceField::P => fields.pressure_pa.clone(),
        SliceField::Ux => fields.velocity_ms.iter().map(|u| u[0]).collect(),
        SliceField::Uy => fields.velocity_ms.iter().map(|u| u[1]).collect(),
        SliceField::Uz => fields.velocity_ms.iter().map(|u| u[2]).collect(),
    };
    let mut bytes = b"LLSL".to_vec();
    bytes.extend_from_slice(&1u32.to_le_bytes());
    bytes.extend_from_slice(&(samples as u32).to_le_bytes());
    bytes.extend_from_slice(&(samples as u32).to_le_bytes());
    let half = extent / 2.0;
    let origin = [
        slice.origin_m[0] - half * (axis_u[0] + axis_v[0]),
        slice.origin_m[1] - half * (axis_u[1] + axis_v[1]),
        slice.origin_m[2] - half * (axis_u[2] + axis_v[2]),
    ];
    push_f32s(&mut bytes, origin.iter().chain(axis_u.iter()).chain(axis_v.iter()).map(|v| *v as f32));
    bytes.extend_from_slice(&(spacing as f32).to_le_bytes());
    let name = match slice.field {
        SliceField::Speed => "speed",
        SliceField::P => "p",
        SliceField::Ux => "ux",
        SliceField::Uy => "uy",
        SliceField::Uz => "uz",
    };
    push_name(&mut bytes, name);
    for iv in 0..samples {
        for iu in 0..samples {
            let (su, sv) = (iu as f64 * spacing, iv as f64 * spacing);
            let point = [
                origin[0] + su * axis_u[0] + sv * axis_v[0],
                origin[1] + su * axis_u[1] + sv * axis_v[1],
                origin[2] + su * axis_u[2] + sv * axis_v[2],
            ];
            let value = trilinear(grid, &values, &fields.valid, point).map_or(f32::NAN, |v| v as f32);
            bytes.extend_from_slice(&value.to_le_bytes());
        }
    }
    Ok(bytes)
}

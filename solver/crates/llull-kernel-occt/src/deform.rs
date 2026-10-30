//! Exact space deformation (`cpp/deform.{hxx,cxx}`, 01 DEF M2): the `deform` recipe node becomes a flat numeric spec and the C++ warp
//! re-approximates every face and edge of the source as a B-spline of the deformed geometry. A third bridge reusing the facade's `Shape`.

use crate::{built, inner, occt, Built, OcctResult, Shape};
use serde_json::Value;

// Generated FFI glue (unsafe by construction), like the other bridges; no hand-written unsafe block.
#[allow(unsafe_code)]
#[cxx::bridge(namespace = "llull")]
mod ffi {
    unsafe extern "C++" {
        include!("llull-kernel-occt/cpp/deform.hxx");

        type Shape = crate::ffi::Shape;

        fn warp_shape(shape: &Shape, spec: &[f64]) -> Result<UniquePtr<Shape>>;
        fn warp_report() -> String;
        fn warp_points(spec: &[f64], points: &[f64]) -> Result<Vec<f64>>;
        fn warp_determinants(spec: &[f64], points: &[f64]) -> Result<Vec<f64>>;
    }
}

/// Law codes of the spec (`LawKind` in `cpp/deform_laws.hxx`).
const AFFINE: f64 = 0.0;
const TWIST: f64 = 1.0;
const TAPER: f64 = 2.0;
const STRETCH: f64 = 3.0;
const BEND: f64 = 4.0;
const LATTICE: f64 = 5.0;
const POINT: f64 = 6.0;
const FLOW: f64 = 7.0;
const FLOW_SURFACE: f64 = 8.0;
const RBF: f64 = 9.0;

fn number(value: &Value, field: &str) -> Option<f64> {
    value.get(field)?.as_f64().filter(|number| number.is_finite())
}

fn triple(value: &Value) -> Option<[f64; 3]> {
    match value.as_array()?.as_slice() {
        [x, y, z] => Some([x.as_f64()?, y.as_f64()?, z.as_f64()?]),
        _ => None,
    }
}

fn flag(value: &Value, field: &str) -> f64 {
    if value.get(field).and_then(Value::as_bool).unwrap_or(false) {
        1.0
    } else {
        0.0
    }
}

fn unit(vector: [f64; 3]) -> Option<[f64; 3]> {
    let length = vector.iter().map(|component| component * component).sum::<f64>().sqrt();
    (length > 0.0).then(|| vector.map(|component| component / length))
}

/// The law code and numbers after the 16-number header, or None for a law the exact warp does not build (the host then answers it unsupported).
fn law_numbers(law: &Value) -> Option<(f64, Vec<f64>)> {
    let kind = law.get("kind")?.as_str()?;
    match kind {
        "affine" => {
            let mut numbers = Vec::with_capacity(12);
            for row in law.get("matrix")?.as_array()? {
                numbers.extend(triple(row)?);
            }
            numbers.extend(triple(law.get("translation")?)?);
            (numbers.len() == 12).then_some((AFFINE, numbers))
        }
        "twist" => Some((TWIST, vec![number(law, "angleRad")?])),
        "taper" => Some((TAPER, vec![number(law, "scaleEnd")?, flag(law, "flat")])),
        "stretch" => Some((STRETCH, vec![number(law, "factor")?])),
        "bend" => Some((BEND, vec![number(law, "radius")?, flag(law, "symmetric")])),
        "lattice" => {
            let degrees = triple(law.get("degrees")?)?;
            let bounds = law.get("box")?;
            let (min, max) = (triple(bounds.get("min")?)?, triple(bounds.get("max")?)?);
            let counts = degrees.map(|degree| degree as usize + 1);
            let mut offsets = vec![0.0; 3 * counts[0] * counts[1] * counts[2]];
            for entry in law.get("offsets")?.as_array()? {
                let index = triple(entry.get("index")?)?.map(|value| value as usize);
                let delta = triple(entry.get("delta")?)?;
                if index.iter().zip(&counts).any(|(at, count)| at >= count) {
                    return None;
                }
                let slot = (index[0] * counts[1] + index[1]) * counts[2] + index[2];
                for (axis, value) in delta.iter().enumerate() {
                    offsets[3 * slot + axis] += value;
                }
            }
            let mut numbers: Vec<f64> = min.into_iter().chain(max).chain(degrees).collect();
            numbers.extend(offsets);
            // the optional trailer: spline degrees (0: Bernstein), an oriented flag, the box axes (rows)
            let spline = law.get("splineDegrees").and_then(triple);
            let axes = law.get("axes").and_then(Value::as_array).map(|rows| rows.iter().filter_map(triple).collect::<Vec<_>>());
            if spline.is_some() || axes.is_some() {
                numbers.extend(spline.unwrap_or([0.0; 3]));
                let rows = axes.filter(|rows| rows.len() == 3);
                numbers.push(if rows.is_some() { 1.0 } else { 0.0 });
                numbers.extend(rows.unwrap_or_else(|| vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]).into_iter().flatten());
            }
            Some((LATTICE, numbers))
        }
        "point" => {
            let direction = unit(triple(law.get("direction")?)?)?;
            let mut numbers: Vec<f64> = triple(law.get("center")?)?.into_iter().chain(direction).collect();
            numbers.extend([number(law, "distance")?, number(law, "radius")?]);
            numbers.push(if law.get("falloff").and_then(Value::as_str) == Some("cubic") { 1.0 } else { 0.0 });
            Some((POINT, numbers))
        }
        "flowCurve" => {
            let stations: Vec<f64> = law
                .get("stations")?
                .as_array()?
                .iter()
                .map(|value| value.as_f64().filter(|number| number.is_finite()))
                .collect::<Option<_>>()?;
            if stations.len() < 24 || !stations.len().is_multiple_of(12) {
                return None;
            }
            let mut numbers = vec![number(law, "z0")?, number(law, "ratio")?, number(law, "step")?, (stations.len() / 12) as f64];
            numbers.extend(stations);
            // the base curve (flow_along_curve baseCurve): station count (0: the frame axis), step, stations
            match law.get("base") {
                None => numbers.push(0.0),
                Some(base) => {
                    let table: Vec<f64> = base
                        .get("stations")?
                        .as_array()?
                        .iter()
                        .map(|value| value.as_f64().filter(|number| number.is_finite()))
                        .collect::<Option<_>>()?;
                    if table.len() < 24 || !table.len().is_multiple_of(12) {
                        return None;
                    }
                    numbers.extend([(table.len() / 12) as f64, number(base, "step")?]);
                    numbers.extend(table);
                }
            }
            Some((FLOW, numbers))
        }
        "flowSurface" => {
            let nodes: Vec<f64> = law
                .get("nodes")?
                .as_array()?
                .iter()
                .map(|value| value.as_f64().filter(|number| number.is_finite()))
                .collect::<Option<_>>()?;
            let (nx, ny) = (number(law, "nx")?, number(law, "ny")?);
            if nx < 2.0 || ny < 2.0 || nodes.len() as f64 != 6.0 * nx * ny {
                return None;
            }
            let mut numbers = vec![number(law, "x0")?, number(law, "y0")?, number(law, "hx")?, number(law, "hy")?, nx, ny];
            numbers.extend(nodes);
            // the base sheet table on the same grid, when the body is laid out on a curved base
            if let Some(base) = law.get("baseNodes") {
                let table: Vec<f64> =
                    base.as_array()?.iter().map(|value| value.as_f64().filter(|number| number.is_finite())).collect::<Option<_>>()?;
                if table.len() as f64 != 6.0 * nx * ny {
                    return None;
                }
                numbers.extend(table);
            }
            Some((FLOW_SURFACE, numbers))
        }
        "rbf" => {
            let list = |field: &str| -> Option<Vec<f64>> {
                law.get(field)?.as_array()?.iter().map(|value| value.as_f64().filter(|number| number.is_finite())).collect()
            };
            let (centres, weights, affine) = (list("centres")?, list("weights")?, list("affine")?);
            if centres.is_empty() || centres.len() % 3 != 0 || weights.len() != centres.len() || affine.len() != 12 {
                return None;
            }
            let mut numbers = vec![(centres.len() / 3) as f64];
            numbers.extend(centres);
            numbers.extend(weights);
            numbers.extend(affine);
            Some((RBF, numbers))
        }
        _ => None,
    }
}

fn falloff_code(region: &Value) -> f64 {
    match region.get("falloff").and_then(Value::as_str) {
        Some("none") => 0.0,
        Some("linear") => 1.0,
        _ => 2.0,
    }
}

/// The flat spec of a `deform` recipe node (layout: `cpp/deform.cxx`), None when the node is malformed or its law is not an exact-warp law.
pub fn spec_of(node: &Value) -> Option<Vec<f64>> {
    let (kind, numbers) = law_numbers(node.get("law")?)?;
    let frame = node.get("frame")?;
    let output = node.get("output")?;
    let (start, end, falloff, infinite) = match node.get("region") {
        Some(region) => (number(region, "start")?, number(region, "end")?, falloff_code(region), flag(region, "infinite")),
        None => (0.0, 1.0, 2.0, 0.0),
    };
    let mut spec = vec![kind, number(output, "tolerance")?];
    spec.extend(triple(frame.get("origin")?)?);
    spec.extend(triple(frame.get("axis")?)?);
    spec.extend(triple(frame.get("reference")?)?);
    spec.extend([start, end, falloff, flag(output, "preserveAnalytic"), infinite]);
    spec.extend(numbers);
    Some(spec)
}

/// The result of one warp: the shape (None when refused) and the C++ report (`{ ok, code, message, maxError, faces, ... }`).
pub struct Warped {
    pub shape: Option<Shape>,
    pub report: Value,
}

/// Warps `shape` by `spec`; a refusal is `shape: None` with the reason in `report`.
pub fn warp(shape: &Shape, spec: &[f64]) -> OcctResult<Warped> {
    let result: Built = built(ffi::warp_shape(inner(shape)?, spec));
    let report = serde_json::from_str(&ffi::warp_report()).unwrap_or(Value::Null);
    Ok(Warped { shape: result?, report })
}

/// The law of `spec` applied to `points` (xyz triples), without any shape: the parity test against `validation/data/point_vectors.json`.
pub fn warp_points(spec: &[f64], points: &[f64]) -> OcctResult<Vec<f64>> {
    occt(ffi::warp_points(spec, points))
}

/// det J of the law of `spec` at `points` (one per point), by forward-mode derivatives: the parity test of the Jacobian against the pack.
pub fn warp_determinants(spec: &[f64], points: &[f64]) -> OcctResult<Vec<f64>> {
    occt(ffi::warp_determinants(spec, points))
}

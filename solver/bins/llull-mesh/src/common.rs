//! Shared pieces of the mesher: the error type, request field access, distances on the Gmsh model, Python-compatible number text.

use llull_gmsh::{Gmsh, GmshError};
use serde_json::Value;
use std::collections::HashMap;

pub type Point = [f64; 3];

/// Classification of STL facets into faces (llull_mesh.py CLASSIFY_ANGLE).
pub const CLASSIFY_ANGLE_DEG: f64 = 40.0;
/// A point is on two faces / edges when their distances differ by at most this fraction of the model diagonal.
pub const AMBIGUOUS_REL: f64 = 1e-6;
/// A point resolves to nothing when the nearest face / edge is further than this fraction of the model diagonal.
pub const UNRESOLVED_REL: f64 = 1e-3;

/// A mesher failure: `code` is a FEA_* code the host maps to a tool error; `None` is an unexpected Gmsh error (FEA_MESH_FAILED).
#[derive(Debug)]
pub struct MeshError {
    pub code: Option<&'static str>,
    pub message: String,
}

impl MeshError {
    pub fn new(code: &'static str, message: String) -> Self {
        Self { code: Some(code), message }
    }
}

impl From<GmshError> for MeshError {
    fn from(error: GmshError) -> Self {
        Self { code: None, message: format!("Gmsh: {error}") }
    }
}

pub type MeshResult<T> = Result<T, MeshError>;

pub fn malformed(what: &str) -> MeshError {
    MeshError { code: None, message: format!("malformed mesh request: {what}") }
}

pub fn field<'a>(value: &'a Value, key: &str) -> MeshResult<&'a Value> {
    value.get(key).filter(|v| !v.is_null()).ok_or_else(|| malformed(&format!("missing '{key}'")))
}

pub fn number(value: &Value, key: &str) -> MeshResult<f64> {
    field(value, key)?.as_f64().ok_or_else(|| malformed(&format!("'{key}' is not a number")))
}

pub fn text<'a>(value: &'a Value, key: &str) -> MeshResult<&'a str> {
    field(value, key)?.as_str().ok_or_else(|| malformed(&format!("'{key}' is not a string")))
}

/// A list field; absent, null and `[]` are all empty (Python's falsy `target.get(...)`).
pub fn list<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value.get(key).and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

pub fn point_of(value: &Value) -> MeshResult<Point> {
    let items = value.as_array().ok_or_else(|| malformed("a point is not an array"))?;
    let coordinate = |i: usize| items.get(i).and_then(Value::as_f64).ok_or_else(|| malformed("a point needs 3 numbers"));
    Ok([coordinate(0)?, coordinate(1)?, coordinate(2)?])
}

/// The points of list field `key`, each coordinate multiplied by `scale`.
pub fn scaled_points(value: &Value, key: &str, scale: f64) -> MeshResult<Vec<Point>> {
    list(value, key).iter().map(|p| point_of(p).map(|p| p.map(|c| c * scale))).collect()
}

/// Python's `sum()` of floats (3.12+): Neumaier compensated summation, so distances match the reference mesher to the last bit.
pub fn py_sum(values: impl IntoIterator<Item = f64>) -> f64 {
    let (mut total, mut compensation) = (0.0f64, 0.0f64);
    for x in values {
        let t = total + x;
        compensation += if total.abs() >= x.abs() { (total - t) + x } else { (x - t) + total };
        total = t;
    }
    if compensation != 0.0 && compensation.is_finite() {
        total += compensation;
    }
    total
}

pub fn dist(a: &[f64], b: &[f64]) -> f64 {
    py_sum(a.iter().zip(b).map(|(x, y)| (x - y) * (x - y))).sqrt()
}

/// Length of the diagonal of the model's bounding box (1 for an empty / degenerate box).
pub fn model_diagonal(gmsh: &Gmsh) -> MeshResult<f64> {
    let b = gmsh.bounding_box(-1, -1)?;
    let d = dist(&b[..3], &b[3..]);
    Ok(if d == 0.0 { 1.0 } else { d })
}

/// Every node of the current model: tag -> xyz.
pub fn node_coords(gmsh: &Gmsh) -> MeshResult<HashMap<usize, Point>> {
    let (tags, xyz) = gmsh.nodes(-1, -1, false)?;
    Ok(tags.iter().enumerate().map(|(i, &tag)| (tag, [xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]])).collect())
}

/// Triangles (3 or 6 nodes) of a mesh surface.
pub fn surface_triangles(gmsh: &Gmsh, surface: i32) -> MeshResult<Vec<Vec<usize>>> {
    const TRI3: i32 = 2;
    let mut out = Vec::new();
    for (element_type, nodes) in gmsh.elements(2, surface)? {
        let width = if element_type == TRI3 { 3 } else { 6 };
        out.extend(nodes.chunks_exact(width).map(<[usize]>::to_vec));
    }
    Ok(out)
}

/// Distance from `point` to the TRIMMED entity (the closest point alone measures the untrimmed plane / cylinder / line): when the
/// projection falls outside the trimmed entity, the nearest of its boundary entities.
pub fn trimmed_distance(gmsh: &Gmsh, dim: i32, tag: i32, point: &Point) -> MeshResult<f64> {
    let (closest, parametric) = gmsh.closest_point(dim, tag, point)?;
    let d = dist(point, &closest);
    match gmsh.is_inside(dim, tag, &parametric, true) {
        Ok(inside) if inside > 0 => return Ok(d),
        Ok(_) => {}
        // discrete (STL) entities: the closest point already lies on the mesh
        Err(_) => return Ok(d),
    }
    let mut best = f64::INFINITY;
    for (boundary_dim, boundary_tag) in gmsh.boundary(&[(dim, tag)], false, false, false)? {
        let distance = if boundary_dim >= 1 {
            trimmed_distance(gmsh, boundary_dim, boundary_tag.abs(), point)?
        } else {
            dist(point, &gmsh.value(0, boundary_tag.abs(), &[])?)
        };
        best = best.min(distance);
    }
    Ok(if best < f64::INFINITY { best } else { d })
}

/// `(distance, tag)` ascending by distance then tag.
pub fn rank(mut ranked: Vec<(f64, i32)>) -> Vec<(f64, i32)> {
    ranked.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    ranked
}

/// Python `repr(float)`: shortest round-trip digits, exponent form below 1e-4 and from 1e16.
pub fn py_float(x: f64) -> String {
    if !x.is_finite() {
        return if x.is_nan() {
            "nan".into()
        } else if x > 0.0 {
            "inf".into()
        } else {
            "-inf".into()
        };
    }
    let shortest = format!("{x:e}");
    let (mantissa, exponent) = shortest.split_once('e').unwrap_or((&shortest, "0"));
    let exponent: i32 = exponent.parse().unwrap_or(0);
    let (sign, mantissa) = mantissa.strip_prefix('-').map_or(("", mantissa), |m| ("-", m));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    if !(-4..16).contains(&exponent) {
        let body = if digits.len() > 1 { format!("{}.{}", &digits[..1], &digits[1..]) } else { digits };
        return format!("{sign}{body}e{}{:02}", if exponent < 0 { '-' } else { '+' }, exponent.abs());
    }
    let point = exponent + 1;
    let body = if point <= 0 {
        format!("0.{}{digits}", "0".repeat(point.unsigned_abs() as usize))
    } else if (point as usize) >= digits.len() {
        format!("{digits}{}.0", "0".repeat(point as usize - digits.len()))
    } else {
        format!("{}.{}", &digits[..point as usize], &digits[point as usize..])
    };
    format!("{sign}{body}")
}

/// Python `'%.3g' % x`.
pub fn py_g3(x: f64) -> String {
    if x == 0.0 || !x.is_finite() {
        return py_float(x).trim_end_matches(".0").to_string();
    }
    let scientific = format!("{x:.2e}");
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((&scientific, "0"));
    let exponent: i32 = exponent.parse().unwrap_or(0);
    let trim = |s: String| if s.contains('.') { s.trim_end_matches('0').trim_end_matches('.').to_string() } else { s };
    if !(-4..3).contains(&exponent) {
        return format!("{}e{}{:02}", trim(mantissa.to_string()), if exponent < 0 { '-' } else { '+' }, exponent.abs());
    }
    trim(format!("{:.*}", (2 - exponent) as usize, x))
}

/// Python `str(list_of_floats)`.
pub fn py_point(point: &[f64]) -> String {
    format!("[{}]", point.iter().map(|c| py_float(*c)).collect::<Vec<_>>().join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floats_print_like_python_repr() {
        let cases = [
            (1.0, "1.0"),
            (0.1, "0.1"),
            (2.5e-5, "2.5e-05"),
            (1e16, "1e+16"),
            (123456.75, "123456.75"),
            (-0.001, "-0.001"),
            (0.0001, "0.0001"),
        ];
        for (value, expected) in cases {
            assert_eq!(py_float(value), expected);
        }
    }

    #[test]
    fn g3_prints_like_python_percent_g() {
        let cases = [(0.0123456, "0.0123"), (1234.0, "1.23e+03"), (12.0, "12"), (0.00001234, "1.23e-05"), (0.5, "0.5"), (0.0, "0")];
        for (value, expected) in cases {
            assert_eq!(py_g3(value), expected);
        }
    }

    #[test]
    fn sums_are_compensated_like_python() {
        // sum([0.1] * 10) == 1.0 in Python 3.12+, 0.9999999999999999 with a plain fold
        assert_eq!(py_sum(std::iter::repeat_n(0.1, 10)), 1.0);
        assert_eq!(py_sum([1e100, 1.0, -1e100]), 1.0);
    }

    #[test]
    fn ranking_breaks_distance_ties_by_tag() {
        assert_eq!(rank(vec![(1.0, 5), (0.5, 9), (1.0, 2)]), vec![(0.5, 9), (1.0, 2), (1.0, 5)]);
    }

    #[test]
    fn missing_fields_are_malformed_requests() {
        let value = serde_json::json!({ "a": 1.0, "b": null, "p": [[1, 2, 3]] });
        assert!(number(&value, "b").is_err());
        assert_eq!(number(&value, "a").unwrap(), 1.0);
        assert!(list(&value, "missing").is_empty());
        assert_eq!(scaled_points(&value, "p", 2.0).unwrap(), vec![[2.0, 4.0, 6.0]]);
        assert!(point_of(&serde_json::json!([1, 2])).is_err());
    }
}

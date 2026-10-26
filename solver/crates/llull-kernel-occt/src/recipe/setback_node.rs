//! BLD M3: the `corners` of a `fillet` node as the flat specs of `features::fillet_setback`.

use super::nodes::{indices, vec3_of};
use super::{number, positive};
use serde_json::Value;

/// The flat specs of `features::fillet_setback`: `(edges, corners)`.
pub(super) type SetbackSpecs = (Vec<f64>, Vec<f64>);

/// `(edges, corners)` for a fillet node with setback corners: `edges` = (unique edge index, radius at the edge start, radius at its end) triples, `corners` = per corner x, y, z, n, then
/// n (unique edge index, setback distance) pairs. `Ok(None)` when the node has no `setback` corner (rolling-ball corners are the default),
/// `Err` when the node is malformed or asks for more than this build makes (a radius that varies other than linearly between two ends, a profile, a non-positive
/// size or distance).
pub(super) fn setback_specs(recipe: &Value) -> Result<Option<SetbackSpecs>, ()> {
    let Some(corners) = recipe.get("corners").and_then(Value::as_array) else { return Ok(None) };
    let setbacks: Vec<&Value> = corners.iter().filter(|corner| corner.get("type").and_then(Value::as_str) == Some("setback")).collect();
    if setbacks.is_empty() {
        return Ok(None);
    }
    let profiled = recipe
        .get("profile")
        .filter(|profile| !profile.is_null())
        .is_some_and(|profile| profile.get("type").and_then(Value::as_str).is_some_and(|name| name != "circular"));
    let edges = indices(recipe.get("edges")).filter(|edges| !edges.is_empty()).ok_or(())?;
    let laws: Vec<&Value> = match recipe.get("radii").filter(|radii| !radii.is_null()) {
        Some(radii) => radii.as_array().ok_or(())?.iter().collect(),
        None => vec![recipe; edges.len()],
    };
    if profiled || laws.len() != edges.len() {
        return Err(());
    }
    let mut flat_edges = Vec::new();
    for (edge, law) in edges.iter().zip(laws) {
        let size = number(law, "size").filter(|size| positive(*size)).ok_or(())?;
        let size_end = match law.get("sizeEnd").filter(|end| !end.is_null()) {
            Some(end) => {
                // an end equal to the start is a constant radius whatever the interpolation (as in core)
                let linear = law.get("interpolation").and_then(Value::as_str) == Some("linear");
                end.as_f64().filter(|end| positive(*end) && (linear || *end == size)).ok_or(())?
            }
            None => size,
        };
        let other = law.get("sizes").and_then(Value::as_array).is_some_and(|sizes| !sizes.is_empty())
            || law.get("size2").is_some_and(|size2| !size2.is_null());
        if other {
            return Err(());
        }
        flat_edges.extend([f64::from(*edge), size, size_end]);
    }
    let mut flat_corners = Vec::new();
    for corner in setbacks {
        let vertex = vec3_of(corner.get("vertex")).ok_or(())?;
        let distances = corner.get("distances").and_then(Value::as_array).ok_or(())?;
        flat_corners.extend([vertex[0], vertex[1], vertex[2], distances.len() as f64]);
        for entry in distances {
            let edge = entry.get("edge").and_then(Value::as_u64).ok_or(())?;
            let distance = number(entry, "distance").filter(|distance| positive(*distance)).ok_or(())?;
            flat_corners.extend([edge as f64, distance]);
        }
    }
    Ok(Some((flat_edges, flat_corners)))
}

#[cfg(test)]
mod tests {
    use super::setback_specs;
    use serde_json::{json, Value};

    fn node(law: Value) -> Value {
        json!({
            "edges": [3],
            "radii": [law],
            "corners": [{ "type": "setback", "vertex": [0.0, 0.0, 0.0], "distances": [{ "edge": 3, "distance": 2.0 }] }],
        })
    }

    #[test]
    fn a_size_end_equal_to_the_size_is_a_constant_radius_whatever_the_interpolation() {
        let (edges, corners) = setback_specs(&node(json!({ "size": 1.0, "sizeEnd": 1.0 }))).unwrap().unwrap();
        assert_eq!(edges, vec![3.0, 1.0, 1.0]);
        assert_eq!(corners, vec![0.0, 0.0, 0.0, 1.0, 3.0, 2.0]);
    }

    #[test]
    fn a_linear_size_end_is_a_taper_and_a_smooth_or_multi_station_law_is_refused() {
        let linear = json!({ "size": 1.0, "sizeEnd": 2.0, "interpolation": "linear" });
        assert_eq!(setback_specs(&node(linear)).unwrap().unwrap().0, vec![3.0, 1.0, 2.0]);
        assert!(setback_specs(&node(json!({ "size": 1.0, "sizeEnd": 2.0 }))).is_err());
        assert!(setback_specs(&node(json!({ "size": 1.0, "sizes": [{ "t": 0.5, "size": 2.0 }] }))).is_err());
        assert!(setback_specs(&node(json!({ "size": 1.0, "size2": 2.0 }))).is_err());
    }
}

//! BLD M3: the `corners` of a `fillet` node as the flat specs of `features::fillet_setback`.

use super::nodes::{indices, vec3_of};
use super::{number, positive};
use serde_json::Value;

/// `(edges, corners)` for a fillet node with setback corners: `edges` = (unique edge index, radius) pairs, `corners` = per corner x, y, z, n, then
/// n (unique edge index, setback distance) pairs. `Ok(None)` when the node has no `setback` corner (rolling-ball corners are the default),
/// `Err` when the node is malformed or asks for more than this build makes (a radius that varies, a profile, a non-positive size or distance).
pub(super) fn setback_specs(recipe: &Value) -> Result<Option<(Vec<f64>, Vec<f64>)>, ()> {
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
        let varying = law.get("sizeEnd").is_some_and(|end| !end.is_null())
            || law.get("sizes").and_then(Value::as_array).is_some_and(|sizes| !sizes.is_empty())
            || law.get("size2").is_some_and(|size2| !size2.is_null());
        if varying {
            return Err(());
        }
        flat_edges.extend([f64::from(*edge), size]);
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

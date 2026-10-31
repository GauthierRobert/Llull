//! BLD M2: the `profile` of a `fillet` node as the inputs of `features::fillet_profile_blend`.

use super::nodes::radius_laws;
use super::{number, positive};
use serde_json::Value;

/// What the native profile builders read: `specs` (7 numbers per edge, the prism builder; empty when a size varies), `laws` (the `fillet_laws`
/// layout, the rail builder; empty when a leg is asymmetric), `legs` (6 numbers per edge when every edge has two legs: unique edge, face carrying the first leg,
/// size, sizeEnd, size2, size2End, NaN = constant; the chamfer-based builder of `cpp/blend_legs.cxx`) and the section `kind` (0 conic, 1 curvature, 2 circular
/// with two legs) and `param`.
pub(super) struct ProfilePlan {
    pub specs: Vec<f64>,
    pub laws: Vec<f64>,
    pub legs: Vec<f64>,
    pub kind: f64,
    pub param: f64,
}

fn present(law: &Value, field: &str) -> bool {
    law.get(field).is_some_and(|value| !value.is_null())
}

fn varying(law: &Value) -> bool {
    present(law, "sizeEnd") || present(law, "size2End") || law.get("sizes").and_then(Value::as_array).is_some_and(|sizes| !sizes.is_empty())
}

/// A leg that may run from `field` to `field_end` along the edge: (start, end), the end NaN when constant.
fn leg(law: &Value, field: &str, field_end: &str) -> Result<(f64, f64), ()> {
    let start = number(law, field).filter(|size| positive(*size)).ok_or(())?;
    let end = match law.get(field_end).filter(|end| !end.is_null()) {
        Some(value) => value.as_f64().filter(|end| positive(*end)).ok_or(())?,
        None => f64::NAN,
    };
    Ok((start, end))
}

/// The plan of a fillet node with a conic / curvature `profile` or a `size2` leg; `Ok(None)` for a circular, symmetric fillet, `Err` when the node is
/// malformed (rho / shape outside 0.05..0.95, `size2` without a side, an asymmetric leg whose size varies).
pub(super) fn profile_plan(recipe: &Value, edges: &[u32]) -> Result<Option<ProfilePlan>, ()> {
    let profile = recipe.get("profile").filter(|profile| !profile.is_null());
    let name = profile.and_then(|profile| profile.get("type")).and_then(Value::as_str).unwrap_or("circular");
    let laws: Vec<Value> = match recipe.get("radii").filter(|radii| !radii.is_null()) {
        Some(radii) => radii.as_array().ok_or(())?.clone(),
        None => vec![recipe.clone(); edges.len()],
    };
    let sided = laws.iter().any(|law| law.get("size2").is_some_and(|size2| !size2.is_null()));
    if name == "circular" && !sided {
        return Ok(None);
    }
    if laws.len() != edges.len() || edges.is_empty() {
        return Err(());
    }
    let factor = |field: &str| profile.and_then(|profile| number(profile, field)).filter(|value| (0.05..=0.95).contains(value));
    let (kind, param) = match name {
        "conic" => (0.0, factor("rho").ok_or(())?),
        "curvature" => (1.0, factor("shape").ok_or(())?),
        "circular" => (2.0, 0.0),
        _ => return Err(()),
    };
    let any_varying = laws.iter().any(varying);
    let every_sided = laws.iter().all(|law| present(law, "size2"));
    let control_points = laws.iter().any(|law| law.get("sizes").and_then(Value::as_array).is_some_and(|sizes| !sizes.is_empty()));
    // legs that run along an edge need every edge to have two legs, and each leg is straight in the arc length (no control points)
    if sided && any_varying && (!every_sided || control_points) {
        return Err(());
    }
    let mut specs = Vec::new();
    let mut legs = Vec::new();
    if !any_varying {
        for (edge, law) in edges.iter().zip(&laws) {
            let size = number(law, "size").filter(|size| positive(*size)).ok_or(())?;
            let size2 = match law.get("size2").filter(|size2| !size2.is_null()) {
                Some(value) => value.as_f64().filter(|size2| positive(*size2)).ok_or(())?,
                None => f64::NAN,
            };
            let side = law.get("sideFace").and_then(Value::as_u64).map_or(-1.0, |face| face as f64);
            if !size2.is_nan() && side < 0.0 {
                return Err(());
            }
            specs.extend([f64::from(*edge), kind, param, size, size2, side, 0.0]);
        }
    }
    if sided && every_sided {
        for (edge, law) in edges.iter().zip(&laws) {
            let (size, size_end) = leg(law, "size", "sizeEnd")?;
            let (size2, size2_end) = leg(law, "size2", "size2End")?;
            let side = law.get("sideFace").and_then(Value::as_u64).ok_or(())?;
            legs.extend([f64::from(*edge), side as f64, size, size_end, size2, size2_end]);
        }
    }
    let rails = if sided { Vec::new() } else { radius_laws(&Value::Array(laws), edges.len()).ok_or(())? };
    Ok(Some(ProfilePlan { specs, laws: rails, legs, kind, param }))
}

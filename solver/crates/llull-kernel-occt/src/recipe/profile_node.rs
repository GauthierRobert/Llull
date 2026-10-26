//! BLD M2: the `profile` of a `fillet` node as the inputs of `features::fillet_profile_blend`.

use super::nodes::radius_laws;
use super::{number, positive};
use serde_json::Value;

/// What the native profile builders read: `specs` (7 numbers per edge, the prism builder; empty when a size varies), `laws` (the `fillet_laws`
/// layout, the rail builder; empty when a leg is asymmetric) and the section `kind` (0 conic, 1 curvature, 2 circular with two legs) and `param`.
pub(super) struct ProfilePlan {
    pub specs: Vec<f64>,
    pub laws: Vec<f64>,
    pub kind: f64,
    pub param: f64,
}

fn varying(law: &Value) -> bool {
    law.get("sizeEnd").is_some_and(|end| !end.is_null())
        || law.get("sizes").and_then(Value::as_array).is_some_and(|sizes| !sizes.is_empty())
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
    if sided && any_varying {
        return Err(());
    }
    let mut specs = Vec::new();
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
    let rails = if sided { Vec::new() } else { radius_laws(&Value::Array(laws), edges.len()).ok_or(())? };
    Ok(Some(ProfilePlan { specs, laws: rails, kind, param }))
}

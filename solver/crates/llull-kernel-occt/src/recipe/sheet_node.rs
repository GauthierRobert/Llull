//! The `sheetSolid` recipe node (`packages/core/src/model/sheetSolid.ts`, capability `sheetSolid`): the exact solid of a sweep or loft the pipe operation
//! cannot build (laws, frame modes, rails, advanced loft conditions). The host sends the fitted lateral B-spline faces (`faces`, encoded clamped surfaces),
//! which are sewn and closed by planar caps (`caps`: 2 section ends, 1 a loft closed to a point at one end, 0 a sweep or loft round a closed path), a bored
//! tube's inner faces (`bore`, cut out), and optionally a MakePipeShell attempt (`pipeShell`) accepted only when it reproduces the fitted solid.
//! The result is placed (`rotation`, `position`) and its faces are named `<name>:<role>` like any entity leaf (SC-N1).

use super::nodes::{chains, pipe_shell};
use super::wrap_nodes::surface_data_ok;
use super::{number, positive, refused, shape_of, vec3, Evaluated};
use crate::{features, BooleanOp, Shape};
use serde_json::Value;
use std::rc::Rc;

/// The faces of `field` as encoded surfaces: a non-empty list, every one a consistent B-spline description; `None` when absent or malformed.
fn face_list(recipe: &Value, field: &str) -> Option<Vec<Vec<f64>>> {
    let faces = chains(recipe.get(field))?;
    (!faces.is_empty() && faces.iter().all(|face| surface_data_ok(0, face))).then_some(faces)
}

/// The sewn and capped solid of one face set; `Ok(None)` when OCCT does not close it.
fn closed_solid(faces: &[Vec<f64>], tolerance: f64, caps: i32) -> Evaluated {
    shape_of(features::sheet_solid_capped(faces, tolerance, caps))
}

/// Outer faces minus the bore's faces (a hollow round section); both solids end in the same planes, which the boolean treats as shared faces.
fn hollow_solid(outer: &[Vec<f64>], bore: &[Vec<f64>], tolerance: f64, caps: i32) -> Evaluated {
    let (Some(solid), Some(hole)) = (closed_solid(outer, tolerance, caps)?, closed_solid(bore, tolerance, caps)?) else { return refused() };
    shape_of(crate::boolean(BooleanOp::Subtract, &solid, &hole, false))
}

fn volume_of(solid: &Option<Rc<Shape>>) -> f64 {
    solid.as_ref().and_then(|shape| crate::mass_properties(shape).ok()).map_or(0.0, |properties| properties.volume)
}

/// `sheetSolid`: see the module comment. Malformed data, a bad tolerance or `caps` outside 0..=2 is refused (`None`).
pub(super) fn sheet_solid(recipe: &Value) -> Evaluated {
    let tolerance = number(recipe, "tolerance").unwrap_or(f64::NAN);
    let (Some(faces), Some(caps), Some(position), Some(rotation)) = (
        face_list(recipe, "faces"),
        recipe.get("caps").and_then(Value::as_i64).filter(|caps| (0..=2).contains(caps)),
        vec3(recipe, "position"),
        vec3(recipe, "rotation"),
    ) else {
        return refused();
    };
    if !positive(tolerance) {
        return refused();
    }
    let caps = caps as i32;
    let bore = recipe.get("bore").filter(|bore| !bore.is_null());
    let solid = match bore {
        Some(_) => {
            let Some(inner) = face_list(recipe, "bore") else { return refused() };
            hollow_solid(&faces, &inner, tolerance, caps)?
        }
        None => closed_solid(&faces, tolerance, caps)?,
    };
    // the fitted faces first: their volume is what the MakePipeShell attempt must reproduce (probes alone cannot see a pipe that is too fat)
    let attempt = match (recipe.get("pipeShell"), bore) {
        (Some(settings), None) => pipe_shell(settings, settings, volume_of(&solid))?,
        _ => None,
    };
    let Some(shape) = attempt.or(solid) else { return refused() };
    let placed = shape_of(crate::placed(&shape, rotation, position, [0.0; 3]))?;
    match (placed, recipe.get("name").and_then(Value::as_str)) {
        (Some(shape), Some(name)) => shape_of(crate::prefixed(&shape, name)),
        (shape, _) => Ok(shape),
    }
}

//! Mesh size: one background field, the global size locally reduced near the refinement faces / curves / points.

use crate::common::{number, py_float, MeshResult};
use crate::raw::Refinement;
use llull_gmsh::Gmsh;
use serde_json::Value;

pub fn size_fields(gmsh: &Gmsh, controls: &Value, refinements: &[Refinement], scale: f64) -> MeshResult<()> {
    let global_size = number(controls, "globalSize")? * scale;
    let mut fields = Vec::new();
    let base = gmsh.field_add("MathEval")?;
    gmsh.field_set_string(base, "F", &py_float(global_size))?;
    fields.push(f64::from(base));
    for item in refinements {
        let size = item.size * scale;
        if !item.surfaces.is_empty() || !item.curves.is_empty() {
            let distance = gmsh.field_add("Distance")?;
            if !item.surfaces.is_empty() {
                gmsh.field_set_numbers(distance, "SurfacesList", &item.surfaces.iter().map(|&s| f64::from(s)).collect::<Vec<_>>())?;
            }
            if !item.curves.is_empty() {
                gmsh.field_set_numbers(distance, "CurvesList", &item.curves.iter().map(|&c| f64::from(c)).collect::<Vec<_>>())?;
            }
            gmsh.field_set_number(distance, "Sampling", 24.0)?;
            let threshold = gmsh.field_add("Threshold")?;
            gmsh.field_set_number(threshold, "InField", f64::from(distance))?;
            gmsh.field_set_number(threshold, "SizeMin", size)?;
            gmsh.field_set_number(threshold, "SizeMax", global_size)?;
            gmsh.field_set_number(threshold, "DistMin", size)?;
            gmsh.field_set_number(threshold, "DistMax", f64::max(2.0 * global_size, 2.0 * size))?;
            fields.push(f64::from(threshold));
        }
        for [x, y, z] in &item.points {
            let ball = gmsh.field_add("Ball")?;
            gmsh.field_set_number(ball, "Radius", 1.5 * global_size)?;
            gmsh.field_set_number(ball, "VIn", size)?;
            gmsh.field_set_number(ball, "VOut", global_size)?;
            gmsh.field_set_number(ball, "XCenter", *x)?;
            gmsh.field_set_number(ball, "YCenter", *y)?;
            gmsh.field_set_number(ball, "ZCenter", *z)?;
            gmsh.field_set_number(ball, "Thickness", global_size)?;
            fields.push(f64::from(ball));
        }
    }
    let low = gmsh.field_add("Min")?;
    gmsh.field_set_numbers(low, "FieldsList", &fields)?;
    gmsh.field_set_as_background_mesh(low)?;
    gmsh.set_number("Mesh.MeshSizeMax", global_size)?;
    if let Some(min_size) = controls.get("minSize").and_then(Value::as_f64) {
        gmsh.set_number("Mesh.MeshSizeMin", min_size * scale)?;
    }
    Ok(())
}

/// The refinements of `controls` whose key is a resolved target, built by `make` from that target's resolution.
pub fn refinements_of<R>(controls: &Value, resolved: &[(String, R)], make: impl Fn(f64, &R) -> Refinement) -> MeshResult<Vec<Refinement>> {
    let mut out = Vec::new();
    for refinement in crate::common::list(controls, "refinements") {
        let key = crate::common::text(refinement, "key")?;
        if let Some((_, item)) = resolved.iter().find(|(k, _)| k == key) {
            out.push(make(number(refinement, "size")?, item));
        }
    }
    Ok(out)
}

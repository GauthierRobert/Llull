//! `meshToBrep` (07 MSH M5): the prismatic B-rep of a segmented triangle mesh. Arguments and result are the `MeshToBrepRequest` /
//! `MeshToBrepResult` of `@core/geometry/kernelMeshBrep`: every group fitted by a plane, cylinder, cone or sphere becomes one exact face,
//! the others keep their triangles; the solid comes back as `BRepTools::Write` text (the document blob format).

use crate::session::{Reply, BAD_REQUEST, OCC_FAILURE};
use llull_kernel_occt::queries::mesh_to_brep;
use serde_json::Value;

/// Ops this module answers.
pub const MESH_BREP_OPS: [&str; 1] = ["meshToBrep"];

/// `KernelInfo.capabilities` this op adds.
pub const MESH_BREP_CAPABILITIES: [&str; 1] = ["meshToBrep"];

fn numbers(value: Option<&Value>) -> Option<Vec<f64>> {
    value?.as_array()?.iter().map(Value::as_f64).collect()
}

fn indices(value: Option<&Value>) -> Option<Vec<u32>> {
    value?.as_array()?.iter().map(|v| v.as_u64().and_then(|n| u32::try_from(n).ok())).collect()
}

fn kind_code(name: &str) -> Option<u8> {
    match name {
        "plane" => Some(0),
        "cylinder" => Some(1),
        "cone" => Some(2),
        "sphere" => Some(3),
        "faceted" => Some(4),
        _ => None,
    }
}

/// The ten numbers of a group: plane (point, normal), cylinder (axis point, axis, radius), cone (apex, axis, half angle), sphere (centre, radius).
fn params_of(kind: &str, group: &Value) -> Option<[f64; 10]> {
    let triple = |field: &str| -> Option<[f64; 3]> {
        match numbers(group.get(field))?.as_slice() {
            [x, y, z] => Some([*x, *y, *z]),
            _ => None,
        }
    };
    let number = |field: &str| group.get(field).and_then(Value::as_f64);
    let mut out = [0.0; 10];
    match kind {
        "plane" => {
            out[..3].copy_from_slice(&triple("point")?);
            out[3..6].copy_from_slice(&triple("normal")?);
        }
        "cylinder" => {
            out[..3].copy_from_slice(&triple("axisPoint")?);
            out[3..6].copy_from_slice(&triple("axis")?);
            out[6] = number("radius")?;
        }
        "cone" => {
            out[..3].copy_from_slice(&triple("apex")?);
            out[3..6].copy_from_slice(&triple("axis")?);
            out[6] = number("halfAngleRad")?;
        }
        "sphere" => {
            out[..3].copy_from_slice(&triple("center")?);
            out[3] = number("radius")?;
        }
        _ => {}
    }
    Some(out)
}

/// Answers `op` when it is `meshToBrep`, else `None`.
pub fn dispatch(op: &str, args: &[Value]) -> Option<Reply> {
    (op == "meshToBrep").then(|| mesh_to_brep_reply(args.first().unwrap_or(&Value::Null)))
}

fn mesh_to_brep_reply(request: &Value) -> Reply {
    let (Some(positions), Some(triangles), Some(face_group), Some(groups)) = (
        numbers(request.get("positions")),
        indices(request.get("indices")),
        indices(request.get("faceGroup")),
        request.get("groups").and_then(Value::as_array),
    ) else {
        return Reply::fail(BAD_REQUEST, "meshToBrep expects { positions, indices, faceGroup, groups, tolerance }");
    };
    let tolerance = request.get("tolerance").and_then(Value::as_f64).unwrap_or(1e-6);
    let mut kinds: Vec<u8> = Vec::with_capacity(groups.len());
    let mut params: Vec<f64> = Vec::with_capacity(groups.len() * 10);
    for group in groups {
        let name = group.get("kind").and_then(Value::as_str).unwrap_or("");
        let (Some(code), Some(ten)) = (kind_code(name), params_of(name, group)) else {
            return Reply::fail(BAD_REQUEST, format!("meshToBrep: group of kind '{name}' is missing its parameters"));
        };
        kinds.push(code);
        params.extend_from_slice(&ten);
    }
    match mesh_to_brep(&positions, &triangles, &face_group, &kinds, &params, tolerance) {
        Ok(result) => Reply::ok(result),
        Err(message) => Reply::fail(OCC_FAILURE, message),
    }
}

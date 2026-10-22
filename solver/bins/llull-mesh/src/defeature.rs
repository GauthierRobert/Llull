//! Defeaturing of STEP parts before meshing: cylinder / torus faces of radius <= maxFeatureSize and the faces nearest to facesNear are
//! removed (OCCT BRepAlgoAPI_Defeaturing). Returns the defeatured shape and the removed face numbers (of the original shape).

use crate::common::*;
use llull_netgen::Shape;
use serde_json::Value;
use std::collections::BTreeSet;

/// Whether a part asks for defeaturing (a non-empty spec, like Python's truthy dict).
pub fn wants_defeature(part: &Value) -> bool {
    part.get("defeature").is_some_and(|spec| spec.as_object().is_some_and(|o| !o.is_empty()))
}

pub fn defeature(shape: Shape, spec: &Value, scale: f64, entity_id: &str) -> MeshResult<(Shape, Vec<i32>)> {
    let faces: Vec<i32> = (1..=shape.face_count() as i32).collect();
    let mut chosen = BTreeSet::new();
    if let Some(size) = spec.get("maxFeatureSize").and_then(Value::as_f64) {
        let limit = size * scale;
        for &face in &faces {
            let radius = shape.face_radius(face)?;
            if radius > 0.0 && radius <= limit {
                chosen.insert(face);
            }
        }
    }
    for point in scaled_points(spec, "facesNear", scale)? {
        let ranked = rank(faces.iter().map(|&face| Ok((shape.face_distance(face, &point)?.0, face))).collect::<MeshResult<_>>()?);
        if let Some(&(_, nearest)) = ranked.first() {
            chosen.insert(nearest);
        }
    }
    if chosen.is_empty() {
        return Ok((shape, Vec::new()));
    }
    let chosen: Vec<i32> = chosen.into_iter().collect();
    let result = shape.defeatured(&chosen).map_err(|error| {
        MeshError::new("FEA_DEFEATURE_FAILED", format!("OCCT could not remove faces {chosen:?} of '{entity_id}': {error}"))
    })?;
    if result.solid_count() == 0 {
        return Err(MeshError::new("FEA_DEFEATURE_FAILED", format!("defeaturing '{entity_id}' left no geometry")));
    }
    Ok((result, chosen))
}

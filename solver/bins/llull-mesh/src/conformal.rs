//! Conformal bonding: all parts fragmented into ONE shape so touching parts share their interface (faces, then nodes), meshed once; one
//! raw mesh per part (its own solids' tetrahedra), in part order. Every raw mesh carries the coordinates of all nodes.

use crate::common::*;
use crate::elements::Nodes;
use crate::raw::RawMesh;
use crate::sizes::{mesh_params, shape_sizes};
use crate::solid::{extract, mesh_failed, order_of, read_step};
use crate::targets::{resolve_targets, Faces, TargetScope};
use llull_netgen::Shape;
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::Path;

pub fn mesh_conformal(parts: &[Value], targets: &[Value], controls: &Value, scale: f64, workdir: &Path) -> MeshResult<Vec<RawMesh>> {
    let mut shapes = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        let entity_id = text(part, "entityId")?;
        let geometry = field(part, "geometry")?;
        let kind = geometry.get("kind").and_then(Value::as_str).unwrap_or("");
        if kind != "step" {
            return Err(MeshError::new(
                "FEA_BONDING_UNSUPPORTED",
                format!("conformal bonding needs exact STEP geometry (use the OCC kernel): '{entity_id}' is {kind}"),
            ));
        }
        let shape = read_step(geometry, &workdir.join(format!("conformal_{index}.step")), scale)?;
        if shape.solid_count() == 0 {
            return Err(MeshError::new("FEA_MESH_FAILED", format!("the STEP geometry of '{entity_id}' has no solid")));
        }
        shapes.push(shape);
    }
    let model = Shape::fragment(&shapes.iter().collect::<Vec<_>>())
        .map_err(|error| MeshError::new("FEA_MESH_FAILED", format!("OCCT could not fragment the parts for conformal bonding: {error}")))?;
    let mut solids_of: Vec<Vec<i32>> = vec![Vec::new(); parts.len()];
    for solid in 1..=model.solid_count() as i32 {
        let owners = model.owners(solid);
        let part_id = |owner: i32| usize::try_from(owner).ok().and_then(|i| parts.get(i)).map_or(Ok(""), |part| text(part, "entityId"));
        if let [first, second, ..] = owners[..] {
            return Err(MeshError::new(
                "FEA_BONDING_OVERLAP",
                format!(
                    "conformal bonding: '{}' and '{}' overlap in volume; parts may only touch (subtract one from the other)",
                    part_id(first)?,
                    part_id(second)?
                ),
            ));
        }
        if let Some(own) = owners.first().and_then(|&owner| usize::try_from(owner).ok()).and_then(|i| solids_of.get_mut(i)) {
            own.push(solid);
        }
    }
    let (mut resolved_all, mut refinements, mut faces_of) = (Vec::new(), Vec::new(), Vec::new());
    for (part, own) in parts.iter().zip(&solids_of) {
        let entity_id = text(part, "entityId")?;
        let mut faces = BTreeSet::new();
        for &solid in own {
            faces.extend(model.solid_faces(solid)?);
        }
        let mut curves = BTreeSet::new();
        for &face in &faces {
            curves.extend(model.face_edges(face)?);
        }
        let mine: Vec<&Value> = targets.iter().filter(|t| t.get("entityId").and_then(Value::as_str) == Some(entity_id)).collect();
        let scope = TargetScope {
            faces: Faces::Brep { shape: &model, faces: faces.iter().copied().collect() },
            curves: Some(&curves),
            face_map: None,
            ambiguous: None,
        };
        let (resolved, local) = resolve_targets(&scope, &mine, controls, scale, entity_id)?;
        resolved_all.push(resolved);
        refinements.extend(local);
        faces_of.push(faces);
    }
    let sizes = shape_sizes(&model, &refinements, controls, scale)?;
    let mesh = model.mesh(&mesh_params(controls, scale, false, false)?, &sizes).map_err(|error| mesh_failed("conformal parts", error))?;
    let mut nodes = Nodes::new(&mesh.points);
    let quadratic = order_of(controls)? == 2;
    let mut raws = Vec::new();
    for (((part, own), faces), resolved) in parts.iter().zip(&solids_of).zip(&faces_of).zip(resolved_all) {
        let keep = |domain: i32| own.contains(&domain);
        let region_of = |face: i32, _: &[usize; 3]| faces.contains(&face).then_some(face);
        raws.push(extract(&mesh, &mut nodes, keep, region_of, quadratic, text(part, "entityId")?, resolved)?);
    }
    for raw in &mut raws {
        raw.coords = nodes.coords.clone();
    }
    Ok(raws)
}

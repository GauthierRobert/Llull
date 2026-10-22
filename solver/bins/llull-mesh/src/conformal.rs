//! Conformal bonding: all parts in ONE model, fragmented so touching parts share their interface (nodes + faces); one raw mesh
//! per part, in part order.

use crate::common::*;
use crate::raw::RawMesh;
use crate::solid::{dilate_all, extract, generate, import_step, resolve_targets, write_step, TargetScope};
use llull_gmsh::{DimTag, Gmsh};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::path::Path;

fn boundary_tags(gmsh: &Gmsh, dim_tags: &[DimTag]) -> MeshResult<Vec<i32>> {
    let mut seen = Vec::new();
    for (_, tag) in gmsh.boundary(dim_tags, false, false, false)? {
        if !seen.contains(&tag) {
            seen.push(tag);
        }
    }
    Ok(seen)
}

pub fn mesh_conformal(
    gmsh: &Gmsh,
    parts: &[Value],
    targets: &[Value],
    controls: &Value,
    scale: f64,
    workdir: &Path,
) -> MeshResult<Vec<RawMesh>> {
    gmsh.model_add("conformal")?;
    gmsh.set_string("Geometry.OCCTargetUnit", "")?;
    let mut imported: Vec<Vec<DimTag>> = Vec::new();
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
        let file = write_step(geometry, &workdir.join(format!("conformal_{index}.step")))?;
        let volumes: Vec<DimTag> = import_step(gmsh, &file)?.into_iter().filter(|(dim, _)| *dim == 3).collect();
        if volumes.is_empty() {
            return Err(MeshError::new("FEA_MESH_FAILED", format!("the STEP geometry of '{entity_id}' has no solid")));
        }
        imported.push(volumes);
    }
    gmsh.occ_synchronize()?;
    dilate_all(gmsh, scale)?;
    let flat: Vec<DimTag> = imported.iter().flatten().copied().collect();
    let mapping = gmsh
        .occ_fragment(&flat)
        .and_then(|(_, mapping)| gmsh.occ_synchronize().map(|()| mapping))
        .map_err(|error| MeshError::new("FEA_MESH_FAILED", format!("Gmsh could not fragment the parts for conformal bonding: {error}")))?;
    let mut owner: HashMap<i32, String> = HashMap::new();
    let mut volumes_of: Vec<Vec<i32>> = Vec::new();
    let mut cursor = 0;
    for (part, volumes) in parts.iter().zip(&imported) {
        let entity_id = text(part, "entityId")?;
        let mut own = Vec::new();
        for pieces in mapping.get(cursor..cursor + volumes.len()).unwrap_or(&[]) {
            for &(dim, tag) in pieces {
                if dim != 3 {
                    continue;
                }
                let first = owner.entry(tag).or_insert_with(|| entity_id.to_string());
                if first != entity_id {
                    return Err(MeshError::new(
                        "FEA_BONDING_OVERLAP",
                        format!(
                            "conformal bonding: '{first}' and '{entity_id}' overlap in volume; parts may only touch (subtract one from the other)"
                        ),
                    ));
                }
                own.push(tag);
            }
        }
        cursor += volumes.len();
        volumes_of.push(own);
    }
    let (mut scopes, mut resolved_all, mut refinements) = (Vec::new(), Vec::new(), Vec::new());
    for (part, own) in parts.iter().zip(&volumes_of) {
        let entity_id = text(part, "entityId")?;
        let surfaces = boundary_tags(gmsh, &own.iter().map(|&v| (3, v)).collect::<Vec<_>>())?;
        let curves: BTreeSet<i32> = boundary_tags(gmsh, &surfaces.iter().map(|&s| (2, s)).collect::<Vec<_>>())?.into_iter().collect();
        let region_of: Vec<(i32, i32)> = surfaces.iter().map(|&s| (s, s)).collect();
        let mine: Vec<&Value> = targets.iter().filter(|t| t.get("entityId").and_then(Value::as_str) == Some(entity_id)).collect();
        let scope = TargetScope { kind: "step", region_of: &region_of, curves: Some(&curves), face_map: None, ambiguous: None };
        let (resolved, local) = resolve_targets(gmsh, &scope, &mine, controls, scale, entity_id)?;
        scopes.push(region_of);
        resolved_all.push(resolved);
        refinements.extend(local);
    }
    generate(gmsh, controls, &refinements, scale, "conformal parts")?;
    let mut raws = Vec::new();
    for (((part, own), region_of), resolved) in parts.iter().zip(&volumes_of).zip(&scopes).zip(resolved_all) {
        raws.push(extract(gmsh, own, region_of, controls, text(part, "entityId")?, resolved)?);
    }
    Ok(raws)
}

//! The `mesh` request end to end: mesh every part (each in its own model, or all together for conformal bonding), then number nodes
//! and elements globally and contiguously (1..n) and turn the resolved targets into node / face sets.

use crate::common::*;
use crate::raw::RawMesh;
use llull_gmsh::Gmsh;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

fn nearest_node(nodes: &[usize], coords: &HashMap<usize, Point>, point: &Point) -> Option<(usize, f64)> {
    nodes.iter().filter_map(|n| coords.get(n).map(|c| (*n, dist(c, point)))).min_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)))
}

fn missing_node(tag: usize) -> MeshError {
    MeshError::new("FEA_MESH_FAILED", format!("Gmsh node {tag} of an element has no coordinates"))
}

fn coordinates(coords: &HashMap<usize, Point>, tag: usize) -> MeshResult<Point> {
    coords.get(&tag).copied().ok_or_else(|| missing_node(tag))
}

struct PartNodes {
    used: Vec<usize>,
    renumber: HashMap<usize, usize>,
}

fn configure(gmsh: &Gmsh) -> MeshResult<()> {
    for option in ["General.Terminal", "General.NumThreads", "Mesh.MaxNumThreads1D", "Mesh.MaxNumThreads2D", "Mesh.MaxNumThreads3D"] {
        gmsh.set_number(option, if option == "General.Terminal" { 0.0 } else { 1.0 })?;
    }
    Ok(())
}

fn mesh_parts(gmsh: &Gmsh, parts: &[Value], targets: &[Value], controls: &Value, scale: f64, workdir: &Path) -> MeshResult<Vec<RawMesh>> {
    if controls.get("bonding").and_then(Value::as_str) == Some("conformal") {
        return crate::conformal::mesh_conformal(gmsh, parts, targets, controls, scale, workdir);
    }
    let mut raws = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        let entity_id = text(part, "entityId")?;
        let own: Vec<&Value> = targets.iter().filter(|t| t.get("entityId").and_then(Value::as_str) == Some(entity_id)).collect();
        gmsh.clear()?;
        let kind = field(part, "geometry")?.get("kind").and_then(Value::as_str);
        raws.push(if kind == Some("midsurface") {
            crate::shell::mesh_midsurface_part(gmsh, part, &own, controls, scale)?
        } else {
            crate::solid::mesh_part(gmsh, part, &own, controls, scale, &workdir.join(format!("part_{index}")))?
        });
    }
    Ok(raws)
}

/// The response of a `mesh` request (Gmsh already initialised).
pub fn mesh(gmsh: &Gmsh, request: &Value, workdir: &Path) -> MeshResult<Value> {
    let single;
    let parts: &[Value] = match request.get("parts").and_then(Value::as_array) {
        Some(parts) => parts,
        None => {
            let entity_id = request.get("entityId").cloned().unwrap_or_else(|| json!("part"));
            single = [json!({ "entityId": entity_id, "geometry": field(request, "geometry")? })];
            &single
        }
    };
    let scale = request.get("lengthScale").and_then(Value::as_f64).unwrap_or(1.0);
    let controls = field(request, "controls")?;
    let targets = list(request, "targets");
    configure(gmsh)?;
    let version = gmsh.get_string("General.Version")?;
    let raws = mesh_parts(gmsh, parts, targets, controls, scale, workdir)?;

    let (mut nodes_out, mut blocks, mut defeatured) = (Vec::new(), Vec::new(), Vec::new());
    let (mut node_sets, mut face_sets, mut residuals) = (Map::new(), Map::new(), Map::new());
    let (mut node_counter, mut element_counter) = (0usize, 0usize);
    let mut part_nodes: Vec<(String, PartNodes)> = Vec::new();
    let shared: Option<HashMap<usize, usize>> = if controls.get("bonding").and_then(Value::as_str) == Some("conformal") {
        let all: BTreeSet<usize> =
            raws.iter().flat_map(|raw| raw.blocks.iter().flat_map(|(_, rows)| rows.iter().flatten().copied())).collect();
        let mut map = HashMap::new();
        for tag in all {
            node_counter += 1;
            map.insert(tag, node_counter);
            let [x, y, z] = coordinates(&raws[0].coords, tag)?;
            nodes_out.push(json!([node_counter, x, y, z]));
        }
        Some(map)
    } else {
        None
    };
    for (part, raw) in parts.iter().zip(&raws) {
        let entity_id = text(part, "entityId")?;
        let used: Vec<usize> =
            raw.blocks.iter().flat_map(|(_, rows)| rows.iter().flatten().copied()).collect::<BTreeSet<_>>().into_iter().collect();
        let renumber = match &shared {
            Some(map) => map.clone(),
            None => {
                let mut map = HashMap::new();
                for &tag in &used {
                    node_counter += 1;
                    map.insert(tag, node_counter);
                    let [x, y, z] = coordinates(&raw.coords, tag)?;
                    nodes_out.push(json!([node_counter, x, y, z]));
                }
                map
            }
        };
        let mut element_ids = Vec::new();
        for (block_type, rows) in &raw.blocks {
            let mut elements = Vec::new();
            for row in rows {
                element_counter += 1;
                element_ids.push(element_counter);
                let mut element = vec![element_counter];
                for node in row {
                    element.push(renumber.get(node).copied().ok_or_else(|| missing_node(*node))?);
                }
                elements.push(element);
            }
            blocks.push(json!({ "type": block_type, "entityId": entity_id, "elements": elements }));
        }
        if !raw.defeatured.is_empty() {
            defeatured.push(json!({ "entityId": entity_id, "faces": raw.defeatured }));
        }
        for (key, item) in &raw.resolved {
            let mut nodes: BTreeSet<usize> = BTreeSet::new();
            let mut faces: Vec<(usize, i32)> = Vec::new();
            for region in &item.faces {
                nodes.extend(raw.region_nodes.get(region).into_iter().flatten().copied());
                faces.extend(raw.region_faces.get(region).into_iter().flatten().map(|&(position, label)| (element_ids[position], label)));
            }
            if let Some(target_faces) = &raw.target_faces {
                faces = target_faces.get(key).into_iter().flatten().map(|&(position, label)| (element_ids[position], label)).collect();
            }
            for curve in &item.edges {
                nodes.extend(raw.curve_nodes.get(curve).into_iter().flatten().copied());
            }
            let mut residual = item.residual;
            for point in &item.points {
                if let Some((node, d)) = nearest_node(&used, &raw.coords, point) {
                    nodes.insert(node);
                    residual = residual.max(d);
                }
            }
            let mut ids: Vec<usize> = nodes.iter().filter_map(|n| renumber.get(n).copied()).collect();
            ids.sort_unstable();
            node_sets.insert(key.clone(), json!(ids));
            if !item.faces.is_empty() {
                faces.sort_unstable();
                face_sets.insert(key.clone(), json!(faces.iter().map(|(e, l)| [*e as i64, i64::from(*l)]).collect::<Vec<_>>()));
            }
            residuals.insert(key.clone(), json!({ "residual": residual }));
        }
        part_nodes.push((entity_id.to_string(), PartNodes { used, renumber }));
    }
    for target in targets {
        let key = text(target, "key")?;
        let entity_id = target.get("entityId").filter(|v| !v.is_null());
        if entity_id.is_none() {
            let mut best: Option<(usize, f64)> = None;
            for ((_, nodes), raw) in part_nodes.iter().zip(&raws) {
                for point in scaled_points(target, "pointsNear", scale)? {
                    if let Some((node, d)) = nearest_node(&nodes.used, &raw.coords, &point) {
                        if best.is_none_or(|(_, residual)| d < residual) {
                            best = Some((nodes.renumber.get(&node).copied().ok_or_else(|| missing_node(node))?, d));
                        }
                    }
                }
            }
            let Some((node, residual)) = best else {
                return Err(MeshError::new("FEA_TARGET_UNRESOLVED", format!("target {key}: no mesh node found")));
            };
            node_sets.insert(key.to_string(), json!([node]));
            residuals.insert(key.to_string(), json!({ "residual": residual }));
        } else if !residuals.contains_key(key) {
            let entity = entity_id.and_then(Value::as_str).unwrap_or("");
            return Err(MeshError::new("FEA_TARGET_UNRESOLVED", format!("target {key}: entity '{entity}' is not a meshed part")));
        } else if node_sets.get(key).and_then(Value::as_array).is_none_or(Vec::is_empty) {
            return Err(MeshError::new("FEA_TARGET_UNRESOLVED", format!("target {key} resolved to no mesh node")));
        }
    }
    let face_map: Vec<Value> = raws.iter().flat_map(|raw| raw.face_map.iter().cloned()).collect();
    let summary: BTreeMap<&str, Value> = BTreeMap::from([
        ("ok", json!(true)),
        ("mesher", json!("gmsh")),
        ("mesherVersion", json!(version)),
        ("nodes", json!(nodes_out)),
        ("blocks", json!(blocks)),
        ("nodeSets", Value::Object(node_sets)),
        ("faceSets", Value::Object(face_sets)),
        ("targets", Value::Object(residuals)),
        ("faceMap", json!(face_map)),
        ("defeatured", json!(defeatured)),
    ]);
    Ok(json!(summary))
}

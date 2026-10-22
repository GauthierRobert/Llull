//! Tetrahedral meshing of one solid part: STEP (exact B-rep faces, optionally defeatured, kernel face map TR-FEA-32) or STL (facet
//! regions grown with the classification angle), with its targets resolved before meshing so refinements shape the mesh.

use crate::common::*;
use crate::defeature::{defeature, wants_defeature};
use crate::elements::{curve_nodes, region_sets, surface_triangles, tet_faces, tet_rows, Nodes};
use crate::raw::{RawMesh, ResolvedTargets};
use crate::sizes::{mesh_params, point_sizes, shape_sizes};
use crate::stl::StlSurface;
use crate::targets::{face_map, resolve_targets, Faces, TargetScope};
use llull_netgen::{MeshData, Shape, Sizes};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;

pub fn order_of(controls: &Value) -> MeshResult<i64> {
    field(controls, "order")?.as_i64().ok_or_else(|| malformed("'order' is not an integer"))
}

fn decode(geometry: &Value, key: &str) -> MeshResult<Vec<u8>> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(text(geometry, key)?).map_err(|error| malformed(&format!("'{key}': {error}")))
}

/// The part's STEP geometry, read and scaled to the analysis unit (the file is written to `path` first: OCCT reads files).
pub fn read_step(geometry: &Value, path: &Path, scale: f64) -> MeshResult<Shape> {
    std::fs::write(path, decode(geometry, "stepBase64")?)
        .map_err(|error| malformed(&format!("cannot write {}: {error}", path.display())))?;
    Shape::read_step(&path.to_string_lossy(), scale)
        .map_err(|error| MeshError::new("FEA_MESH_FAILED", format!("the STEP geometry could not be read: {error}")))
}

pub fn mesh_failed(label: &str, error: llull_netgen::Error) -> MeshError {
    MeshError::new("FEA_MESH_FAILED", format!("Netgen could not mesh '{label}': {error}"))
}

/// Tetrahedra of the kept domains + the face triangles tagged with their region (`region_of(face, triangle)`), curve nodes.
pub fn extract(
    mesh: &MeshData,
    nodes: &mut Nodes,
    keep: impl Fn(i32) -> bool,
    region_of: impl Fn(i32, &[usize; 3]) -> Option<i32>,
    quadratic: bool,
    entity_id: &str,
    resolved: ResolvedTargets,
) -> MeshResult<RawMesh> {
    let tets = tet_rows(mesh, nodes, keep, quadratic)?;
    if tets.is_empty() {
        return Err(MeshError::new("FEA_MESH_FAILED", format!("Netgen produced no tetrahedra for '{entity_id}'")));
    }
    let triangles: Vec<([usize; 3], i32)> = surface_triangles(mesh)?
        .into_iter()
        .filter_map(|(triangle, face)| region_of(face, &triangle).map(|region| (triangle, region)))
        .collect();
    let (region_nodes, region_faces) = region_sets(&triangles, &tet_faces(&tets), nodes, quadratic)?;
    let curve_nodes = curve_nodes(mesh, nodes, quadratic, false)?;
    let element_type = if quadratic { "C3D10" } else { "C3D4" };
    Ok(RawMesh {
        coords: HashMap::new(),
        blocks: vec![(element_type.to_string(), tets)],
        resolved,
        region_nodes,
        region_faces,
        curve_nodes,
        target_faces: None,
        defeatured: Vec::new(),
        face_map: Vec::new(),
    })
}

fn mesh_step(part: &Value, targets: &[&Value], controls: &Value, scale: f64, path: &Path) -> MeshResult<RawMesh> {
    let entity_id = text(part, "entityId")?;
    let mut shape = read_step(field(part, "geometry")?, &path.with_extension("step"), scale)?;
    if shape.solid_count() == 0 {
        return Err(MeshError::new("FEA_MESH_FAILED", "the STEP geometry has no solid".into()));
    }
    let mut removed = Vec::new();
    if wants_defeature(part) {
        (shape, removed) = defeature(shape, field(part, "defeature")?, scale, entity_id)?;
    }
    let refs = if removed.is_empty() { list(part, "faces") } else { &[] };
    let (mapped, ambiguous) = if refs.is_empty() { Default::default() } else { face_map(&shape, refs, scale)? };
    let scope = TargetScope {
        faces: Faces::Brep { shape: &shape, faces: (1..=shape.face_count() as i32).collect() },
        curves: None,
        face_map: (!refs.is_empty()).then_some(&mapped),
        ambiguous: (!refs.is_empty()).then_some(&ambiguous),
    };
    let (resolved, refinements) = resolve_targets(&scope, targets, controls, scale, entity_id)?;
    let sizes = shape_sizes(&shape, &refinements, controls, scale)?;
    let mesh = shape.mesh(&mesh_params(controls, scale, false, false)?, &sizes).map_err(|error| mesh_failed(entity_id, error))?;
    let mut nodes = Nodes::new(&mesh.points);
    let quadratic = order_of(controls)? == 2;
    let mut raw = extract(&mesh, &mut nodes, |_| true, |face, _| Some(face), quadratic, entity_id, resolved)?;
    raw.coords = nodes.coords;
    raw.defeatured = removed;
    let mut entries: Vec<_> = mapped.into_iter().collect();
    entries.sort_by_key(|(index, _)| *index);
    raw.face_map = entries
        .into_iter()
        .map(|(index, (face, residual))| json!({ "entityId": entity_id, "faceIndex": index, "tag": face, "residual": residual }))
        .collect();
    Ok(raw)
}

fn mesh_stl(part: &Value, targets: &[&Value], controls: &Value, scale: f64) -> MeshResult<RawMesh> {
    let entity_id = text(part, "entityId")?;
    let surface = StlSurface::from_binary(&decode(field(part, "geometry")?, "stlBase64")?, scale)?;
    let scope = TargetScope { faces: Faces::Stl(&surface), curves: None, face_map: None, ambiguous: None };
    let (resolved, refinements) = resolve_targets(&scope, targets, controls, scale, entity_id)?;
    let mut sizes = Sizes::default();
    for item in &refinements {
        surface.region_sizes(&mut sizes, &item.surfaces, item.size * scale);
    }
    point_sizes(&mut sizes, &refinements, number(controls, "globalSize")? * scale, scale);
    let mesh = llull_netgen::mesh_stl(&surface.flat(), &mesh_params(controls, scale, false, false)?, &sizes)
        .map_err(|error| mesh_failed(entity_id, error))?;
    let mut nodes = Nodes::new(&mesh.points);
    let quadratic = order_of(controls)? == 2;
    let centre = |triangle: &[usize; 3]| -> Option<Point> {
        let corners: Vec<Point> = triangle.iter().filter_map(|t| nodes.coords.get(t).copied()).collect();
        (corners.len() == 3).then(|| [0, 1, 2].map(|k| (corners[0][k] + corners[1][k] + corners[2][k]) / 3.0))
    };
    // the region of each surface element is that of the input facet nearest to its centre
    let regions: HashMap<[usize; 3], i32> = surface_triangles(&mesh)?
        .into_iter()
        .filter_map(|(triangle, _)| centre(&triangle).map(|c| (triangle, surface.region_at(&c))))
        .collect();
    let mut raw = extract(&mesh, &mut nodes, |_| true, |_, triangle| regions.get(triangle).copied(), quadratic, entity_id, resolved)?;
    raw.coords = nodes.coords;
    Ok(raw)
}

/// Mesh one solid entity; returns its raw mesh + target sets.
pub fn mesh_part(part: &Value, targets: &[&Value], controls: &Value, scale: f64, path: &Path) -> MeshResult<RawMesh> {
    let entity_id = text(part, "entityId")?;
    match field(part, "geometry")?.get("kind").and_then(Value::as_str).unwrap_or("") {
        "step" => mesh_step(part, targets, controls, scale, path),
        _ if wants_defeature(part) => {
            Err(MeshError::new("FEA_DEFEATURE_FAILED", format!("defeaturing '{entity_id}' needs exact STEP geometry (use the OCC kernel)")))
        }
        "stl" => mesh_stl(part, targets, controls, scale),
        other => Err(MeshError::new("FEA_MESH_FAILED", format!("unknown geometry kind '{other}'"))),
    }
}

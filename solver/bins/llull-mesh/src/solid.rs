//! Tetrahedral meshing of one solid part (STEP: OCC faces; STL: facet regions grown with the classification angle) and the
//! resolution of its targets (faces near points, kernel face map TR-FEA-32, edges near points).

use crate::common::*;
use crate::fields::{refinements_of, size_fields};
use crate::raw::{curve_nodes, RawMesh, Refinement, Resolved, ResolvedTargets};
use llull_gmsh::Gmsh;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;

pub const TET4: i32 = 4;
pub const TET10: i32 = 11;
/// TR-FEA-32: a kernel face and a Gmsh surface are the same face when area and centroid agree to this fraction (of the area / diagonal).
const FACE_MAP_REL: f64 = 1e-6;
/// CalculiX tet face labels over 0-based corner indices: 1 = 1-2-3, 2 = 1-4-2, 3 = 2-4-3, 4 = 3-4-1.
const CCX_FACES: [(i32, [usize; 3]); 4] = [(1, [0, 1, 2]), (2, [0, 3, 1]), (3, [1, 3, 2]), (4, [2, 3, 0])];

/// Gmsh surface tag -> face region, in model order.
pub type RegionOf = Vec<(i32, i32)>;
/// Kernel face index -> (Gmsh surface, centroid residual).
pub type FaceMap = HashMap<i64, (i32, f64)>;
/// Kernel face index -> every Gmsh surface it matched.
pub type Ambiguous = HashMap<i64, Vec<i32>>;

/// A binary STL with every vertex multiplied by `scale` (in single precision, like the file).
pub fn scaled_stl(data: &[u8], scale: f64) -> MeshResult<Vec<u8>> {
    let count = data.get(80..84).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize).ok_or_else(|| malformed("STL header"))?;
    let records = data.get(84..84 + 50 * count).ok_or_else(|| malformed("truncated binary STL"))?;
    let mut out = vec![0u8; 80];
    out.extend_from_slice(&(count as u32).to_le_bytes());
    let factor = scale as f32;
    for record in records.chunks_exact(50) {
        out.extend_from_slice(&record[..12]);
        for value in record[12..48].chunks_exact(4) {
            out.extend_from_slice(&(f32::from_le_bytes([value[0], value[1], value[2], value[3]]) * factor).to_le_bytes());
        }
        out.extend_from_slice(&record[48..50]);
    }
    Ok(out)
}

fn centroid_key(element: &[usize], coords: &HashMap<usize, Point>) -> [i64; 3] {
    let corner = |k: usize| element.get(k).and_then(|n| coords.get(n)).copied().unwrap_or([0.0; 3]);
    let (a, b, c) = (corner(0), corner(1), corner(2));
    [0, 1, 2].map(|i| ((0.0 + a[i] + b[i] + c[i]) / 3.0 * 1e7).round() as i64)
}

/// Facet centroid -> face region, from a classification without reparametrisation patches.
fn stl_face_regions(gmsh: &Gmsh, path: &str) -> MeshResult<HashMap<[i64; 3], i32>> {
    gmsh.merge(path)?;
    gmsh.classify_surfaces(CLASSIFY_ANGLE_DEG.to_radians(), true, false, std::f64::consts::PI)?;
    let coords = node_coords(gmsh)?;
    let mut regions = HashMap::new();
    for (_, surface) in gmsh.entities(2)? {
        for triangle in surface_triangles(gmsh, surface)? {
            regions.insert(centroid_key(&triangle, &coords), surface);
        }
    }
    gmsh.clear()?;
    Ok(regions)
}

/// Discrete geometry from an STL; flat / smooth faces stay ONE region even when Gmsh splits them into patches.
fn load_stl(gmsh: &Gmsh, path: &str) -> MeshResult<RegionOf> {
    let regions = stl_face_regions(gmsh, path)?;
    gmsh.merge(path)?;
    gmsh.classify_surfaces(CLASSIFY_ANGLE_DEG.to_radians(), true, true, std::f64::consts::PI)?;
    let coords = node_coords(gmsh)?;
    let mut region_of = Vec::new();
    for (_, surface) in gmsh.entities(2)? {
        let triangles = surface_triangles(gmsh, surface)?;
        let region = triangles.first().and_then(|t| regions.get(&centroid_key(t, &coords)).copied()).unwrap_or(surface);
        region_of.push((surface, region));
    }
    gmsh.create_geometry()?;
    let surfaces: Vec<i32> = gmsh.entities(2)?.into_iter().map(|(_, tag)| tag).collect();
    let shell = gmsh.geo_add_surface_loop(&surfaces)?;
    gmsh.geo_add_volume(&[shell])?;
    gmsh.geo_synchronize()?;
    Ok(region_of)
}

/// Import a STEP file into the current model, scaled to the analysis unit.
pub fn import_step(gmsh: &Gmsh, path: &str) -> MeshResult<Vec<(i32, i32)>> {
    gmsh.set_string("Geometry.OCCTargetUnit", "")?;
    Ok(gmsh.occ_import_shapes(path)?)
}

pub fn dilate_all(gmsh: &Gmsh, scale: f64) -> MeshResult<()> {
    if scale != 1.0 {
        gmsh.occ_dilate(&gmsh.occ_entities(-1)?, scale)?;
        gmsh.occ_synchronize()?;
    }
    Ok(())
}

fn load_step(gmsh: &Gmsh, path: &str, scale: f64) -> MeshResult<RegionOf> {
    import_step(gmsh, path)?;
    gmsh.occ_synchronize()?;
    dilate_all(gmsh, scale)?;
    if gmsh.entities(3)?.is_empty() {
        return Err(MeshError::new("FEA_MESH_FAILED", "the STEP geometry has no solid".into()));
    }
    identity_regions(gmsh)
}

pub fn identity_regions(gmsh: &Gmsh) -> MeshResult<RegionOf> {
    Ok(gmsh.entities(2)?.into_iter().map(|(_, tag)| (tag, tag)).collect())
}

/// Face regions nearest to each point; residual = the largest point-to-face distance.
fn faces_of(gmsh: &Gmsh, region_of: &RegionOf, points: &[Point], key: &str, entity_id: &str) -> MeshResult<(BTreeSet<i32>, f64)> {
    let diag = model_diagonal(gmsh)?;
    let (mut resolved, mut residual) = (BTreeSet::new(), 0.0f64);
    for point in points {
        let mut per_region: Vec<(f64, i32)> = Vec::new();
        for &(surface, region) in region_of {
            let d = trimmed_distance(gmsh, 2, surface, point)?;
            match per_region.iter_mut().find(|(_, r)| *r == region) {
                Some(entry) => entry.0 = entry.0.min(d),
                None => per_region.push((d, region)),
            }
        }
        let ranked = rank(per_region);
        let Some(&(best, best_region)) = ranked.first() else {
            return Err(MeshError::new("FEA_TARGET_UNRESOLVED", format!("target {key}: '{entity_id}' has no face")));
        };
        if best > UNRESOLVED_REL * diag {
            return Err(MeshError::new(
                "FEA_TARGET_UNRESOLVED",
                format!(
                    "target {key}: no face of '{entity_id}' within {} of point {} (nearest is {} away)",
                    py_g3(UNRESOLVED_REL * diag),
                    py_point(point),
                    py_g3(best)
                ),
            ));
        }
        if ranked.len() > 1 && ranked[1].0 - best <= AMBIGUOUS_REL * diag {
            return Err(MeshError::new(
                "FEA_TARGET_AMBIGUOUS",
                format!(
                    "target {key}: point {} lies on the boundary between two faces of '{entity_id}'; move it into the face interior",
                    py_point(point)
                ),
            ));
        }
        resolved.insert(best_region);
        residual = residual.max(best);
    }
    Ok((resolved, residual))
}

/// Kernel face index -> Gmsh surface by area and centroid (TR-FEA-32). A face with no candidate is left out (its targets fall back to
/// the nearest-surface resolution); a face with several is left out too and listed in `Ambiguous`.
fn face_map(gmsh: &Gmsh, region_of: &RegionOf, refs: &[Value], scale: f64) -> MeshResult<(FaceMap, Ambiguous)> {
    let diag = model_diagonal(gmsh)?;
    let mut surfaces = Vec::new();
    for &(surface, _) in region_of {
        surfaces.push((surface, gmsh.occ_mass(2, surface)?, gmsh.occ_center_of_mass(2, surface)?));
    }
    let (mut mapped, mut ambiguous) = (FaceMap::new(), Ambiguous::new());
    for reference in refs {
        let index = field(reference, "index")?.as_i64().ok_or_else(|| malformed("face index"))?;
        let area = number(reference, "area")? * scale * scale;
        let centre = point_of(field(reference, "centroid")?)?.map(|c| c * scale);
        let found: Vec<(i32, f64)> = surfaces
            .iter()
            .filter_map(|(surface, surface_area, surface_centre)| {
                let distance = dist(&centre, surface_centre);
                ((surface_area - area).abs() <= FACE_MAP_REL * area && distance <= FACE_MAP_REL * diag).then_some((*surface, distance))
            })
            .collect();
        if found.len() > 1 {
            ambiguous.insert(index, found.iter().map(|(s, _)| *s).collect());
        } else if let Some(&hit) = found.first() {
            mapped.insert(index, hit);
        }
    }
    Ok((mapped, ambiguous))
}

pub fn edges_of(
    gmsh: &Gmsh,
    points: &[Point],
    key: &str,
    entity_id: &str,
    curves: Option<&BTreeSet<i32>>,
) -> MeshResult<(BTreeSet<i32>, f64)> {
    let diag = model_diagonal(gmsh)?;
    let candidates: Vec<i32> = match curves {
        Some(curves) => curves.iter().copied().collect(),
        None => gmsh.entities(1)?.into_iter().map(|(_, tag)| tag).collect(),
    };
    let (mut resolved, mut residual) = (BTreeSet::new(), 0.0f64);
    for point in points {
        let ranked = rank(candidates.iter().map(|&tag| Ok((trimmed_distance(gmsh, 1, tag, point)?, tag))).collect::<MeshResult<_>>()?);
        match ranked.first() {
            Some(&(best, _)) if best <= UNRESOLVED_REL * diag => {}
            _ => {
                return Err(MeshError::new(
                    "FEA_TARGET_UNRESOLVED",
                    format!("target {key}: no edge of '{entity_id}' near point {}", py_point(point)),
                ))
            }
        }
        if ranked.len() > 1 && ranked[1].0 - ranked[0].0 <= AMBIGUOUS_REL * diag {
            return Err(MeshError::new(
                "FEA_TARGET_AMBIGUOUS",
                format!("target {key}: point {} lies on two edges of '{entity_id}'", py_point(point)),
            ));
        }
        resolved.insert(ranked[0].1);
        residual = residual.max(ranked[0].0);
    }
    Ok((resolved, residual))
}

/// What a solid part's targets resolve against.
pub struct TargetScope<'a> {
    pub kind: &'a str,
    pub region_of: &'a RegionOf,
    pub curves: Option<&'a BTreeSet<i32>>,
    pub face_map: Option<&'a FaceMap>,
    pub ambiguous: Option<&'a Ambiguous>,
}

/// Targets of one entity -> resolved faces / edges / points + the refinement fields they define. With a face map a target whose
/// `faceIndices` are all mapped takes those surfaces; one naming an ambiguous face fails with AMBIGUOUS_FACE_MAP.
pub fn resolve_targets(
    gmsh: &Gmsh,
    scope: &TargetScope<'_>,
    targets: &[&Value],
    controls: &Value,
    scale: f64,
    entity_id: &str,
) -> MeshResult<(ResolvedTargets, Vec<Refinement>)> {
    let mut resolved: ResolvedTargets = Vec::new();
    for target in targets {
        let key = text(target, "key")?.to_string();
        let mut item = Resolved::default();
        let indices: Vec<i64> = list(target, "faceIndices").iter().filter_map(Value::as_i64).collect();
        if let Some(clash) = indices.iter().find(|i| scope.ambiguous.is_some_and(|a| a.contains_key(i))) {
            let tags = scope.ambiguous.and_then(|a| a.get(clash)).cloned().unwrap_or_default();
            return Err(MeshError::new(
                "AMBIGUOUS_FACE_MAP",
                format!("target {key}: face {clash} of '{entity_id}' matches Gmsh surfaces {tags:?} by area and centroid"),
            ));
        }
        let faces_near = scaled_points(target, "facesNear", scale)?;
        if !faces_near.is_empty() {
            // always run the point resolution: it still reports UNRESOLVED / AMBIGUOUS and gives the residual
            (item.faces, item.residual) = faces_of(gmsh, scope.region_of, &faces_near, &key, entity_id)?;
        }
        if let Some(map) = scope.face_map.filter(|map| !indices.is_empty() && indices.iter().all(|i| map.contains_key(i))) {
            item.faces = indices.iter().filter_map(|i| map.get(i).map(|hit| hit.0)).collect();
        }
        let edges_near = scaled_points(target, "edgesNear", scale)?;
        if !edges_near.is_empty() {
            if scope.kind != "step" {
                return Err(MeshError::new(
                    "FEA_TARGET_UNRESOLVED",
                    format!("target {key}: edgesNear needs exact STEP geometry (use the OCC kernel)"),
                ));
            }
            let (edges, edge_residual) = edges_of(gmsh, &edges_near, &key, entity_id, scope.curves)?;
            item.edges = edges;
            item.residual = item.residual.max(edge_residual);
        }
        item.points = scaled_points(target, "pointsNear", scale)?;
        match resolved.iter_mut().find(|(k, _)| *k == key) {
            Some(entry) => entry.1 = item,
            None => resolved.push((key, item)),
        }
    }
    let refinements = refinements_of(controls, &resolved, |size, item: &Resolved| Refinement {
        size,
        surfaces: scope.region_of.iter().filter(|(_, region)| item.faces.contains(region)).map(|(s, _)| *s).collect(),
        curves: Vec::new(),
        points: item.points.clone(),
    })?;
    Ok((resolved, refinements))
}

pub fn order_of(controls: &Value) -> MeshResult<i64> {
    field(controls, "order")?.as_i64().ok_or_else(|| malformed("'order' is not an integer"))
}

pub fn generate(gmsh: &Gmsh, controls: &Value, refinements: &[Refinement], scale: f64, label: &str) -> MeshResult<()> {
    size_fields(gmsh, controls, refinements, scale)?;
    let order = order_of(controls)? as f64;
    for (option, value) in [
        ("Mesh.MeshSizeExtendFromBoundary", 0.0),
        ("Mesh.MeshSizeFromPoints", 0.0),
        ("Mesh.MeshSizeFromCurvature", 0.0),
        ("Mesh.ElementOrder", order),
        ("Mesh.SecondOrderLinear", 1.0),
        ("Mesh.Algorithm3D", 1.0),
        ("Mesh.RandomFactor", 1e-9),
    ] {
        gmsh.set_number(option, value)?;
    }
    gmsh.generate(3).map_err(|error| MeshError::new("FEA_MESH_FAILED", format!("Gmsh could not mesh '{label}': {error}")))
}

/// Tetrahedra of `volumes`, the face triangles of `region_of` matched to their tet faces, curve nodes.
pub fn extract(
    gmsh: &Gmsh,
    volumes: &[i32],
    region_of: &RegionOf,
    controls: &Value,
    entity_id: &str,
    resolved: ResolvedTargets,
) -> MeshResult<RawMesh> {
    let coords = node_coords(gmsh)?;
    let quadratic = order_of(controls)? == 2;
    let wanted = if quadratic { TET10 } else { TET4 };
    let mut tets: Vec<Vec<usize>> = Vec::new();
    for &volume in volumes {
        for (element_type, nodes) in gmsh.elements(3, volume)? {
            if element_type != wanted {
                return Err(MeshError::new("FEA_MESH_FAILED", format!("unexpected Gmsh element type {element_type} in '{entity_id}'")));
            }
            let width = if element_type == TET10 { 10 } else { 4 };
            for row in nodes.chunks_exact(width) {
                let mut row = row.to_vec();
                if width == 10 {
                    row.swap(8, 9);
                }
                tets.push(row);
            }
        }
    }
    if tets.is_empty() {
        return Err(MeshError::new("FEA_MESH_FAILED", format!("Gmsh produced no tetrahedra for '{entity_id}'")));
    }
    let mut face_index: HashMap<[usize; 3], (usize, i32)> = HashMap::new();
    for (position, tet) in tets.iter().enumerate() {
        for (label, corners) in CCX_FACES {
            let mut key = corners.map(|c| tet[c]);
            key.sort_unstable();
            face_index.entry(key).or_insert((position, label));
        }
    }
    let mut region_nodes: HashMap<i32, HashSet<usize>> = HashMap::new();
    let mut region_faces: HashMap<i32, Vec<(usize, i32)>> = HashMap::new();
    for &(surface, region) in region_of {
        for triangle in surface_triangles(gmsh, surface)? {
            region_nodes.entry(region).or_default().extend(triangle.iter().copied());
            let mut key = [triangle[0], triangle[1], triangle[2]];
            key.sort_unstable();
            if let Some(&hit) = face_index.get(&key) {
                region_faces.entry(region).or_default().push(hit);
            }
        }
    }
    let element_type = if quadratic { "C3D10" } else { "C3D4" };
    Ok(RawMesh {
        coords,
        blocks: vec![(element_type.to_string(), tets)],
        resolved,
        region_nodes,
        region_faces,
        curve_nodes: curve_nodes(gmsh)?,
        target_faces: None,
        defeatured: Vec::new(),
        face_map: Vec::new(),
    })
}

fn decode(geometry: &Value, key: &str) -> MeshResult<Vec<u8>> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(text(geometry, key)?).map_err(|error| malformed(&format!("'{key}': {error}")))
}

pub fn write_step(geometry: &Value, path: &Path) -> MeshResult<String> {
    std::fs::write(path, decode(geometry, "stepBase64")?)
        .map_err(|error| malformed(&format!("cannot write {}: {error}", path.display())))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Whether a part asks for defeaturing (a non-empty spec, like Python's truthy dict).
pub fn wants_defeature(part: &Value) -> bool {
    part.get("defeature").is_some_and(|spec| spec.as_object().is_some_and(|o| !o.is_empty()))
}

/// Mesh one solid entity in a fresh model; returns its raw mesh + target sets in tags of this model.
pub fn mesh_part(gmsh: &Gmsh, part: &Value, targets: &[&Value], controls: &Value, scale: f64, path: &Path) -> MeshResult<RawMesh> {
    let entity_id = text(part, "entityId")?;
    let geometry = field(part, "geometry")?;
    let kind = geometry.get("kind").and_then(Value::as_str).unwrap_or("");
    gmsh.model_add(&format!("part_{entity_id}"))?;
    let mut removed = Vec::new();
    let region_of = match kind {
        "step" => {
            let file = write_step(geometry, &path.with_extension("step"))?;
            let mut region_of = load_step(gmsh, &file, scale)?;
            if wants_defeature(part) {
                removed = crate::shell::defeature(gmsh, field(part, "defeature")?, scale, entity_id)?;
                region_of = identity_regions(gmsh)?;
            }
            region_of
        }
        _ if wants_defeature(part) => {
            return Err(MeshError::new(
                "FEA_DEFEATURE_FAILED",
                format!("defeaturing '{entity_id}' needs exact STEP geometry (use the OCC kernel)"),
            ))
        }
        "stl" => {
            let file = path.with_extension("stl");
            std::fs::write(&file, scaled_stl(&decode(geometry, "stlBase64")?, scale)?)
                .map_err(|error| malformed(&format!("cannot write {}: {error}", file.display())))?;
            load_stl(gmsh, &file.to_string_lossy())?
        }
        other => return Err(MeshError::new("FEA_MESH_FAILED", format!("unknown geometry kind '{other}'"))),
    };
    let refs = if removed.is_empty() { list(part, "faces") } else { &[] };
    let (mapped, ambiguous) =
        if !refs.is_empty() && kind == "step" { face_map(gmsh, &region_of, refs, scale)? } else { Default::default() };
    let with_map = !refs.is_empty() && kind == "step";
    let scope = TargetScope {
        kind,
        region_of: &region_of,
        curves: None,
        face_map: with_map.then_some(&mapped),
        ambiguous: with_map.then_some(&ambiguous),
    };
    let (resolved, refinements) = resolve_targets(gmsh, &scope, targets, controls, scale, entity_id)?;
    generate(gmsh, controls, &refinements, scale, entity_id)?;
    let volumes: Vec<i32> = gmsh.entities(3)?.into_iter().map(|(_, tag)| tag).collect();
    let mut raw = extract(gmsh, &volumes, &region_of, controls, entity_id, resolved)?;
    raw.defeatured = removed;
    let mut entries: Vec<_> = mapped.into_iter().collect();
    entries.sort_by_key(|(index, _)| *index);
    raw.face_map = entries
        .into_iter()
        .map(|(index, (tag, residual))| json!({ "entityId": entity_id, "faceIndex": index, "tag": tag, "residual": residual }))
        .collect();
    Ok(raw)
}

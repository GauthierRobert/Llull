//! 2D parts (FEA-REST part 3, 05 M6): shell / plane-stress parts meshed on their midsurface, and Gmsh defeaturing of STEP parts.
//!
//! Every mid face becomes an OCC plane surface; all faces are fragmented together so touching faces share their edges (conformal),
//! then meshed in 2D: triangles (S3 / S6, CPS3 / CPS6) or, with controls.elementFamily "shell_quad", quadrilaterals by subdivision
//! (S4 / S8, CPS4 / CPS8). Elements are oriented so their corner normal follows the face "normal" (the top of the wall).
//! A facesNear point resolves to the nearest mid face, or to the nearest boundary curve when that curve is as near (a point on a side
//! wall targets the shell edge there); faces get a pressure side label (1 = +normal side, 2 = below).

use crate::common::*;
use crate::fields::{refinements_of, size_fields};
use crate::raw::{curve_nodes, RawMesh, Refinement, Resolved};
use llull_gmsh::Gmsh;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

const TRI3: i32 = 2;
const QUAD4: i32 = 3;
const TRI6: i32 = 9;
const QUAD8: i32 = 16;

/// `(nodes per element, CalculiX suffix, corner order reversed with the mid-edge nodes)` of a 2D element type.
fn shape(element_type: i32) -> Option<(usize, &'static str, &'static [usize])> {
    match element_type {
        TRI3 => Some((3, "3", &[0, 2, 1])),
        QUAD4 => Some((4, "4", &[0, 3, 2, 1])),
        TRI6 => Some((6, "6", &[0, 2, 1, 5, 4, 3])),
        QUAD8 => Some((8, "8", &[0, 3, 2, 1, 7, 6, 5, 4])),
        _ => None,
    }
}

fn sub(a: &[f64], b: &[f64]) -> Point {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross(a: &Point, b: &Point) -> Point {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    py_sum(a.iter().zip(b).map(|(x, y)| x * y))
}

/// Mid surface tag -> its face normal, in creation order.
fn build_faces(gmsh: &Gmsh, faces: &[Value], scale: f64) -> MeshResult<Vec<(i32, Point)>> {
    let mut inputs = Vec::new();
    for face in faces {
        let mut loops = Vec::new();
        let outer = field(face, "outer")?;
        for lp in std::iter::once(outer).chain(list(face, "holes").iter()) {
            let mut points = Vec::new();
            for p in lp.as_array().ok_or_else(|| malformed("a face loop is not an array"))? {
                let [x, y, z] = point_of(p)?.map(|c| c * scale);
                points.push(gmsh.occ_add_point(x, y, z)?);
            }
            let mut lines = Vec::new();
            for i in 0..points.len() {
                lines.push(gmsh.occ_add_line(points[i], points[(i + 1) % points.len()])?);
            }
            loops.push(gmsh.occ_add_curve_loop(&lines)?);
        }
        inputs.push(((2, gmsh.occ_add_plane_surface(&loops)?), point_of(field(face, "normal")?)?));
    }
    gmsh.occ_synchronize()?;
    let mapping = if inputs.len() > 1 {
        let (_, mapping) = gmsh.occ_fragment(&inputs.iter().map(|(dim_tag, _)| *dim_tag).collect::<Vec<_>>())?;
        gmsh.occ_synchronize()?;
        mapping
    } else {
        inputs.iter().map(|(dim_tag, _)| vec![*dim_tag]).collect()
    };
    let mut normal_of: Vec<(i32, Point)> = Vec::new();
    for ((_, normal), pieces) in inputs.iter().zip(mapping) {
        for (dim, tag) in pieces {
            if dim == 2 && !normal_of.iter().any(|(t, _)| *t == tag) {
                normal_of.push((tag, *normal));
            }
        }
    }
    Ok(normal_of)
}

fn ranked_on(gmsh: &Gmsh, dim: i32, tags: &[i32], point: &Point) -> MeshResult<Vec<(f64, i32)>> {
    Ok(rank(tags.iter().map(|&tag| Ok((trimmed_distance(gmsh, dim, tag, point)?, tag))).collect::<MeshResult<_>>()?))
}

fn resolve(
    gmsh: &Gmsh,
    normal_of: &BTreeMap<i32, Point>,
    targets: &[&Value],
    scale: f64,
    thickness: f64,
    entity_id: &str,
) -> MeshResult<Vec<(String, Resolved)>> {
    let diag = model_diagonal(gmsh)?;
    let tolerance = f64::max(UNRESOLVED_REL * diag, 0.75 * thickness);
    let surfaces: Vec<i32> = normal_of.keys().copied().collect();
    let mut curves: Vec<i32> = gmsh.entities(1)?.into_iter().map(|(_, tag)| tag).collect();
    curves.sort_unstable();
    let mut resolved: Vec<(String, Resolved)> = Vec::new();
    for target in targets {
        let key = text(target, "key")?.to_string();
        let mut item = Resolved::default();
        for point in scaled_points(target, "facesNear", scale)? {
            let ranked_s = ranked_on(gmsh, 2, &surfaces, &point)?;
            let ranked_c = ranked_on(gmsh, 1, &curves, &point)?;
            let nearest_surface = ranked_s.first().map_or(f64::INFINITY, |r| r.0);
            let on_edge = ranked_c.first().is_some_and(|c| c.0 <= nearest_surface + AMBIGUOUS_REL * diag);
            let ranked = if on_edge { &ranked_c } else { &ranked_s };
            let Some(&(best, tag)) = ranked.first().filter(|(best, _)| *best <= tolerance) else {
                return Err(MeshError::new(
                    "FEA_TARGET_UNRESOLVED",
                    format!("target {key}: no mid face or edge of '{entity_id}' near point {}", py_point(&point)),
                ));
            };
            if ranked.len() > 1 && ranked[1].0 - best <= AMBIGUOUS_REL * diag {
                return Err(MeshError::new(
                    "FEA_TARGET_AMBIGUOUS",
                    format!(
                        "target {key}: point {} is as near to two {} of '{entity_id}'",
                        py_point(&point),
                        if on_edge { "edges" } else { "faces" }
                    ),
                ));
            }
            item.residual = item.residual.max(best);
            if on_edge {
                item.edges.insert(tag);
            } else if !item.labels.iter().any(|(surface, _)| *surface == tag) {
                let closest = gmsh.closest_point(2, tag, &point)?.0;
                let normal = normal_of.get(&tag).copied().unwrap_or([0.0; 3]);
                item.labels.push((tag, if dot(&sub(&point, &closest), &normal) >= 0.0 { 1 } else { 2 }));
            }
        }
        for point in scaled_points(target, "edgesNear", scale)? {
            let ranked = ranked_on(gmsh, 1, &curves, &point)?;
            let Some(&(best, tag)) = ranked.first().filter(|(best, _)| *best <= tolerance) else {
                return Err(MeshError::new(
                    "FEA_TARGET_UNRESOLVED",
                    format!("target {key}: no edge of '{entity_id}' near point {}", py_point(&point)),
                ));
            };
            if ranked.len() > 1 && ranked[1].0 - best <= AMBIGUOUS_REL * diag {
                return Err(MeshError::new(
                    "FEA_TARGET_AMBIGUOUS",
                    format!("target {key}: point {} lies on two edges of '{entity_id}'", py_point(&point)),
                ));
            }
            item.edges.insert(tag);
            item.residual = item.residual.max(best);
        }
        item.faces = item.labels.iter().map(|(surface, _)| *surface).collect();
        item.points = scaled_points(target, "pointsNear", scale)?;
        match resolved.iter_mut().find(|(k, _)| *k == key) {
            Some(entry) => entry.1 = item,
            None => resolved.push((key, item)),
        }
    }
    Ok(resolved)
}

fn generate(gmsh: &Gmsh, controls: &Value, refinements: &[Refinement], scale: f64, entity_id: &str) -> MeshResult<()> {
    size_fields(gmsh, controls, refinements, scale)?;
    let quads = controls.get("elementFamily").and_then(Value::as_str) == Some("shell_quad");
    let flag = |on: bool| if on { 1.0 } else { 0.0 };
    for (option, value) in [
        ("Mesh.MeshSizeExtendFromBoundary", 0.0),
        ("Mesh.MeshSizeFromPoints", 0.0),
        ("Mesh.MeshSizeFromCurvature", 0.0),
        ("Mesh.ElementOrder", crate::solid::order_of(controls)? as f64),
        ("Mesh.SecondOrderIncomplete", 1.0),
        ("Mesh.SecondOrderLinear", 1.0),
        ("Mesh.RandomFactor", 1e-9),
        ("Mesh.Algorithm", if quads { 8.0 } else { 6.0 }),
        ("Mesh.RecombineAll", flag(quads)),
        ("Mesh.RecombinationAlgorithm", 1.0),
        ("Mesh.SubdivisionAlgorithm", flag(quads)),
    ] {
        gmsh.set_number(option, value)?;
    }
    gmsh.generate(2)
        .map_err(|error| MeshError::new("FEA_MESH_FAILED", format!("Gmsh could not mesh the midsurface of '{entity_id}': {error}")))
}

/// Mesh one 2D part in a fresh model.
pub fn mesh_midsurface_part(gmsh: &Gmsh, part: &Value, targets: &[&Value], controls: &Value, scale: f64) -> MeshResult<RawMesh> {
    let entity_id = text(part, "entityId")?;
    let geometry = field(part, "geometry")?;
    let prefix = if geometry.get("element").and_then(Value::as_str) == Some("shell") { "S" } else { "CPS" };
    let thickness = number(geometry, "thickness")? * scale;
    gmsh.model_add(&format!("mid_{entity_id}"))?;
    let faces = list(geometry, "faces");
    let mut points = Vec::new();
    for face in faces {
        for p in list(face, "outer") {
            points.push(point_of(p)?);
        }
    }
    let head = &points[..points.len().min(64)];
    let span = head.iter().flat_map(|a| head.iter().map(move |b| dist(a, b))).reduce(f64::max).unwrap_or(1.0) * scale;
    gmsh.set_number("Geometry.ToleranceBoolean", f64::max(1e-9, 1e-7 * span))?;
    let normal_list = build_faces(gmsh, faces, scale)?;
    if normal_list.is_empty() {
        return Err(MeshError::new("FEA_MESH_FAILED", format!("the midsurface of '{entity_id}' has no face")));
    }
    let normal_of: BTreeMap<i32, Point> = normal_list.into_iter().collect();
    let resolved = resolve(gmsh, &normal_of, targets, scale, thickness, entity_id)?;
    let refinements = refinements_of(controls, &resolved, |size, item: &Resolved| Refinement {
        size,
        surfaces: item.faces.iter().copied().collect(),
        curves: item.edges.iter().copied().collect(),
        points: item.points.clone(),
    })?;
    generate(gmsh, controls, &refinements, scale, entity_id)?;
    let coords = node_coords(gmsh)?;
    let corner = |n: usize| coords.get(&n).copied().unwrap_or([0.0; 3]);
    let mut per_type: BTreeMap<i32, Vec<(Vec<usize>, i32)>> = BTreeMap::new();
    for (&surface, normal) in &normal_of {
        for (element_type, nodes) in gmsh.elements(2, surface)? {
            let Some((width, _, flip)) = shape(element_type) else {
                return Err(MeshError::new("FEA_MESH_FAILED", format!("unexpected Gmsh element type {element_type} in '{entity_id}'")));
            };
            for row in nodes.chunks_exact(width) {
                let (a, b, c) = (corner(row[0]), corner(row[1]), corner(row[2]));
                let row = if dot(&cross(&sub(&b, &a), &sub(&c, &a)), normal) < 0.0 {
                    flip.iter().map(|&k| row[k]).collect()
                } else {
                    row.to_vec()
                };
                per_type.entry(element_type).or_default().push((row, surface));
            }
        }
    }
    let mut blocks: Vec<(String, Vec<Vec<usize>>)> = Vec::new();
    let mut positions: HashMap<i32, Vec<usize>> = HashMap::new();
    let mut region_nodes: HashMap<i32, HashSet<usize>> = HashMap::new();
    for (element_type, rows) in &per_type {
        let before: usize = blocks.iter().map(|(_, r)| r.len()).sum();
        let mut out = Vec::new();
        for (row, surface) in rows {
            positions.entry(*surface).or_default().push(before + out.len());
            region_nodes.entry(*surface).or_default().extend(row.iter().copied());
            out.push(row.clone());
        }
        let suffix = shape(*element_type).map_or("", |s| s.1);
        blocks.push((format!("{prefix}{suffix}"), out));
    }
    if blocks.is_empty() {
        return Err(MeshError::new("FEA_MESH_FAILED", format!("Gmsh produced no 2D elements for '{entity_id}'")));
    }
    let target_faces = resolved
        .iter()
        .filter(|(_, item)| !item.labels.is_empty())
        .map(|(key, item)| {
            let mut faces: Vec<(usize, i32)> = item
                .labels
                .iter()
                .flat_map(|(surface, label)| positions.get(surface).into_iter().flatten().map(move |&p| (p, *label)))
                .collect();
            faces.sort_unstable();
            (key.clone(), faces)
        })
        .collect();
    Ok(RawMesh {
        coords,
        blocks,
        resolved,
        region_nodes,
        region_faces: HashMap::new(),
        curve_nodes: curve_nodes(gmsh)?,
        target_faces: Some(target_faces),
        defeatured: Vec::new(),
        face_map: Vec::new(),
    })
}

/// Remove cylinder / torus faces of radius <= maxFeatureSize and the faces nearest to facesNear (Gmsh occ defeature); returns the tags.
pub fn defeature(gmsh: &Gmsh, spec: &Value, scale: f64, entity_id: &str) -> MeshResult<Vec<i32>> {
    let mut chosen = BTreeSet::new();
    if let Some(size) = spec.get("maxFeatureSize").and_then(Value::as_f64) {
        let limit = size * scale;
        for (_, tag) in gmsh.entities(2)? {
            if !matches!(gmsh.entity_type(2, tag)?.as_str(), "Cylinder" | "Torus") {
                continue;
            }
            let (low, high) = gmsh.parametrization_bounds(2, tag)?;
            let middle = |i: usize| (low.get(i).copied().unwrap_or(0.0) + high.get(i).copied().unwrap_or(0.0)) / 2.0;
            let (kmax, kmin) = gmsh.principal_curvatures(tag, &[middle(0), middle(1)])?;
            let curvature = f64::max(kmax.first().copied().unwrap_or(0.0).abs(), kmin.first().copied().unwrap_or(0.0).abs());
            if curvature > 0.0 && 1.0 / curvature <= limit {
                chosen.insert(tag);
            }
        }
    }
    let surfaces: Vec<i32> = gmsh.entities(2)?.into_iter().map(|(_, tag)| tag).collect();
    for point in scaled_points(spec, "facesNear", scale)? {
        if let Some(&(_, nearest)) = ranked_on(gmsh, 2, &surfaces, &point)?.first() {
            chosen.insert(nearest);
        }
    }
    if chosen.is_empty() {
        return Ok(Vec::new());
    }
    let chosen: Vec<i32> = chosen.into_iter().collect();
    let volumes: Vec<i32> = gmsh.entities(3)?.into_iter().map(|(_, tag)| tag).collect();
    gmsh.occ_defeature(&volumes, &chosen).and_then(|_| gmsh.occ_synchronize()).map_err(|error| {
        MeshError::new("FEA_DEFEATURE_FAILED", format!("Gmsh could not remove faces {chosen:?} of '{entity_id}': {error}"))
    })?;
    if gmsh.bounding_box(-1, -1)?.iter().sum::<f64>().is_nan() {
        return Err(MeshError::new("FEA_DEFEATURE_FAILED", format!("defeaturing '{entity_id}' left no geometry")));
    }
    Ok(chosen)
}

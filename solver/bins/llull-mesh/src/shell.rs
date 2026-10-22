//! 2D parts (FEA-REST part 3, 05 M6): shell / plane-stress parts meshed on their midsurface.
//!
//! Every mid face becomes a planar OCCT face; all faces are fragmented together so touching faces share their edges (conformal), then
//! Netgen meshes the faces only: triangles (S3 / S6, CPS3 / CPS6) or, with controls.elementFamily "shell_quad", quadrilaterals: a
//! quad-dominant mesh whose every element is then split into quads (a quad into 4, a triangle into 3), so the mesh is all quads
//! (S4 / S8, CPS4 / CPS8). Second order adds straight mid-edge nodes (6-node triangles, 8-node quads). Elements are oriented so their
//! corner normal follows the face "normal" (the top of the wall).
//! A facesNear point resolves to the nearest mid face, or to the nearest boundary edge when that edge is as near (a point on a side
//! wall targets the shell edge there); faces get a pressure side label (1 = +normal side, 2 = below).

use crate::common::*;
use crate::elements::{curve_nodes, Nodes};
use crate::raw::{RawMesh, Refinement, Resolved};
use crate::sizes::{mesh_params, refinements_of, shape_sizes};
use crate::solid::{mesh_failed, order_of};
use llull_netgen::Shape;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};

fn sub(a: &[f64], b: &[f64]) -> Point {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross(a: &Point, b: &Point) -> Point {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    py_sum(a.iter().zip(b).map(|(x, y)| x * y))
}

/// The fragmented mid faces and each one's normal (that of the first input face it came from).
fn build_faces(faces: &[Value], scale: f64) -> MeshResult<(Shape, BTreeMap<i32, Point>)> {
    let (mut coords, mut loop_sizes, mut face_loops, mut normals) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for face in faces {
        let outer = field(face, "outer")?;
        let loops: Vec<&Value> = std::iter::once(outer).chain(list(face, "holes").iter()).collect();
        for lp in &loops {
            let points = lp.as_array().ok_or_else(|| malformed("a face loop is not an array"))?;
            for p in points {
                coords.extend(point_of(p)?.map(|c| c * scale));
            }
            loop_sizes.push(points.len() as u32);
        }
        face_loops.push(loops.len() as u32);
        normals.push(point_of(field(face, "normal")?)?);
    }
    let head: Vec<Point> = faces.iter().flat_map(|face| list(face, "outer")).take(64).map(point_of).collect::<MeshResult<_>>()?;
    let span = head.iter().flat_map(|a| head.iter().map(move |b| dist(a, b))).reduce(f64::max).unwrap_or(1.0) * scale;
    let shape = Shape::planar_faces(&coords, &loop_sizes, &face_loops, f64::max(1e-9, 1e-7 * span))
        .map_err(|error| MeshError::new("FEA_MESH_FAILED", format!("the midsurface faces could not be built: {error}")))?;
    let mut normal_of = BTreeMap::new();
    for face in 1..=shape.face_count() as i32 {
        if let Some(normal) = shape.owners(face).first().and_then(|&input| usize::try_from(input).ok()).and_then(|i| normals.get(i)) {
            normal_of.insert(face, *normal);
        }
    }
    Ok((shape, normal_of))
}

fn ranked_faces(shape: &Shape, faces: &[i32], point: &Point) -> MeshResult<Vec<(f64, i32)>> {
    Ok(rank(faces.iter().map(|&face| Ok((shape.face_distance(face, point)?.0, face))).collect::<MeshResult<_>>()?))
}

fn ranked_edges(shape: &Shape, edges: &[i32], point: &Point) -> MeshResult<Vec<(f64, i32)>> {
    Ok(rank(edges.iter().map(|&edge| Ok((shape.edge_distance(edge, point)?, edge))).collect::<MeshResult<_>>()?))
}

fn resolve(
    shape: &Shape,
    normal_of: &BTreeMap<i32, Point>,
    targets: &[&Value],
    scale: f64,
    thickness: f64,
    entity_id: &str,
) -> MeshResult<Vec<(String, Resolved)>> {
    let diag = diagonal(&shape.bounds()?);
    let tolerance = f64::max(UNRESOLVED_REL * diag, 0.75 * thickness);
    let faces: Vec<i32> = normal_of.keys().copied().collect();
    let edges: Vec<i32> = (1..=shape.edge_count() as i32).collect();
    let mut resolved: Vec<(String, Resolved)> = Vec::new();
    for target in targets {
        let key = text(target, "key")?.to_string();
        let mut item = Resolved::default();
        for point in scaled_points(target, "facesNear", scale)? {
            let ranked_f = ranked_faces(shape, &faces, &point)?;
            let ranked_e = ranked_edges(shape, &edges, &point)?;
            let nearest_face = ranked_f.first().map_or(f64::INFINITY, |r| r.0);
            let on_edge = ranked_e.first().is_some_and(|e| e.0 <= nearest_face + AMBIGUOUS_REL * diag);
            let ranked = if on_edge { &ranked_e } else { &ranked_f };
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
            } else if !item.labels.iter().any(|(face, _)| *face == tag) {
                let closest = shape.face_distance(tag, &point)?.1;
                let normal = normal_of.get(&tag).copied().unwrap_or([0.0; 3]);
                item.labels.push((tag, if dot(&sub(&point, &closest), &normal) >= 0.0 { 1 } else { 2 }));
            }
        }
        for point in scaled_points(target, "edgesNear", scale)? {
            let ranked = ranked_edges(shape, &edges, &point)?;
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
        item.faces = item.labels.iter().map(|(face, _)| *face).collect();
        item.points = scaled_points(target, "pointsNear", scale)?;
        match resolved.iter_mut().find(|(k, _)| *k == key) {
            Some(entry) => entry.1 = item,
            None => resolved.push((key, item)),
        }
    }
    Ok(resolved)
}

/// The corner rows of the surface elements per face: as meshed, or (`all_quads`) every element split into quads.
fn corner_rows(mesh: &llull_netgen::MeshData, nodes: &mut Nodes, all_quads: bool) -> MeshResult<Vec<(Vec<usize>, i32)>> {
    let mut rows = Vec::new();
    for (element, &face) in mesh.surface.chunks_exact(4).zip(&mesh.surface_faces) {
        let corners: Vec<usize> = element.iter().take_while(|&&p| p > 0).map(|&p| p as usize).collect();
        if !all_quads {
            rows.push((corners, face));
            continue;
        }
        let n = corners.len();
        let points = corners.iter().map(|&c| nodes.at(c)).collect::<MeshResult<Vec<_>>>()?;
        let centre = nodes.add([0, 1, 2].map(|k| points.iter().map(|p| p[k]).sum::<f64>() / n as f64));
        let mids = (0..n).map(|i| nodes.mid(corners[i], corners[(i + 1) % n])).collect::<MeshResult<Vec<_>>>()?;
        for i in 0..n {
            rows.push((vec![corners[i], mids[i], centre, mids[(i + n - 1) % n]], face));
        }
    }
    Ok(rows)
}

/// Mesh one 2D part.
pub fn mesh_midsurface_part(part: &Value, targets: &[&Value], controls: &Value, scale: f64) -> MeshResult<RawMesh> {
    let entity_id = text(part, "entityId")?;
    let geometry = field(part, "geometry")?;
    let prefix = if geometry.get("element").and_then(Value::as_str) == Some("shell") { "S" } else { "CPS" };
    let thickness = number(geometry, "thickness")? * scale;
    let (shape, normal_of) = build_faces(list(geometry, "faces"), scale)?;
    if normal_of.is_empty() {
        return Err(MeshError::new("FEA_MESH_FAILED", format!("the midsurface of '{entity_id}' has no face")));
    }
    let resolved = resolve(&shape, &normal_of, targets, scale, thickness, entity_id)?;
    let refinements = refinements_of(controls, &resolved, |size, item: &Resolved| Refinement {
        size,
        surfaces: item.faces.iter().copied().collect(),
        curves: item.edges.iter().copied().collect(),
        points: item.points.clone(),
    })?;
    let quads = controls.get("elementFamily").and_then(Value::as_str) == Some("shell_quad");
    let sizes = shape_sizes(&shape, &refinements, controls, scale)?;
    let mesh = shape.mesh(&mesh_params(controls, scale, true, quads)?, &sizes).map_err(|error| mesh_failed(entity_id, error))?;
    let mut nodes = Nodes::new(&mesh.points);
    let quadratic = order_of(controls)? == 2;
    let mut per_kind: BTreeMap<usize, Vec<(Vec<usize>, i32)>> = BTreeMap::new();
    for (row, face) in corner_rows(&mesh, &mut nodes, quads)? {
        let Some(normal) = normal_of.get(&face) else { continue };
        let (a, b, c) = (nodes.at(row[0])?, nodes.at(row[1])?, nodes.at(row[2])?);
        let mut row = row;
        if dot(&cross(&sub(&b, &a), &sub(&c, &a)), normal) < 0.0 {
            row[1..].reverse();
        }
        if quadratic {
            let n = row.len();
            for i in 0..n {
                let mid = nodes.mid(row[i], row[(i + 1) % n])?;
                row.push(mid);
            }
        }
        per_kind.entry(row.len()).or_default().push((row, face));
    }
    let mut blocks: Vec<(String, Vec<Vec<usize>>)> = Vec::new();
    let mut positions: HashMap<i32, Vec<usize>> = HashMap::new();
    let mut region_nodes: HashMap<i32, HashSet<usize>> = HashMap::new();
    for (width, rows) in &per_kind {
        let before: usize = blocks.iter().map(|(_, r)| r.len()).sum();
        let mut out = Vec::new();
        for (row, face) in rows {
            positions.entry(*face).or_default().push(before + out.len());
            region_nodes.entry(*face).or_default().extend(row.iter().copied());
            out.push(row.clone());
        }
        blocks.push((format!("{prefix}{width}"), out));
    }
    if blocks.is_empty() {
        return Err(MeshError::new("FEA_MESH_FAILED", format!("Netgen produced no 2D elements for '{entity_id}'")));
    }
    let target_faces = resolved
        .iter()
        .filter(|(_, item)| !item.labels.is_empty())
        .map(|(key, item)| {
            let mut faces: Vec<(usize, i32)> =
                item.labels.iter().flat_map(|(face, label)| positions.get(face).into_iter().flatten().map(move |&p| (p, *label))).collect();
            faces.sort_unstable();
            (key.clone(), faces)
        })
        .collect();
    let curve_nodes = curve_nodes(&mesh, &mut nodes, quadratic, quads)?;
    Ok(RawMesh {
        coords: nodes.coords,
        blocks,
        resolved,
        region_nodes,
        region_faces: HashMap::new(),
        curve_nodes,
        target_faces: Some(target_faces),
        defeatured: Vec::new(),
        face_map: Vec::new(),
    })
}

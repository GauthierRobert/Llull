//! Target resolution of solid parts: faces near points (trimmed distances to B-rep faces, or to STL face regions), the kernel face map
//! (TR-FEA-32: kernel face index -> mesh face by area and centroid), edges near points (B-rep edges, STEP only).

use crate::common::*;
use crate::raw::{Refinement, Resolved, ResolvedTargets};
use crate::sizes::refinements_of;
use crate::stl::StlSurface;
use llull_netgen::Shape;
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};

/// TR-FEA-32: a kernel face and a mesh face are the same face when area and centroid agree to this fraction (of the area / diagonal).
const FACE_MAP_REL: f64 = 1e-6;

/// Kernel face index -> (mesh face, centroid residual).
pub type FaceMap = HashMap<i64, (i32, f64)>;
/// Kernel face index -> every mesh face it matched.
pub type Ambiguous = HashMap<i64, Vec<i32>>;

/// The faces targets resolve against: B-rep faces of a STEP part (all, or one part's after fragmenting) or STL face regions.
pub enum Faces<'a> {
    Brep { shape: &'a Shape, faces: Vec<i32> },
    Stl(&'a StlSurface),
}

impl Faces<'_> {
    pub fn ids(&self) -> Vec<i32> {
        match self {
            Faces::Brep { faces, .. } => faces.clone(),
            Faces::Stl(stl) => (1..=stl.regions).collect(),
        }
    }

    pub fn diagonal(&self) -> MeshResult<f64> {
        Ok(diagonal(&match self {
            Faces::Brep { shape, .. } => shape.bounds()?,
            Faces::Stl(stl) => stl.bounds(),
        }))
    }

    fn distance(&self, face: i32, point: &Point) -> MeshResult<f64> {
        Ok(match self {
            Faces::Brep { shape, .. } => shape.face_distance(face, point)?.0,
            Faces::Stl(stl) => stl.region_distance(face, point),
        })
    }
}

/// Faces nearest to each point; residual = the largest point-to-face distance.
fn faces_of(faces: &Faces<'_>, points: &[Point], key: &str, entity_id: &str) -> MeshResult<(BTreeSet<i32>, f64)> {
    let diag = faces.diagonal()?;
    let ids = faces.ids();
    let (mut resolved, mut residual) = (BTreeSet::new(), 0.0f64);
    for point in points {
        let ranked = rank(ids.iter().map(|&face| Ok((faces.distance(face, point)?, face))).collect::<MeshResult<_>>()?);
        let Some(&(best, best_face)) = ranked.first() else {
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
        resolved.insert(best_face);
        residual = residual.max(best);
    }
    Ok((resolved, residual))
}

/// Kernel face index -> B-rep face by area and centroid (TR-FEA-32). A face with no candidate is left out (its targets fall back to the
/// nearest-face resolution); a face with several is left out too and listed in `Ambiguous`.
pub fn face_map(shape: &Shape, refs: &[Value], scale: f64) -> MeshResult<(FaceMap, Ambiguous)> {
    let diag = diagonal(&shape.bounds()?);
    let mut faces = Vec::new();
    for face in 1..=shape.face_count() as i32 {
        faces.push((face, shape.face_area(face)?, shape.face_centroid(face)?));
    }
    let (mut mapped, mut ambiguous) = (FaceMap::new(), Ambiguous::new());
    for reference in refs {
        let index = field(reference, "index")?.as_i64().ok_or_else(|| malformed("face index"))?;
        let area = number(reference, "area")? * scale * scale;
        let centre = point_of(field(reference, "centroid")?)?.map(|c| c * scale);
        let found: Vec<(i32, f64)> = faces
            .iter()
            .filter_map(|(face, face_area, face_centre)| {
                let distance = dist(&centre, face_centre);
                ((face_area - area).abs() <= FACE_MAP_REL * area && distance <= FACE_MAP_REL * diag).then_some((*face, distance))
            })
            .collect();
        if found.len() > 1 {
            ambiguous.insert(index, found.iter().map(|(f, _)| *f).collect());
        } else if let Some(&hit) = found.first() {
            mapped.insert(index, hit);
        }
    }
    Ok((mapped, ambiguous))
}

/// B-rep edges nearest to each point among `curves` (all edges of the shape when `None`).
pub fn edges_of(
    shape: &Shape,
    points: &[Point],
    key: &str,
    entity_id: &str,
    curves: Option<&BTreeSet<i32>>,
) -> MeshResult<(BTreeSet<i32>, f64)> {
    let diag = diagonal(&shape.bounds()?);
    let candidates: Vec<i32> = match curves {
        Some(curves) => curves.iter().copied().collect(),
        None => (1..=shape.edge_count() as i32).collect(),
    };
    let (mut resolved, mut residual) = (BTreeSet::new(), 0.0f64);
    for point in points {
        let ranked = rank(candidates.iter().map(|&edge| Ok((shape.edge_distance(edge, point)?, edge))).collect::<MeshResult<_>>()?);
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
    pub faces: Faces<'a>,
    pub curves: Option<&'a BTreeSet<i32>>,
    pub face_map: Option<&'a FaceMap>,
    pub ambiguous: Option<&'a Ambiguous>,
}

/// Targets of one entity -> resolved faces / edges / points + the refinements they define. With a face map a target whose `faceIndices`
/// are all mapped takes those faces; one naming an ambiguous face fails with AMBIGUOUS_FACE_MAP.
pub fn resolve_targets(
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
            let faces = scope.ambiguous.and_then(|a| a.get(clash)).cloned().unwrap_or_default();
            return Err(MeshError::new(
                "AMBIGUOUS_FACE_MAP",
                format!("target {key}: face {clash} of '{entity_id}' matches mesh faces {faces:?} by area and centroid"),
            ));
        }
        let faces_near = scaled_points(target, "facesNear", scale)?;
        if !faces_near.is_empty() {
            // always run the point resolution: it still reports UNRESOLVED / AMBIGUOUS and gives the residual
            (item.faces, item.residual) = faces_of(&scope.faces, &faces_near, &key, entity_id)?;
        }
        if let Some(map) = scope.face_map.filter(|map| !indices.is_empty() && indices.iter().all(|i| map.contains_key(i))) {
            item.faces = indices.iter().filter_map(|i| map.get(i).map(|hit| hit.0)).collect();
        }
        let edges_near = scaled_points(target, "edgesNear", scale)?;
        if !edges_near.is_empty() {
            let Faces::Brep { shape, .. } = &scope.faces else {
                return Err(MeshError::new(
                    "FEA_TARGET_UNRESOLVED",
                    format!("target {key}: edgesNear needs exact STEP geometry (use the OCC kernel)"),
                ));
            };
            let (edges, edge_residual) = edges_of(shape, &edges_near, &key, entity_id, scope.curves)?;
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
        surfaces: item.faces.iter().copied().collect(),
        curves: Vec::new(),
        points: item.points.clone(),
    })?;
    Ok((resolved, refinements))
}

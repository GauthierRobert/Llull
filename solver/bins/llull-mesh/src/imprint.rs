//! Plane targets (`intersectPlane`): the plane is imprinted on the part before meshing (OCCT splitter, `Shape::imprinted`), so the mesh
//! conforms to the section curve, then the target resolves to the nodes on the section edges of the selected faces. A target's faces are
//! resolved on the part as read (`resolve_targets`) and carried over to the split faces by origin; the cut solids share their cut face.

use crate::common::*;
use crate::raw::{Resolved, ResolvedTargets};
use llull_netgen::Shape;
use serde_json::Value;
use std::collections::BTreeSet;

/// An edge lies on the plane (or on the original edge) when its sample points are within this fraction of the part diagonal.
const ON_REL: f64 = 1e-5;
/// Sample points per edge are at most this fraction of the part diagonal apart.
const SAMPLE_REL: f64 = 1.0 / 50.0;

/// Two planes are one when their unit normals agree (either sign) and the point of one is this close to the other (analysis unit, relative to 1).
const SAME_PLANE: f64 = 1e-9;

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Plane {
    pub point: Point,
    /// Unit length.
    pub normal: Point,
}

impl Plane {
    /// The same plane written differently (rounding, a flipped or scaled normal): imprinted once.
    pub fn same(&self, other: &Plane) -> bool {
        let dot: f64 = (0..3).map(|k| self.normal[k] * other.normal[k]).sum();
        let scale = 1.0 + other.point.iter().map(|c| c.abs()).fold(0.0, f64::max);
        (dot.abs() - 1.0).abs() <= SAME_PLANE && self.distance(&other.point) <= SAME_PLANE * scale
    }

    fn distance(&self, p: &Point) -> f64 {
        let length = self.normal.iter().map(|c| c * c).sum::<f64>().sqrt();
        (0..3).map(|k| (p[k] - self.point[k]) * self.normal[k]).sum::<f64>().abs() / length
    }
}

/// The `intersectPlane` of a target (point scaled to the analysis unit), `None` when it has none.
pub fn plane_of(target: &Value, scale: f64) -> MeshResult<Option<Plane>> {
    let Some(plane) = target.get("intersectPlane").filter(|v| !v.is_null()) else { return Ok(None) };
    let point = point_of(field(plane, "point")?)?.map(|c| c * scale);
    let normal = point_of(field(plane, "normal")?)?;
    if !normal.iter().chain(&point).all(|c| c.is_finite()) || normal.iter().all(|c| *c == 0.0) {
        return Err(malformed("'intersectPlane' needs a finite point and a non-zero normal"));
    }
    let length = normal.iter().map(|c| c * c).sum::<f64>().sqrt();
    Ok(Some(Plane { point, normal: normal.map(|c| c / length) }))
}

/// A plane target is only resolved on an STEP part meshed alone: other geometry / conformal bonding refuses it, never ignoring it.
pub fn refuse_unsupported(parts: &[Value], targets: &[Value], controls: &Value) -> MeshResult<()> {
    let conformal = controls.get("bonding").and_then(Value::as_str) == Some("conformal");
    for target in targets.iter().filter(|t| t.get("intersectPlane").is_some_and(|v| !v.is_null())) {
        let key = text(target, "key")?;
        let entity = target.get("entityId").and_then(Value::as_str).unwrap_or("");
        let kind = parts
            .iter()
            .find(|part| part.get("entityId").and_then(Value::as_str) == Some(entity))
            .and_then(|part| part.get("geometry")?.get("kind")?.as_str())
            .unwrap_or("");
        if conformal || kind != "step" {
            let why = if conformal { "conformal bonding".to_string() } else { format!("'{kind}' geometry") };
            return Err(MeshError::new(
                "FEA_TARGET_PLANE_UNSUPPORTED",
                format!(
                    "target {key}: intersectPlane needs an exact STEP part meshed on its own, not {why}; target by facesNear / edgesNear / pointsNear"
                ),
            ));
        }
    }
    Ok(())
}

/// The part split by every distinct plane, with the original faces behind each split face.
pub struct Imprinted {
    pub shape: Shape,
    origins: Vec<BTreeSet<i32>>,
}

impl Imprinted {
    /// Faces of the split shape lying on any of the original `faces`.
    fn faces_from(&self, faces: &BTreeSet<i32>) -> BTreeSet<i32> {
        (1..=self.origins.len() as i32).filter(|&f| self.origins[f as usize - 1].iter().any(|o| faces.contains(o))).collect()
    }

    /// Edges of the split shape lying on any of the original `edges` of `original`.
    fn edges_from(&self, original: &Shape, edges: &BTreeSet<i32>, diagonal: f64) -> MeshResult<BTreeSet<i32>> {
        let mut out = BTreeSet::new();
        if edges.is_empty() {
            return Ok(out);
        }
        // one distance to each original edge decides most split edges; the rest of the samples are checked only for the edges that pass
        for edge in 1..=self.shape.edge_count() as i32 {
            let samples = self.shape.sample_edge(edge, SAMPLE_REL * diagonal)?;
            for &own in edges {
                let mut near = !samples.is_empty();
                for p in &samples {
                    if original.edge_distance(own, p)? > ON_REL * diagonal {
                        near = false;
                        break;
                    }
                }
                if near {
                    out.insert(edge);
                    break;
                }
            }
        }
        Ok(out)
    }

    /// Edges of the faces `faces` (split numbering) that lie on `plane`.
    fn section_edges(&self, faces: &BTreeSet<i32>, plane: &Plane, diagonal: f64) -> MeshResult<BTreeSet<i32>> {
        let mut out = BTreeSet::new();
        for &face in faces {
            for edge in self.shape.face_edges(face)? {
                let samples = self.shape.sample_edge(edge, SAMPLE_REL * diagonal)?;
                if !samples.is_empty() && samples.iter().all(|p| plane.distance(p) <= ON_REL * diagonal) {
                    out.insert(edge);
                }
            }
        }
        Ok(out)
    }
}

/// `shape` split by each of `planes` in turn.
pub fn imprint(shape: &Shape, planes: &[Plane], entity_id: &str) -> MeshResult<Imprinted> {
    let mut origins: Vec<BTreeSet<i32>> = (1..=shape.face_count() as i32).map(|f| BTreeSet::from([f])).collect();
    let mut current: Option<Shape> = None;
    for plane in planes {
        let split =
            current.as_ref().unwrap_or(shape).imprinted(&plane.point, &plane.normal).map_err(|error| {
                MeshError::new("FEA_MESH_FAILED", format!("the plane could not be imprinted on '{entity_id}': {error}"))
            })?;
        let next = split.ok_or_else(|| {
            MeshError::new(
                "FEA_TARGET_UNRESOLVED",
                format!(
                    "intersectPlane through {} with normal {} does not cut '{entity_id}' (it misses it, is tangent to it, or lies in one of its faces)",
                    py_point(&plane.point),
                    py_point(&plane.normal)
                ),
            )
        })?;
        origins = (1..=next.face_count() as i32)
            .map(|f| next.owners(f).iter().filter_map(|&o| origins.get(o as usize - 1)).flatten().copied().collect())
            .collect();
        current = Some(next);
    }
    let shape = current.ok_or_else(|| malformed("no plane to imprint"))?;
    Ok(Imprinted { shape, origins })
}

/// Carries every resolved target over to the split shape; a plane target (`plane_of_key`) becomes the section edges of its faces, with no
/// faces of its own.
pub fn carry_over(
    imprinted: &Imprinted,
    original: &Shape,
    resolved: &mut ResolvedTargets,
    plane_of_key: &[(String, Plane)],
    entity_id: &str,
) -> MeshResult<()> {
    let diag = diagonal(&original.bounds()?);
    for (key, item) in resolved.iter_mut() {
        let faces = imprinted.faces_from(&item.faces);
        match plane_of_key.iter().find(|(k, _)| k == key) {
            Some((_, plane)) => apply_plane(imprinted, item, &faces, plane, diag, key, entity_id)?,
            None => {
                item.edges = imprinted.edges_from(original, &item.edges, diag)?;
                item.faces = faces;
            }
        }
    }
    Ok(())
}

fn apply_plane(
    imprinted: &Imprinted,
    item: &mut Resolved,
    faces: &BTreeSet<i32>,
    plane: &Plane,
    diag: f64,
    key: &str,
    entity_id: &str,
) -> MeshResult<()> {
    if faces.is_empty() {
        return Err(MeshError::new(
            "FEA_TARGET_UNRESOLVED",
            format!("target {key}: intersectPlane needs facesNear (the faces to cut) on '{entity_id}'"),
        ));
    }
    let edges = imprinted.section_edges(faces, plane, diag)?;
    if edges.is_empty() {
        return Err(MeshError::new(
            "FEA_TARGET_UNRESOLVED",
            format!("target {key}: the plane meets no edge of the selected faces of '{entity_id}' (it misses them, or only touches them)"),
        ));
    }
    item.faces = BTreeSet::new();
    item.edges = edges;
    item.section = true;
    Ok(())
}

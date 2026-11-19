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

/// The prefilter boxes are grown by this multiple of the on-tolerance, so a rounding in a distance never drops a match.
const PREFILTER_SLACK: f64 = 2.0;

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

    /// Edges of the split shape lying on any of the original `edges` of `original`. A bounding box prefilter (an edge's box, grown by the
    /// tolerance, must meet the split edge's box, then hold all its samples) skips the exact distances of the pairs that cannot match:
    /// both tests are necessary conditions of the distance test, so the edges found are those of the unfiltered pass.
    fn edges_from(&self, original: &Shape, edges: &BTreeSet<i32>, diagonal: f64) -> MeshResult<BTreeSet<i32>> {
        let mut out = BTreeSet::new();
        if edges.is_empty() {
            return Ok(out);
        }
        let slack = PREFILTER_SLACK * ON_REL * diagonal;
        let mut own = Vec::with_capacity(edges.len());
        for &edge in edges {
            own.push((edge, original.edge_bounds(edge)?.map(|b| grown(&b, slack))));
        }
        for edge in 1..=self.shape.edge_count() as i32 {
            let bounds = self.shape.edge_bounds(edge)?;
            let candidates: Vec<&(i32, Option<[f64; 6]>)> =
                own.iter().filter(|(_, b)| !matches!((&bounds, b), (Some(s), Some(o)) if !overlaps(s, o))).collect();
            if candidates.is_empty() {
                continue;
            }
            let samples = self.shape.sample_edge(edge, SAMPLE_REL * diagonal)?;
            if samples.is_empty() {
                continue;
            }
            for (own_edge, own_box) in candidates {
                if own_box.is_some_and(|b| !samples.iter().all(|p| holds(&b, p))) {
                    continue;
                }
                let mut near = true;
                for p in &samples {
                    if original.edge_distance(*own_edge, p)? > ON_REL * diagonal {
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

/// `b` = [min xyz, max xyz] grown by `margin` on every side.
fn grown(b: &[f64; 6], margin: f64) -> [f64; 6] {
    [b[0] - margin, b[1] - margin, b[2] - margin, b[3] + margin, b[4] + margin, b[5] + margin]
}

fn overlaps(a: &[f64; 6], b: &[f64; 6]) -> bool {
    (0..3).all(|k| a[k] <= b[k + 3] && b[k] <= a[k + 3])
}

fn holds(b: &[f64; 6], p: &Point) -> bool {
    (0..3).all(|k| b[k] <= p[k] && p[k] <= b[k + 3])
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    /// A closed shell: the plate [0, 60]^2 x [0, 2] with `k` x `k` square through holes of side 4 (12 edges per hole, 12 for the plate).
    fn perforated_plate(k: usize) -> Shape {
        let (side, half, pitch) = (60.0, 2.0, 60.0 / k as f64);
        let mut coords: Vec<f64> = Vec::new();
        let (mut loop_sizes, mut face_loops) = (Vec::new(), Vec::new());
        let square = |x0: f64, y0: f64, x1: f64, y1: f64, z: f64| [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]];
        let holes: Vec<[f64; 4]> = (0..k * k)
            .map(|h| {
                let (cx, cy) = (pitch * ((h % k) as f64 + 0.5), pitch * ((h / k) as f64 + 0.5));
                [cx - half, cy - half, cx + half, cy + half]
            })
            .collect();
        for z in [0.0, 2.0] {
            coords.extend(square(0.0, 0.0, side, side, z).iter().flatten());
            loop_sizes.push(4);
            for [x0, y0, x1, y1] in &holes {
                coords.extend(square(*x0, *y0, *x1, *y1, z).iter().flatten());
                loop_sizes.push(4);
            }
            face_loops.push(1 + holes.len() as u32);
        }
        let walls = std::iter::once([0.0, 0.0, side, side]).chain(holes.iter().copied());
        for [x0, y0, x1, y1] in walls {
            let ring = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
            for i in 0..4 {
                let ([ax, ay], [bx, by]) = (ring[i], ring[(i + 1) % 4]);
                coords.extend([ax, ay, 0.0, bx, by, 0.0, bx, by, 2.0, ax, ay, 2.0]);
                loop_sizes.push(4);
                face_loops.push(1);
            }
        }
        Shape::planar_faces(&coords, &loop_sizes, &face_loops, 1e-7).unwrap()
    }

    /// `edges_from` before the prefilter (the reference the filtered pass must reproduce).
    fn edges_from_unfiltered(split: &Imprinted, original: &Shape, edges: &BTreeSet<i32>, diagonal: f64) -> BTreeSet<i32> {
        let mut out = BTreeSet::new();
        for edge in 1..=split.shape.edge_count() as i32 {
            let samples = split.shape.sample_edge(edge, SAMPLE_REL * diagonal).unwrap();
            for &own in edges {
                let near = !samples.is_empty() && samples.iter().all(|p| original.edge_distance(own, p).unwrap() <= ON_REL * diagonal);
                if near {
                    out.insert(edge);
                    break;
                }
            }
        }
        out
    }

    #[test]
    fn the_bounding_box_prefilter_finds_the_edges_of_the_unfiltered_pass() {
        let plate = perforated_plate(7);
        assert_eq!(plate.edge_count(), 600, "49 holes x 12 edges + 12");
        let diag = diagonal(&plate.bounds().unwrap());
        // x = 31 crosses the middle column of holes (x 28..32) and the plate
        let plane = Plane { point: [31.0, 0.0, 0.0], normal: [1.0, 0.0, 0.0] };
        let split = imprint(&plate, &[plane], "plate").unwrap();
        assert!(split.shape.edge_count() > plate.edge_count());
        let every: BTreeSet<i32> = (1..=plate.edge_count() as i32).collect();
        let some: BTreeSet<i32> = [1, 77, 300, 599].into_iter().collect();
        for (name, edges) in [("every edge", &every), ("four edges", &some)] {
            let start = Instant::now();
            let reference = edges_from_unfiltered(&split, &plate, edges, diag);
            let unfiltered = start.elapsed();
            let start = Instant::now();
            let filtered = split.edges_from(&plate, edges, diag).unwrap();
            let elapsed = start.elapsed();
            assert_eq!(filtered, reference, "{name}");
            assert!(!filtered.is_empty() && filtered.len() < split.shape.edge_count(), "the section edges lie on no original edge");
            eprintln!(
                "edges_from, {name} of {} original / {} split edges: unfiltered {unfiltered:?}, prefiltered {elapsed:?}",
                plate.edge_count(),
                split.shape.edge_count()
            );
        }
    }

    #[test]
    fn the_prefilter_keeps_the_curved_edges_of_a_hole() {
        let path = format!("{}/../../crates/llull-netgen/tests/fixtures/plate_hole.step", env!("CARGO_MANIFEST_DIR"));
        let plate = Shape::read_step(&path, 1.0).unwrap();
        let diag = diagonal(&plate.bounds().unwrap());
        let split = imprint(&plate, &[Plane { point: [10.0, 0.0, 0.0], normal: [1.0, 0.0, 0.0] }], "plate").unwrap();
        let every: BTreeSet<i32> = (1..=plate.edge_count() as i32).collect();
        let filtered = split.edges_from(&plate, &every, diag).unwrap();
        assert_eq!(filtered, edges_from_unfiltered(&split, &plate, &every, diag));
        assert!(!filtered.is_empty());
    }

    #[test]
    fn box_helpers_grow_overlap_and_hold() {
        assert!(
            overlaps(&[0.0, 0.0, 0.0, 1.0, 1.0, 1.0], &[1.0, 1.0, 1.0, 2.0, 2.0, 2.0])
                && !overlaps(&[0.0; 6], &[1.0, 0.0, 0.0, 2.0, 1.0, 1.0])
        );
        assert!(holds(&grown(&[0.0; 6], 0.5), &[0.5, -0.5, 0.0]) && !holds(&[0.0; 6], &[0.0, 0.0, 1e-9]));
    }
}

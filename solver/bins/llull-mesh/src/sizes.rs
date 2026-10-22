//! Mesh size: Netgen's global maxh from controls.globalSize, locally reduced near the refinement faces / edges / points.
//!
//! A refined face or edge caps the size of the elements on it (Netgen shape maxh) and seeds Netgen's local-size octree with points
//! over it, from which the volume grades back to the global size (`GRADING`); a refined point does the same over a ball of radius
//! 1.5 x the global size (the reach of the reference mesher's Ball field).

use crate::common::{list, number, text, MeshResult, Point};
use crate::raw::Refinement;
use llull_netgen::{MeshParams, Shape, Sizes};
use serde_json::Value;

/// Netgen's maxh for a volume mesh, in global sizes: Netgen fills a volume with fewer tetrahedra than the reference mesher at
/// the same nominal size; 0.9 puts the element counts of the server FE suites' meshes of 3000+ elements within 25 % of the reference
/// (docs/decisions/NG1-netgen-mesher.md). Surface (shell) meshes already match at 1.
const VOLUME_SIZE_FACTOR: f64 = 0.9;
/// Size growth per element away from a refined region (Netgen's default "moderate" grading).
pub const GRADING: f64 = 0.3;
/// Elements per radius of curvature (Netgen curvaturesafety); low, so curved faces barely refine a coarse mesh, close to the
/// reference mesher, which ignored curvature.
const CURVATURE_SAFETY: f64 = 1.0;
/// Radius of a refined point's ball, in global sizes.
const BALL_RADIUS: f64 = 1.5;
/// A ball is seeded on a lattice of its size, coarsened only past this many points.
const MAX_BALL_POINTS: f64 = 30000.0;

/// Netgen parameters of `controls` (lengths scaled to the analysis unit).
pub fn mesh_params(controls: &Value, scale: f64, surface_only: bool, quad_dominated: bool) -> MeshResult<MeshParams> {
    Ok(MeshParams {
        max_h: number(controls, "globalSize")? * scale * if surface_only { 1.0 } else { VOLUME_SIZE_FACTOR },
        min_h: controls.get("minSize").and_then(Value::as_f64).map_or(0.0, |size| size * scale),
        grading: GRADING,
        curvature_safety: CURVATURE_SAFETY,
        segments_per_edge: 1.0,
        optimize_steps_3d: 3,
        optimize_steps_2d: 3,
        quad_dominated,
        surface_only,
        stl_edge_angle: crate::common::CLASSIFY_ANGLE_DEG,
    })
}

/// The refinements of `controls` whose key is a resolved target, built by `make` from that target's resolution.
pub fn refinements_of<R>(controls: &Value, resolved: &[(String, R)], make: impl Fn(f64, &R) -> Refinement) -> MeshResult<Vec<Refinement>> {
    let mut out = Vec::new();
    for refinement in list(controls, "refinements") {
        let key = text(refinement, "key")?;
        if let Some((_, item)) = resolved.iter().find(|(k, _)| k == key) {
            out.push(make(number(refinement, "size")?, item));
        }
    }
    Ok(out)
}

pub fn push_points(sizes: &mut Sizes, points: &[Point], size: f64) {
    for p in points {
        sizes.points.extend([p[0], p[1], p[2], size]);
    }
}

/// Lattice points inside the ball of `radius` around `centre`, spaced `size` (coarser past MAX_BALL_POINTS; the centre always).
fn ball(centre: &Point, radius: f64, size: f64) -> Vec<Point> {
    let step = size.max(radius * (4.0 * std::f64::consts::PI / 3.0 / MAX_BALL_POINTS).cbrt());
    let n = (radius / step).floor() as i64;
    let mut out = vec![*centre];
    for i in -n..=n {
        for j in -n..=n {
            for k in -n..=n {
                let offset = [i, j, k].map(|v| v as f64 * step);
                if (i, j, k) != (0, 0, 0) && offset.iter().map(|o| o * o).sum::<f64>() <= radius * radius {
                    out.push([centre[0] + offset[0], centre[1] + offset[1], centre[2] + offset[2]]);
                }
            }
        }
    }
    out
}

/// Size points of every refined point of `refinements` (sizes in the analysis unit).
pub fn point_sizes(sizes: &mut Sizes, refinements: &[Refinement], global_size: f64, scale: f64) {
    for item in refinements {
        let size = item.size * scale;
        for centre in &item.points {
            push_points(sizes, &ball(centre, BALL_RADIUS * global_size, size), size);
        }
    }
}

/// Local sizes of `refinements` on a B-rep shape: faces and edges by number, points as balls.
pub fn shape_sizes(shape: &Shape, refinements: &[Refinement], controls: &Value, scale: f64) -> MeshResult<Sizes> {
    let mut sizes = Sizes::default();
    for item in refinements {
        let size = item.size * scale;
        for &face in &item.surfaces {
            sizes.face_ids.push(face);
            sizes.face_sizes.push(size);
            push_points(&mut sizes, &shape.sample_face(face, size)?, size);
        }
        for &edge in &item.curves {
            sizes.edge_ids.push(edge);
            sizes.edge_sizes.push(size);
            push_points(&mut sizes, &shape.sample_edge(edge, size)?, size);
        }
    }
    point_sizes(&mut sizes, refinements, number(controls, "globalSize")? * scale, scale);
    Ok(sizes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn controls_scale_to_the_analysis_unit() {
        let params = mesh_params(&json!({ "globalSize": 4.0, "minSize": 0.5 }), 0.001, true, false).unwrap();
        assert_eq!((params.max_h, params.min_h), (0.004, 0.0005));
        let volume = mesh_params(&json!({ "globalSize": 4.0 }), 0.001, false, false).unwrap();
        assert_eq!((volume.max_h, volume.min_h), (0.004 * VOLUME_SIZE_FACTOR, 0.0));
        assert!(mesh_params(&json!({}), 1.0, false, false).is_err());
    }

    #[test]
    fn a_ball_is_a_bounded_lattice_around_its_centre() {
        let points = ball(&[1.0, 2.0, 3.0], 6.0, 0.01);
        assert_eq!(points[0], [1.0, 2.0, 3.0]);
        assert!(points.len() as f64 <= 1.1 * MAX_BALL_POINTS, "{}", points.len());
        assert_eq!(ball(&[0.0; 3], 1.0, 0.5).len(), 33, "spaced by the size when that stays small");
        assert!(points.iter().all(|p| (p[0] - 1.0).powi(2) + (p[1] - 2.0).powi(2) + (p[2] - 3.0).powi(2) <= 36.0 + 1e-9));
        assert_eq!(ball(&[0.0; 3], 1.0, 5.0).len(), 1);
    }

    #[test]
    fn refinements_follow_the_resolved_targets() {
        let controls = json!({ "refinements": [{ "key": "A", "size": 2.0 }, { "key": "missing", "size": 1.0 }] });
        let resolved = vec![("A".to_string(), 7)];
        let out =
            refinements_of(&controls, &resolved, |size, face| Refinement { size, surfaces: vec![*face], curves: vec![], points: vec![] })
                .unwrap();
        assert_eq!((out.len(), out[0].size, out[0].surfaces.clone()), (1, 2.0, vec![7]));
        let mut sizes = Sizes::default();
        point_sizes(&mut sizes, &[Refinement { size: 1.0, surfaces: vec![], curves: vec![], points: vec![[0.0; 3]] }], 0.1, 1.0);
        assert_eq!(sizes.points, vec![0.0, 0.0, 0.0, 1.0]);
    }
}

//! CHK1 (06 BLD TECHNICAL_SPEC 13.22.6): the speed of the exact queries on blend faces with many stations. The box by Bezier patch against `BRepBndLib::AddOptimal` and a dense
//! sample, the queries kept on the shape, and the sparse seed of the station set (a smaller first set must still follow a kink and a narrow feature of the radius law).

use crate::features::{fillet_laws, fillet_profile_blend};
use crate::queries::{face_bspline, topology};
use crate::{analyze, make_box, mass_properties, Shape};
use serde_json::Value;

const NAN: f64 = f64::NAN;

fn num(value: &Value) -> f64 {
    value.as_f64().unwrap()
}

/// The top edge (y = 10, z = 10) of the 20 x 10 x 10 block.
fn block_and_edge() -> (Shape, Vec<u32>) {
    let block = make_box([0.0; 3], [20.0, 10.0, 10.0]).unwrap().unwrap();
    let topo = topology(&block).unwrap();
    let edge: Vec<u32> = topo["edges"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .filter(|(_, e)| (num(&e["mid"][1]) - 10.0).abs() < 1e-9 && (num(&e["mid"][2]) - 10.0).abs() < 1e-9)
        .map(|(index, _)| index as u32)
        .collect();
    assert_eq!(edge.len(), 1);
    (block, edge)
}

fn profile(block: &Shape, edge: &[u32], laws: &[f64], kind: f64, param: f64) -> Shape {
    // no prism specs: the rail builder (the skin by stations) builds it, constant sizes included
    let specs: Vec<f64> = Vec::new();
    fillet_profile_blend(block, &specs, edge, laws, kind, param).unwrap().expect("the profile blend is built")
}

fn volume(shape: &Shape) -> f64 {
    mass_properties(shape).unwrap().volume
}

/// The knot spans of the B-spline blend face along the edge (the first parameter direction of the skin).
fn blend_spans(shape: &Shape) -> usize {
    let topo = topology(shape).unwrap();
    let face = topo["faces"].as_array().unwrap().iter().position(|f| f["surface"] == "bspline").expect("a B-spline blend face");
    let surface = face_bspline(shape, face as f64).unwrap();
    let u = surface["knotsU"].as_array().unwrap().len().saturating_sub(1);
    let v = surface["knotsV"].as_array().unwrap().len().saturating_sub(1);
    u.max(v)
}

#[test]
fn the_box_by_bezier_patch_is_the_exact_box_of_many_patch_faces_with_extremes_inside_the_patches() {
    for kind in 0..3 {
        let probe = crate::test_bridge::spline_bounds(kind);
        assert_eq!(probe.len(), 18);
        let (fast, optimal, sampled) = (&probe[0..6], &probe[6..12], &probe[12..18]);
        let diagonal = (0..3).map(|a| (optimal[3 + a] - optimal[a]).powi(2)).sum::<f64>().sqrt();
        for k in 0..6 {
            // a dense sample is a lower bound of the exact box, and the fast box is the exact box to 1e-9 of the diagonal
            let outward = if k < 3 { sampled[k] - fast[k] } else { fast[k] - sampled[k] };
            assert!(outward > -1e-9 * diagonal, "kind {kind} side {k}: the fast box {} is inside the sampled one {}", fast[k], sampled[k]);
            assert!((fast[k] - optimal[k]).abs() < 2e-7, "kind {kind} side {k}: fast {} vs AddOptimal {}", fast[k], optimal[k]);
        }
    }
}

#[test]
fn a_face_that_is_not_a_full_patch_keeps_add_optimal() {
    let probe = crate::test_bridge::spline_bounds(3);
    assert!(probe[0..6].iter().all(|value| *value == 0.0), "the fast path refuses a trimmed face: {probe:?}");
    assert!(probe[6..12].iter().any(|value| *value != 0.0));
}

#[test]
fn a_profile_blend_has_the_box_of_its_block_and_few_stations() {
    let _serial = crate::serial_blends();
    let (block, edge) = block_and_edge();
    for (kind, param) in [(0.0, 0.5), (1.0, 0.5)] {
        let shape = profile(&block, &edge, &[1.0, NAN, 0.0, 0.0], kind, param);
        let bounds = mass_properties(&shape).unwrap().bounds;
        for (side, expected) in [0.0, 0.0, 0.0, 20.0, 10.0, 10.0].iter().enumerate() {
            assert!((bounds[side] - expected).abs() < 1e-6, "kind {kind} side {side}: {} vs {expected}", bounds[side]);
        }
        // a constant size on a straight edge has constant sections: the skin keeps the sparse seed (the old uniform first set was 24 stations = 72 spans)
        assert!(blend_spans(&shape) <= 12, "kind {kind}: {} spans", blend_spans(&shape));
    }
}

/// Removed volume of a conic (rho 0.5) blend at a right angle: r^2 / 6 per unit length, integrated along the edge of length 20 for a radius law given by
/// straight pieces through `points` ((t, size), t from 0 to 1).
fn conic_removed(points: &[(f64, f64)]) -> f64 {
    points
        .windows(2)
        .map(|w| {
            let (length, a, b) = (20.0 * (w[1].0 - w[0].0), w[0].1, w[1].1);
            length * (a * a + a * b + b * b) / 3.0 / 6.0
        })
        .sum()
}

#[test]
fn a_kink_and_a_narrow_feature_of_a_straight_radius_law_are_followed_by_the_sparse_seed() {
    let _serial = crate::serial_blends();
    let (block, edge) = block_and_edge();
    let whole = volume(&block);
    // (name, laws: start, end, straight pieces, count, then (t, size) per control point; the same as the points of the closed form)
    let cases: [(&str, Vec<f64>, Vec<(f64, f64)>); 3] = [
        // a kink at t = 0.3137: not on the grid of 48 probes
        ("kink", vec![1.0, 1.0, 1.0, 1.0, 0.3137, 2.0], vec![(0.0, 1.0), (0.3137, 2.0), (1.0, 1.0)]),
        // a spike 0.2 mm wide (0.01 of the edge) centred on the probe 23 / 48, which neither the midpoints of the seed intervals nor a coarse set reach
        (
            "narrow spike",
            vec![1.0, 1.0, 1.0, 3.0, 0.4742, 1.0, 0.4792, 1.6, 0.4842, 1.0],
            vec![(0.0, 1.0), (0.4742, 1.0), (0.4792, 1.6), (0.4842, 1.0), (1.0, 1.0)],
        ),
        // the size changes only over the last 5 % of the edge
        ("late ramp", vec![1.0, 2.0, 1.0, 1.0, 0.95, 1.0], vec![(0.0, 1.0), (0.95, 1.0), (1.0, 2.0)]),
    ];
    for (name, laws, points) in cases {
        let shape = profile(&block, &edge, &laws, 0.0, 0.5);
        let removed = whole - volume(&shape);
        let expected = conic_removed(&points);
        assert!((removed - expected).abs() < 1e-4 * expected, "{name}: removed {removed} vs {expected}");
        // the same laws as a circular fillet remove the circular share of the same section areas: the profile follows the very contact lines of that blend
        let circular = fillet_laws(&block, &edge, &laws).unwrap().unwrap();
        let ratio = (1.0 / 6.0) / (1.0 - std::f64::consts::FRAC_PI_4);
        let removed_circular = whole - volume(&circular);
        assert!(
            (removed - ratio * removed_circular).abs() < 2e-4 * removed,
            "{name}: {removed} vs {} of the circular blend",
            ratio * removed_circular
        );
    }
}

#[test]
fn the_whole_shape_queries_are_kept_on_the_shape_and_answer_the_same() {
    let _serial = crate::serial_blends();
    let (block, edge) = block_and_edge();
    let shape = profile(&block, &edge, &[1.0, NAN, 0.0, 0.0], 0.0, 0.5);
    let (first, second) = (topology(&shape).unwrap(), topology(&shape).unwrap());
    assert_eq!(first, second);
    let (first, second) = (crate::queries::face_graph(&shape).unwrap(), crate::queries::face_graph(&shape).unwrap());
    assert_eq!(first, second);
    let (first, second) = (mass_properties(&shape).unwrap(), mass_properties(&shape).unwrap());
    assert_eq!((first.volume, first.area, first.bounds), (second.volume, second.area, second.bounds));
    let (first, second) = (analyze(&shape).unwrap(), analyze(&shape).unwrap());
    assert_eq!((first.valid, first.area, &first.lumps), (second.valid, second.area, &second.lumps));
    // the area of the analysis of a lone solid is the area of its lump
    assert_eq!(first.solids, 1);
    assert_eq!(first.area, first.lumps[1]);
    // another shape has its own answers
    assert_ne!(topology(&block).unwrap(), topology(&shape).unwrap());
}

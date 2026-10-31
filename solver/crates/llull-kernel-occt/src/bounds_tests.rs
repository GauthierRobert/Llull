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

/// What the box by Bezier patch guarantees: it ENCLOSES the exact box (so it encloses every sampled surface point) and overshoots it by at most 2 x 1e-9 of the diagonal (RELATIVE, outward only).
/// `AddOptimal` is no reference to that precision: it widens its box by about 8e-8 (the face tolerance), so it is compared to 1.1e-7 absolute only; the 1e-9 relative claim is proved on the flat
/// surface with one raised pole, whose exact extremes are known (z from 0 to 4/3): the box lies outside them by the padding (1e-9 of the diagonal) and by no more than twice that.
#[test]
fn the_box_by_bezier_patch_encloses_the_exact_box_of_many_patch_faces_to_a_relative_1e_9() {
    for kind in [0, 1, 2, 4] {
        let probe = crate::test_bridge::spline_bounds(kind);
        assert_eq!(probe.len(), 18);
        let (fast, optimal, sampled) = (&probe[0..6], &probe[6..12], &probe[12..18]);
        let diagonal = (0..3).map(|a| (optimal[3 + a] - optimal[a]).powi(2)).sum::<f64>().sqrt();
        for k in 0..6 {
            // a dense sample is a lower bound of the exact box: the fast box encloses it, with no slack to give
            let outward = if k < 3 { sampled[k] - fast[k] } else { fast[k] - sampled[k] };
            assert!(outward >= 0.0, "kind {kind} side {k}: the fast box {} does not enclose the sampled one {}", fast[k], sampled[k]);
            assert!((fast[k] - optimal[k]).abs() < 1.1e-7, "kind {kind} side {k}: fast {} vs AddOptimal {}", fast[k], optimal[k]);
        }
        if kind == 2 {
            for (side, exact) in [(2, 0.0), (5, 4.0 / 3.0)] {
                let outward = if side < 3 { exact - fast[side] } else { fast[side] - exact };
                assert!(
                    outward >= 0.9e-9 * diagonal && outward <= 2.0 * 1e-9 * diagonal,
                    "side {side}: {} is {outward} outside the exact {exact}",
                    fast[side]
                );
            }
        }
    }
}

#[test]
fn a_patch_that_reaches_the_depth_limit_outside_the_found_box_refuses_instead_of_accepting() {
    let probe = crate::test_bridge::spline_bounds(5);
    assert!(probe[0..6].iter().all(|value| *value == 0.0), "the search that does not finish leaves the box to AddOptimal: {probe:?}");
    assert!(probe[6..12].iter().any(|value| *value != 0.0));
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
fn a_kink_and_a_narrow_feature_of_a_straight_radius_law_are_followed_whatever_the_first_stations() {
    let _serial = crate::serial_blends();
    let (block, edge) = block_and_edge();
    let whole = volume(&block);
    // (name, laws: start, end, straight pieces, count, then (t, size) per control point; the same as the points of the closed form)
    let cases: [(&str, Vec<f64>, Vec<(f64, f64)>); 3] = [
        // a kink at t = 0.3137: not on the grid of 48 probes
        ("kink", vec![1.0, 1.0, 1.0, 1.0, 0.3137, 2.0], vec![(0.0, 1.0), (0.3137, 2.0), (1.0, 1.0)]),
        // a spike 0.2 mm wide (0.01 of the edge) centred ON the probe 23 / 48 (t = 0.4792), which no station of the uniform set (j / 24) is on: only the probe grid sees it (between probes it is missed, see the test below)
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

fn facade_queries() -> Vec<&'static str> {
    crate::FACADE_QUERIES.with(|log| std::mem::take(&mut *log.borrow_mut()))
}

#[test]
fn a_second_whole_shape_query_is_answered_from_the_shape_without_reaching_the_facade() {
    let _serial = crate::serial_blends();
    let (block, edge) = block_and_edge();
    let shape = profile(&block, &edge, &[1.0, NAN, 0.0, 0.0], 0.0, 0.5);
    facade_queries();
    topology(&shape).unwrap();
    crate::queries::face_graph(&shape).unwrap();
    mass_properties(&shape).unwrap();
    analyze(&shape).unwrap();
    assert_eq!(facade_queries(), ["topology", "faceGraph", "massProperties", "analyze"], "the first asks compute");
    for _ in 0..3 {
        topology(&shape).unwrap();
        crate::queries::face_graph(&shape).unwrap();
        mass_properties(&shape).unwrap();
        analyze(&shape).unwrap();
    }
    assert_eq!(facade_queries(), Vec::<&str>::new(), "the later asks are answered from the shape");
}

#[test]
fn a_shape_built_from_another_recipe_never_returns_the_answers_of_the_first() {
    let _serial = crate::serial_blends();
    let (block, edge) = block_and_edge();
    let small = profile(&block, &edge, &[1.0, NAN, 0.0, 0.0], 0.0, 0.5);
    let (small_volume, small_topology) = (volume(&small), topology(&small).unwrap());
    let small_analysis = analyze(&small).unwrap();
    let large = profile(&block, &edge, &[2.0, NAN, 0.0, 0.0], 0.0, 0.5);
    facade_queries();
    let large_volume = volume(&large);
    assert_eq!(facade_queries(), ["massProperties"], "a new shape computes its own answer");
    // a conic blend of size s removes s^2 / 6 per unit length of the 20 mm edge
    assert!((volume(&block) - large_volume - 20.0 * 4.0 / 6.0).abs() < 1e-3, "{large_volume}");
    assert!((volume(&block) - small_volume - 20.0 / 6.0).abs() < 1e-3, "{small_volume}");
    assert_ne!(topology(&large).unwrap()["volume"], small_topology["volume"]);
    assert_ne!(analyze(&large).unwrap().area, small_analysis.area);
    // and the first still answers its own
    assert_eq!(volume(&small), small_volume);
    assert_eq!(topology(&small).unwrap(), small_topology);
}

/// A law that varies (even gently) is skinned from the uniform set of 24 stations, bit for bit as before the sparse seed: only constant sections take the seed. The expected figures were
/// measured on the uniform set (24 stations = 72 spans of the skin, volume bits of the blended block); the seed would give 4 stations and a volume that differs in the last bit.
#[test]
fn a_gently_varying_law_keeps_the_uniform_stations_and_the_surface_of_before_the_sparse_seed() {
    let _serial = crate::serial_blends();
    let (block, edge) = block_and_edge();
    let gentle = profile(&block, &edge, &[1.0, 1.05, 1.0, 0.0], 0.0, 0.5);
    assert_eq!(blend_spans(&gentle), 24);
    assert_eq!(volume(&gentle).to_bits(), 0x409f_31fd_27d2_7d27, "{}", volume(&gentle));
}

/// The blind spot of the probes, measured: the uniform stations are j / 24 and the probes the 48 grid points, so a spike 0.01 of the edge wide centred BETWEEN two probes (t = 0.4896, between
/// 23 / 48 and 24 / 48) is seen by neither a station nor a probe, and the surface (and the volume) follow the law without the spike. The error is the whole spike: -0.71 % of the removed volume.
/// A law with such a feature is not followed; the narrow spike centred ON a probe (the test above) is.
#[test]
fn a_narrow_spike_centred_between_two_probes_is_missed_with_a_measured_volume_error() {
    let _serial = crate::serial_blends();
    let (block, edge) = block_and_edge();
    let laws = [1.0, 1.0, 1.0, 3.0, 0.4846, 1.0, 0.4896, 1.6, 0.4946, 1.0];
    let removed = volume(&block) - volume(&profile(&block, &edge, &laws, 0.0, 0.5));
    let expected = conic_removed(&[(0.0, 1.0), (0.4846, 1.0), (0.4896, 1.6), (0.4946, 1.0), (1.0, 1.0)]);
    let without_spike = conic_removed(&[(0.0, 1.0), (1.0, 1.0)]);
    assert!((removed - without_spike).abs() < 1e-9 * without_spike, "the spike is not seen: removed {removed} vs {without_spike}");
    let error = (removed - expected) / expected;
    assert!((-0.0075..-0.0065).contains(&error), "measured relative error {error}");
}

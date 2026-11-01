//! BLD §13.41: a trimmed corner star must not stand outside the part (`star_overshoot`, `refine_star` and the gate of `build_trimmed` in `cpp/blend_corner.cxx`).

use crate::blend_corner_tests::{
    cube_corner_step, cube_with_setbacks_at_origin, cut_block_setback, cut_block_vertex, edges_at, notched_cube, spec, worst_patch_angle,
    worst_tangent_angle, CornerHooks,
};
use crate::blend_profile_third_tests::assert_inside_source;
use crate::features::{fillet_setback, shape_notes};
use crate::{analyze, mass_properties, Shape};
use serde_json::Value;

/// The `overshoot` and the `centre` rule the corner log of the shape records for each corner (in corner order).
fn corner_notes(shape: &Shape) -> Vec<(f64, String)> {
    let notes: Value = serde_json::from_str(&shape_notes(shape).unwrap()).unwrap();
    notes["corners"]
        .as_array()
        .expect("the corner log")
        .iter()
        .map(|corner| (corner["overshoot"].as_f64().expect("overshoot"), corner["centre"].as_str().expect("centre").to_string()))
        .collect()
}

/// The kind of patch ("exact" star or "plate") the corner log records for each corner.
fn corner_patches(shape: &Shape) -> Vec<String> {
    let notes: Value = serde_json::from_str(&shape_notes(shape).unwrap()).unwrap();
    notes["corners"].as_array().expect("the corner log").iter().map(|corner| corner["patch"].as_str().expect("patch").to_string()).collect()
}

/// The vertex of the cylinder block (r 12) with the circular top edge, the straight top edge and the edge against the cylinder, rounded at 0.5 with setbacks 1.2: the ball cut hole is smooth and the
/// centre taken from the replaced rolling-ball surface put the star 0.069 outside the part (limit 0.015). The 3/8 centre keeps it inside to 5e-7; the volume stays within 1e-3 of OCCT's rolling-ball
/// blend. The independent check samples the built star faces and measures their signed distance to the source.
#[test]
fn a_star_over_a_smooth_hole_is_rebuilt_with_the_rule_centre_when_the_replaced_surface_puts_it_outside_the_part() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let (shape, vertex, meeting) = cut_block_vertex(12.0);
    let (edges, corners) = spec(&shape, &meeting, 0.5, &[vertex], 1.2);
    let unique: Vec<u32> = meeting.iter().map(|&edge| edge as u32).collect();
    let reference =
        mass_properties(&crate::features::fillet(&shape, &unique, 0.5, None).unwrap().expect("a rolling-ball blend")).unwrap().volume;
    crate::test_bridge::set_corner_exact_patch(5);
    let built = fillet_setback(&shape, &edges, &corners).unwrap().expect("the star is accepted");
    assert!(analyze(&built).unwrap().valid);
    let notes = corner_notes(&built);
    assert_eq!(notes[0].1, "rule", "the replaced surface put the star outside the part");
    assert!(notes[0].0 < 1e-5, "the star stands {} outside the part", notes[0].0);
    assert_inside_source(&built, &shape, "cylinder block, smooth hole", 1e-5);
    let volume = mass_properties(&built).unwrap().volume;
    assert!((volume - reference).abs() < 1e-3 * reference, "{volume} against the rolling-ball blend {reference}");
    assert!(worst_tangent_angle(&built) < 0.0095 && worst_patch_angle(&built) < 0.0095);
}

/// The fully rounded trim cube keeps the replaced surface as the centre of its stars (they stand 1.8e-3 outside the part, under the gate of 0.0173, and the volume stays on OCCT's rolling-ball
/// cube): the rule is the fallback, not the default.
#[test]
fn a_star_inside_the_gate_keeps_the_centre_from_the_replaced_surface() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let (shape, edges, corners) = cube_corner_step();
    crate::test_bridge::set_corner_trim(true);
    crate::test_bridge::set_corner_exact_patch(5);
    let built = fillet_setback(&shape, &edges, &corners).unwrap().expect("the stars are accepted");
    let notes = corner_notes(&built);
    assert_eq!(notes.len(), 8);
    for (overshoot, centre) in &notes {
        assert_eq!(centre, "surface");
        assert!(*overshoot > 1e-3 && *overshoot < 1e-3 * 10.0 * 3.0_f64.sqrt(), "{overshoot}");
    }
}

/// Different setbacks (1.5 / 2 / 2.5) at the origin of the cube: the star of that vertex stood 0.22 outside the cube (a sample with a coordinate under 0 or over 10) with the replaced surface as
/// centre, 0.0206 with the rule centre; with spoke tangents of 0.7 of the chord it is 0. The other seven corners are untouched. The independent check classifies the faces' own samples.
#[test]
fn the_star_of_a_vertex_with_different_setbacks_is_rebuilt_with_shorter_tangents_and_stands_inside_the_cube() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    crate::test_bridge::set_corner_trim(true);
    crate::test_bridge::set_corner_exact_patch(5);
    let (shape, edges, corners) = cube_with_setbacks_at_origin([1.5, 2.0, 2.5]);
    let built = fillet_setback(&shape, &edges, &corners).unwrap().expect("the planes isolate the vertex");
    assert!(analyze(&built).unwrap().valid);
    let notes = corner_notes(&built);
    let gate = 1e-3 * 10.0 * 3.0_f64.sqrt();
    assert!(notes.iter().all(|(overshoot, _)| *overshoot <= gate), "{notes:?}");
    assert_eq!(notes.iter().filter(|(_, centre)| centre == "rule").count(), 1, "{notes:?}");
    assert_inside_source(&built, &shape, "cube, setbacks 1.5 / 2 / 2.5", 1.2e-3);
    assert!(worst_tangent_angle(&built) < 0.0095 && worst_patch_angle(&built) < 0.0095);
}

/// A concave corner (the inner vertex of the notch) adds material: its star lies OUTSIDE the part by design and its fault is to go into it. Measured as for a convex corner it read 0.405 (the
/// whole filling of the corner, 0.0178 at its best rebuild); it is the depth INTO the part, 0.005 once the tangents are shortened.
#[test]
fn a_concave_star_is_measured_by_how_far_it_goes_into_the_part() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let shape = notched_cube();
    let inner = [5.0; 3];
    let meeting = edges_at(&shape, inner);
    let (edges, mut corners) = spec(&shape, &meeting, 0.5, &[inner], 1.5);
    for (k, distance) in [1.2, 1.5, 1.8].iter().enumerate() {
        corners[5 + 2 * k] = *distance;
    }
    crate::test_bridge::set_corner_trim(true);
    crate::test_bridge::set_corner_exact_patch(5);
    let built = fillet_setback(&shape, &edges, &corners).unwrap().expect("the concave star is accepted");
    let notes = corner_notes(&built);
    let gate = 1e-3 * 10.0 * 3.0_f64.sqrt();
    assert_eq!(corner_patches(&built), ["exact"], "the star is kept: a convex-signed measure refuses it (0.38) and the plate is built");
    assert!(notes[0].0 > 1e-3 && notes[0].0 < gate, "the star goes {} into the part", notes[0].0);
}

/// The cylinder block (r 12) with setbacks 1.2 / 1.2 / x: a long thin hole. The stars stood 0.21 to 0.43 outside the part with either centre (the Coons patch bulges out of the hole); shorter spoke
/// tangents (0.35 and 0.25 of the chord) bring them to 0.011 to 0.014, under the gate of 0.015, and the star's own boundary measures still hold.
#[test]
fn a_long_thin_hole_gets_a_star_with_short_tangents_inside_the_gate() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    for third in [1.3, 1.4, 1.6] {
        let built = cut_block_setback(12.0, third).unwrap_or_else(|reason| panic!("{third}: {reason}"));
        let notes = corner_notes(&built);
        assert!(notes[0].0 > 5e-3 && notes[0].0 <= 0.015, "{third}: {}", notes[0].0);
        assert_eq!(notes[0].1, "rule");
    }
}

/// The same block at r 11 (the cylinder meets the side plane at 0.43 rad inside the ball): even the shortest tangents leave the star 0.024 to 0.057 outside the part, and the plate misses the blend
/// ends: the step is refused by name, with the measure (it built a star 0.46 to 0.51 outside before 13.41).
#[test]
fn a_star_that_stays_outside_the_part_after_the_rebuilds_is_refused_by_name() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    for third in [1.3, 1.4, 1.6] {
        let reason = cut_block_setback(11.0, third).err().expect("refused");
        assert!(reason.contains("stands 0.0") && reason.contains("outside the part, above 0.015"), "{third}: {reason}");
    }
}

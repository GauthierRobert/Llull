//! BLD M5: per-joint radii of the blended union (`features::blend`, `cpp/features.cxx`). Every tolerance is relative to the part.

use crate::{make_box, make_cylinder, mass_properties, Shape};

/// Picks by point with a constant radius, as `x, y, z, radius` per pick, in the flat layout `features::blend` reads (a short tail stays short: malformed).
fn by_point(picks: &[f64]) -> Vec<f64> {
    picks
        .chunks(4)
        .flat_map(|pick| if pick.len() == 4 { vec![0.0, pick[0], pick[1], pick[2], pick[3], f64::NAN, 0.0, 0.0] } else { pick.to_vec() })
        .collect()
}

/// One empty name per pick, newline between.
fn no_names(picks: &[f64]) -> String {
    "\n".repeat((picks.len() / 4).saturating_sub(1))
}

fn blend(shapes: &[&Shape], radius: f64, picks: &[f64]) -> crate::Built {
    crate::features::blend(shapes, radius, &by_point(picks), &no_names(picks))
}

fn blend_reason(shapes: &[&Shape], radius: f64, picks: &[f64]) -> crate::OcctResult<String> {
    crate::features::blend_reason(shapes, radius, &by_point(picks), &no_names(picks))
}

const SCALES: [f64; 4] = [1.0, 10.0, 100.0, 1000.0];
/// The area a concave right-angle fillet of radius 1 adds to the section: 1 - pi / 4.
const CORNER: f64 = 1.0 - std::f64::consts::FRAC_PI_4;

fn volume_of(shape: &Shape) -> f64 {
    mass_properties(shape).unwrap().volume
}

/// A plate 40 x 20 x 4 with a stem 10 x 20 x 18 sunk 2 into it, both scaled: two straight joints of length 20 at x = 15 and x = 25 on the plate top.
fn tee(scale: f64) -> (Shape, Shape) {
    let plate = make_box([0.0; 3], [40.0 * scale, 20.0 * scale, 4.0 * scale]).unwrap().unwrap();
    let stem = make_box([15.0 * scale, 0.0, 2.0 * scale], [10.0 * scale, 20.0 * scale, 18.0 * scale]).unwrap().unwrap();
    (plate, stem)
}

fn plain_union_volume(scale: f64) -> f64 {
    (40.0 * 20.0 * 4.0 + 10.0 * 20.0 * 16.0) * scale.powi(3)
}

#[test]
fn each_joint_takes_its_own_radius_at_every_size() {
    let _serial = crate::serial_blends();
    for scale in SCALES {
        let (plate, stem) = tee(scale);
        let (left, right, default) = (0.5 * scale, 1.5 * scale, 1.0 * scale);
        // left joint (x = 15) and right joint (x = 25) picked; the default would be 1
        let picks = [15.0 * scale, 10.0 * scale, 4.0 * scale, left, 25.0 * scale, 10.0 * scale, 4.0 * scale, right];
        let shape = blend(&[&plate, &stem], default, &picks).unwrap().expect("builds");
        let expected = plain_union_volume(scale) + CORNER * 20.0 * scale * (left * left + right * right);
        assert!((volume_of(&shape) - expected).abs() < 1e-9 * expected, "scale {scale}: {} vs {expected}", volume_of(&shape));
    }
}

#[test]
fn a_joint_without_a_pick_keeps_the_default_radius_and_no_picks_is_the_old_blend() {
    let _serial = crate::serial_blends();
    for scale in SCALES {
        let (plate, stem) = tee(scale);
        let all = blend(&[&plate, &stem], scale, &[]).unwrap().expect("builds");
        let expected_all = plain_union_volume(scale) + CORNER * 20.0 * scale.powi(3) * 2.0;
        assert!((volume_of(&all) - expected_all).abs() < 1e-9 * expected_all);
        // one pick on the left joint: the right joint keeps the default
        let picked = blend(&[&plate, &stem], scale, &[15.0 * scale, 10.0 * scale, 4.0 * scale, 2.0 * scale]).unwrap().expect("builds");
        let expected = plain_union_volume(scale) + CORNER * 20.0 * scale.powi(3) * (4.0 + 1.0);
        assert!((volume_of(&picked) - expected).abs() < 1e-9 * expected, "scale {scale}");
    }
}

#[test]
fn two_radii_on_one_tangent_chain_and_bad_picks_are_refused_with_the_reason() {
    let _serial = crate::serial_blends();
    let plate = make_box([-20.0, -20.0, -4.0], [40.0, 40.0, 5.0]).unwrap().unwrap();
    let boss = make_cylinder(5.0, 10.0).unwrap().unwrap();
    let why = |radius: f64, picks: &[f64]| blend_reason(&[&plate, &boss], radius, picks).unwrap();
    assert!(why(1.0, &[]).is_empty());
    // two points of the one circular joint with the same radius are fine, with different radii they are not
    assert!(why(1.0, &[5.0, 0.0, 0.0, 0.5, -5.0, 0.0, 0.0, 0.5]).is_empty());
    assert!(why(1.0, &[5.0, 0.0, 0.0, 0.5, -5.0, 0.0, 0.0, 0.8]).contains("one radius per chain"));
    assert!(why(1.0, &[5.0, 0.0, 0.0, -1.0]).contains("> 0"));
    assert!(why(1.0, &[5.0, 0.0, 0.0]).contains("malformed"));
    let apart = make_box([100.0, 0.0, 0.0], [1.0, 1.0, 1.0]).unwrap().unwrap();
    assert!(blend_reason(&[&plate, &apart], 1.0, &[0.0, 0.0, 0.0, 1.0]).unwrap().starts_with("[BLD_JOINT_PARAMS] joints:"));
    assert!(blend(&[&plate, &boss], 1.0, &[5.0, 0.0, 0.0, 0.5, -5.0, 0.0, 0.0, 0.8]).unwrap().is_none());
}

#[test]
fn a_pick_must_lie_within_ten_radii_of_a_joint_and_the_notes_report_its_distance() {
    let _serial = crate::serial_blends();
    for scale in SCALES {
        let (plate, stem) = tee(scale);
        let radius = 0.5 * scale;
        // the left joint runs along y at x = 15, z = 4 (times the scale): a pick h above it is h from it
        let pick = |h: f64| [15.0 * scale, 10.0 * scale, 4.0 * scale + h, radius];
        let why = |h: f64| blend_reason(&[&plate, &stem], scale, &pick(h)).unwrap();
        assert!(why(9.9 * radius).is_empty(), "scale {scale}: just inside the bound builds");
        let outside = why(10.1 * radius);
        assert!(outside.starts_with("[BLD_JOINT_PARAMS] joints[0].near"), "scale {scale}: {outside}");
        assert!(outside.contains("more than 10 x its radius"));
        let built = blend(&[&plate, &stem], scale, &pick(9.9 * radius)).unwrap().expect("builds");
        let notes: serde_json::Value = serde_json::from_str(&crate::features::shape_notes(&built).unwrap()).unwrap();
        let distance = notes["picks"][0]["distance"].as_f64().unwrap();
        assert!((distance - 9.9 * radius).abs() < 1e-9 * scale, "scale {scale}: distance {distance}");
        assert_eq!(notes["picks"][0]["radius"].as_f64().unwrap(), radius);
        assert_eq!(notes["contours"].as_array().unwrap().len(), 2);
        let sources: Vec<&str> = notes["contours"].as_array().unwrap().iter().map(|contour| contour["source"].as_str().unwrap()).collect();
        assert!(sources.contains(&"joints[0]") && sources.contains(&"default"), "scale {scale}: {sources:?}");
    }
}

// BLD M5 (13.32): joints by persistent name and radius laws along a joint.

/// A pick by point with the law `size` -> `end` (NaN: constant) in the `fillet_laws` layout: mode 0 smooth, 1 straight pieces, 2 monotone.
fn law_pick(at: [f64; 3], size: f64, end: f64, mode: f64) -> Vec<f64> {
    vec![0.0, at[0], at[1], at[2], size, end, mode, 0.0]
}

/// A pick by name with a constant radius.
fn name_pick(size: f64) -> Vec<f64> {
    vec![1.0, f64::NAN, f64::NAN, f64::NAN, size, f64::NAN, 0.0, 0.0]
}

fn notes_of(shape: &Shape) -> serde_json::Value {
    serde_json::from_str(&crate::features::shape_notes(shape).unwrap()).unwrap()
}

#[test]
fn a_linear_law_along_a_joint_adds_the_closed_form_volume_at_every_size() {
    let _serial = crate::serial_blends();
    for scale in SCALES {
        let (plate, stem) = tee(scale);
        let (start, end) = (0.5 * scale, 1.5 * scale);
        let picks = law_pick([15.0 * scale, 10.0 * scale, 4.0 * scale], start, end, 1.0);
        let shape = crate::features::blend(&[&plate, &stem], scale, &picks, "").unwrap().expect("builds");
        // the joint at x = 15 runs 20 * scale along y: CORNER * L * (a^2 + ab + b^2) / 3, the default joint CORNER * L * 1
        let law = CORNER * 20.0 * scale * (start * start + start * end + end * end) / 3.0;
        let expected = plain_union_volume(scale) + law + CORNER * 20.0 * scale.powi(3);
        assert!((volume_of(&shape) - expected).abs() < 1e-9 * expected, "scale {scale}: {} vs {expected}", volume_of(&shape));
        let notes = notes_of(&shape);
        let contour = notes["contours"].as_array().unwrap().iter().find(|c| c["source"] == "joints[0]").expect("the picked contour");
        assert_eq!(contour["radiusEnd"].as_f64().unwrap(), end);
        assert_eq!(contour["interpolation"], "linear");
        assert_eq!(contour["isolated"], true);
        assert_eq!(contour["samples"].as_array().unwrap().len(), 5);
    }
}

#[test]
fn a_joint_picked_by_name_is_the_joint_picked_by_point_and_the_notes_carry_its_name_and_ends() {
    let _serial = crate::serial_blends();
    let (plate, stem) = tee(1.0);
    let by_point = crate::features::blend(&[&plate, &stem], 1.0, &law_pick([15.0, 10.0, 4.0], 0.5, f64::NAN, 0.0), "").unwrap().unwrap();
    let pick = notes_of(&by_point)["picks"][0].clone();
    let name = pick["name"].as_str().unwrap().to_string();
    assert!(name.starts_with("e(") && name.contains("|"), "{name}");
    assert_eq!(pick["start"].as_array().unwrap().len(), 3);
    let by_name = crate::features::blend(&[&plate, &stem], 1.0, &name_pick(0.5), &name).unwrap().expect("builds");
    assert_eq!(volume_of(&by_name), volume_of(&by_point));
    assert_eq!(notes_of(&by_name)["picks"][0]["distance"].as_f64().unwrap(), 0.0);
    // a pick by name takes its x, y, z as the midpoint recorded with a #k name: the joint where it was is the joint, one ten radii away is REF_LOST
    let mut mid = pick["mid"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect::<Vec<_>>();
    assert!(name.contains('#'), "{name}");
    let mut recorded = name_pick(0.5);
    recorded[1..4].copy_from_slice(&mid);
    let named = crate::features::blend(&[&plate, &stem], 1.0, &recorded, &name).unwrap().unwrap();
    assert_eq!(volume_of(&named), volume_of(&by_point));
    mid[0] += 10.0;
    recorded[1..4].copy_from_slice(&mid);
    let moved = blend_reason_raw(&[&plate, &stem], &recorded, &name);
    assert!(moved.starts_with("[REF_LOST] joints[0].name:") && moved.contains("numbering"), "{moved}");
    // a pick by name without a recorded midpoint (NaN) is not checked
    assert!(blend_reason_raw(&[&plate, &stem], &name_pick(0.5), &name).is_empty());
    // two picks: one by name, one by point on the other joint
    let mut two = name_pick(0.5);
    two.extend(law_pick([25.0, 10.0, 4.0], 1.5, f64::NAN, 0.0));
    let both_joints = crate::features::blend(&[&plate, &stem], 1.0, &two, &format!("{name}\n")).unwrap().unwrap();
    let expected = plain_union_volume(1.0) + CORNER * 20.0 * (0.25 + 2.25);
    assert!((volume_of(&both_joints) - expected).abs() < 1e-9 * expected);
}

#[test]
fn a_name_that_no_joint_has_is_ref_lost_and_a_name_with_several_images_is_ref_split() {
    let _serial = crate::serial_blends();
    let (plate, stem) = tee(1.0);
    let lost = blend_reason_raw(&[&plate, &stem], &name_pick(0.5), "e(nothing|nowhere)");
    assert!(lost.starts_with("[REF_LOST] joints[0].name:"), "{lost}");
    assert!(lost.contains("joints: e("), "the reason lists the joints that exist: {lost}");
    // two cylinders through each other: the same two faces meet along two curves, e(a|b)#1 and e(a|b)#2
    let big = crate::placed(&make_cylinder(5.0, 14.0).unwrap().unwrap(), [0.0; 3], [0.0, 0.0, -7.0], [0.0; 3]).unwrap().unwrap();
    let small =
        crate::placed(&make_cylinder(3.0, 20.0).unwrap().unwrap(), [std::f64::consts::FRAC_PI_2, 0.0, 0.0], [0.0, 10.0, 0.0], [0.0; 3])
            .unwrap()
            .unwrap();
    let plain = crate::features::blend(&[&big, &small], 0.5, &[], "").unwrap().expect("builds");
    let contours = notes_of(&plain)["contours"].clone();
    let joints: Vec<String> = contours
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|c| c["edges"].as_array().unwrap().clone())
        .map(|n| n.as_str().unwrap().to_string())
        .collect();
    assert_eq!(joints.len(), 2, "{joints:?}");
    let base = joints[0].split('#').next().unwrap().to_string();
    assert!(joints.iter().all(|name| name.starts_with(&base) && name.contains('#')), "{joints:?}");
    let split = blend_reason_raw(&[&big, &small], &name_pick(0.5), &base);
    assert!(split.starts_with("[REF_SPLIT] joints[0].name:"), "{split}");
    assert!(split.contains("now names 2 joints"), "{split}");
    // the full name of one image is one joint
    assert!(blend_reason_raw(&[&big, &small], &name_pick(0.5), &joints[0]).is_empty());
}

#[test]
fn a_closed_joint_takes_a_law_only_if_it_closes_and_a_pick_reaches_ten_radii_of_the_largest_in_its_law() {
    let _serial = crate::serial_blends();
    let plate = make_box([-20.0, -20.0, -4.0], [40.0, 40.0, 5.0]).unwrap().unwrap();
    let boss = make_cylinder(5.0, 10.0).unwrap().unwrap();
    let why = |picks: &[f64]| blend_reason_raw(&[&plate, &boss], picks, "");
    // the circle is one closed edge: a law must close on itself
    let open = why(&law_pick([5.0, 0.0, 0.0], 0.5, 1.0, 0.0));
    assert!(open.starts_with("[BLD_LAW_NOT_PERIODIC] joints[0].radiusEnd:"), "{open}");
    assert!(open.contains("closed curve"), "{open}");
    assert!(why(&law_pick([5.0, 0.0, 0.0], 0.5, 0.5, 0.0)).is_empty(), "r(0) = r(1) closes");
    // a pick with no radius at all (malformed law) and a negative control radius
    assert!(why(&law_pick([5.0, 0.0, 0.0], -1.0, f64::NAN, 0.0)).contains("> 0"));
    assert!(why(&law_pick([5.0, 0.0, 0.0], 0.5, 0.0, 0.0)).contains("> 0"));
    // far from the joint, measured against the largest radius the law reaches
    let far = why(&law_pick([0.0, 0.0, 9.0], 0.5, 0.6, 1.0));
    assert!(far.starts_with("[BLD_JOINT_PARAMS] joints[0].near"), "{far}");
    // a pick by name without a name finds no joint
    assert!(blend_reason_raw(&[&plate, &boss], &name_pick(0.5), "").starts_with("[REF_LOST]"));
}

fn blend_reason_raw(shapes: &[&Shape], picks: &[f64], names: &str) -> String {
    crate::features::blend_reason(shapes, 1.0, picks, names).unwrap()
}

#[test]
fn a_pick_may_lie_ten_of_the_largest_radii_of_its_law_from_the_joint() {
    let _serial = crate::serial_blends();
    let (plate, stem) = tee(1.0);
    // 5.5 above the joint at x = 15: more than 10 x 0.5, less than 10 x 0.6
    let near = [15.0, 10.0, 4.0 + 5.5];
    assert!(blend_reason_raw(&[&plate, &stem], &law_pick(near, 0.5, 0.6, 1.0), "").is_empty());
    assert!(blend_reason_raw(&[&plate, &stem], &law_pick(near, 0.6, 0.5, 1.0), "").is_empty());
    let constant = blend_reason_raw(&[&plate, &stem], &law_pick(near, 0.5, f64::NAN, 0.0), "");
    assert!(constant.starts_with("[BLD_JOINT_PARAMS] joints[0].near"), "{constant}");
}

#[test]
fn a_radius_that_varies_needs_a_joint_alone_in_its_tangent_chain() {
    let _serial = crate::serial_blends();
    let plate = make_box([-20.0, -20.0, -4.0], [40.0, 40.0, 5.0]).unwrap().unwrap();
    let post = make_box([-5.0, -5.0, 0.0], [10.0, 10.0, 10.0]).unwrap().unwrap();
    // the four vertical edges rounded: the foot of the post on the plate is a closed chain of 4 lines and 4 arcs
    let topo = crate::queries::topology(&post).unwrap();
    let vertical: Vec<u32> = topo["edges"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .filter(|(_, edge)| (0..2).all(|axis| (edge["start"][axis].as_f64().unwrap() - edge["end"][axis].as_f64().unwrap()).abs() < 1e-9))
        .map(|(index, _)| index as u32)
        .collect();
    assert_eq!(vertical.len(), 4);
    let rounded = crate::features::fillet(&post, &vertical, 2.0, None).unwrap().expect("rounds");
    let law = blend_reason_raw(&[&plate, &rounded], &law_pick([0.0, 5.0, 1.0], 0.5, 1.0, 0.0), "");
    assert!(law.starts_with("[BLD_JOINT_PARAMS] joints[0].radiusEnd:"), "{law}");
    assert!(law.contains("chained with 7 other joint edge(s)"), "{law}");
    // a constant radius takes the whole chain, and so does the same law on a second pick of the chain
    assert!(blend_reason_raw(&[&plate, &rounded], &law_pick([0.0, 5.0, 1.0], 0.5, f64::NAN, 0.0), "").is_empty());
    let mut two = law_pick([0.0, 5.0, 1.0], 0.5, f64::NAN, 0.0);
    two.extend(law_pick([0.0, -5.0, 1.0], 0.8, f64::NAN, 0.0));
    let names = "\n";
    let conflict = blend_reason_raw(&[&plate, &rounded], &two, names);
    assert!(conflict.starts_with("[BLD_JOINT_PARAMS] joints[1].radius:"), "{conflict}");
    assert!(conflict.contains("one radius per chain"), "{conflict}");
}

#[test]
fn a_station_count_that_is_not_a_whole_number_within_the_flat_is_malformed_not_a_wild_cast() {
    let _serial = crate::serial_blends();
    let (plate, stem) = tee(1.0);
    let malformed = |count: f64| {
        let mut pick = law_pick([15.0, 10.0, 4.0], 0.5, f64::NAN, 0.0);
        pick[7] = count;
        blend_reason_raw(&[&plate, &stem], &pick, "")
    };
    // 2^63 doubles to 2 x count = 0 in size_t: the length check passed and the law was then read far past the data
    for count in [9.223372036854775808e18, f64::INFINITY, 1e300, 1e7, 1.5, -1.0, f64::NAN, 3.0] {
        assert!(
            malformed(count).starts_with("[BLD_JOINT_PARAMS] joints: the joint radii are malformed"),
            "count {count}: {}",
            malformed(count)
        );
    }
    assert!(malformed(0.0).is_empty());
}

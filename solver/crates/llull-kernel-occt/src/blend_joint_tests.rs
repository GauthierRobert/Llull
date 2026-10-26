//! BLD M5: per-joint radii of the blended union (`features::blend`, `cpp/features.cxx`). Every tolerance is relative to the part.

use crate::features::{blend, blend_reason};
use crate::{make_box, make_cylinder, mass_properties, Shape};

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

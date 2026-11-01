//! BLD M2 oblique ends on a CURVED end face (13.37, `cpp/blend_ends_curved.cxx`): the skin runs past the end of the circular blend and is split by the surface of
//! the end face itself, keeping the piece on the solid's side. The oracle is the integral of the spandrel over the points that lie on the solid's side of that
//! surface (a revolved spandrel against a vertical cylinder or a sphere; a straight edge against a cylinder), independent of OCCT; OCCT's own fillet is the
//! second oracle for a constant size.

use crate::blend_rail_end_tests::{
    blend, built, circle_curve, contacts, diagonal, edges_where, face_count, gauss, near, num, parabola_curve, prism_part, volume_of, Rim,
    CIRCLE_PARAM, NAN,
};
use crate::features::{fillet, fillet_laws};
use crate::queries::{edge_continuity, topology};
use crate::{boolean, make_box, make_cylinder, make_sphere, placed, BooleanOp, Shape};

/// The largest distance between the two faces of any edge shared by two faces, over the whole solid (a creased edge counts as well as a tangent one): the new end
/// curve of the blend lies on the end face to this.
fn worst_edge_gap(shape: &Shape) -> f64 {
    let count = topology(shape).unwrap()["edges"].as_array().unwrap().len();
    let mut worst = 0.0_f64;
    for edge in 0..count {
        if let Some(samples) = edge_continuity(shape, edge as f64, 9.0).unwrap().as_array() {
            for sample in samples {
                worst = worst.max(num(&sample["g0"]));
            }
        }
    }
    worst
}

/// The volume of the revolved spandrel of the rim `rim` on the side of the end surface where `inside(r, z)` is the angle (radians, over the whole turn) of the
/// points at radius r and height z that are kept; the spandrel curve is given as for `Rim`.
fn revolved_kept(rim: Rim, curve: &dyn Fn(f64) -> (f64, f64, f64), inside: &dyn Fn(f64, f64) -> f64) -> f64 {
    let sign = if rim.convex { -1.0 } else { 1.0 };
    gauss(
        &|t| {
            let (x, y_max, speed) = curve(t);
            let rho = rim.radius + sign * x;
            speed * gauss(&|y| rho * inside(rho, rim.corner_z + sign * y), 0.0, y_max, 1)
        },
        0.0,
        1.0,
        16,
    )
}

/// The disc of radius 8 and height 3 on the z axis.
fn disc() -> Shape {
    make_cylinder(8.0, 3.0).unwrap().unwrap()
}

/// The rim arc of the top face: the circle edge at z = 3 whose middle is 8 from the axis.
fn rim_arc(shape: &Shape) -> Vec<u32> {
    edges_where(shape, |e| {
        e["curve"] == "circle" && (num(&e["mid"][2]) - 3.0).abs() < 1e-3 && num(&e["mid"][0]).hypot(num(&e["mid"][1])) > 7.0
    })
}

/// The angle (over the whole turn) of the points at radius r and height z that lie within `rho` of the vertical axis through (c, 0) when `ball` is false (the end
/// face a cylinder), or within `rho` of the point (c, 0, 0) when it is true (a sphere).
fn kept_angle(c: f64, rho: f64, ball: bool) -> impl Fn(f64, f64) -> f64 {
    move |r, z| 2.0 * ((r * r + c * c + if ball { z * z } else { 0.0 } - rho * rho) / (2.0 * r * c)).clamp(-1.0, 1.0).acos()
}

#[test]
fn a_rim_arc_ending_on_a_cylindrical_end_face_is_the_integral_of_the_spandrel_and_the_circular_fillet() {
    let _serial = crate::serial_blends();
    let rim = Rim { radius: 8.0, corner_z: 3.0, convex: true };
    // the disc cut by a vertical cylinder of radius 5 on the axis x = -7 (away from the seam of the disc): the rim arc ends on its face where it leaves the arc at 1.05 rad
    let boss = placed(&make_cylinder(5.0, 5.0).unwrap().unwrap(), [0.0; 3], [-7.0, 0.0, -1.0], [0.0; 3]).unwrap().unwrap();
    let part = boolean(BooleanOp::Intersect, &disc(), &boss, false).unwrap().unwrap();
    let edge = rim_arc(&part);
    assert_eq!(edge.len(), 1);
    for (name, param, size, curve) in [
        ("circle", CIRCLE_PARAM, 1.0, Box::new(circle_curve(1.0)) as Box<dyn Fn(f64) -> (f64, f64, f64)>),
        ("parabola", 0.5, 1.0, Box::new(parabola_curve(1.0))),
        ("small circle", CIRCLE_PARAM, 0.4, Box::new(circle_curve(0.4))),
    ] {
        let shape = built(&part, &edge, &[size, NAN, 0.0, 0.0], 0.0, param);
        let removed = volume_of(&part) - volume_of(&shape);
        let expected = revolved_kept(rim, &curve, &kept_angle(7.0, 5.0, false));
        assert!(near(removed, expected, 5e-6), "{name}: removed {removed} expected {expected}");
        if param == CIRCLE_PARAM {
            let occt = fillet(&part, &edge, size, None).unwrap().unwrap();
            assert!(near(volume_of(&shape), volume_of(&occt), 1e-6), "{name}: {} vs OCCT {}", volume_of(&shape), volume_of(&occt));
        }
        let (g0, g1, found) = contacts(&shape);
        assert_eq!(found, contacts(&part).2 + 2, "{name}");
        assert!(g0 < 1e-6 * diagonal(&shape) && g1 < 1e-3, "{name}: g0 {g0} g1 {g1}");
        // one new face; the end face stays one face; the new end curve lies on it
        assert_eq!(face_count(&shape), face_count(&part) + 1, "{name}");
        assert!(worst_edge_gap(&shape) < 1e-6 * diagonal(&shape), "{name}: edge gap {}", worst_edge_gap(&shape));
        let analysis = crate::analyze(&shape).unwrap();
        assert!(analysis.valid && analysis.free_edges == 0 && analysis.solids == 1, "{name}");
        assert!(near(volume_of(&boolean(BooleanOp::Intersect, &disc(), &boss, false).unwrap().unwrap()), volume_of(&part), 1e-12));
    }
}

#[test]
fn a_rim_arc_ending_on_a_sphere_is_the_integral_of_the_spandrel_and_the_circular_fillet() {
    let _serial = crate::serial_blends();
    let rim = Rim { radius: 8.0, corner_z: 3.0, convex: true };
    // the disc cut by the ball of radius 7 centred at (-7, 0, 0): the rim arc ends on the sphere, 0.87 rad from its tangent plane
    let ball = placed(&make_sphere(7.0).unwrap().unwrap(), [0.0; 3], [-7.0, 0.0, 0.0], [0.0; 3]).unwrap().unwrap();
    let part = boolean(BooleanOp::Intersect, &disc(), &ball, false).unwrap().unwrap();
    let edge = rim_arc(&part);
    assert_eq!(edge.len(), 1);
    let shape = built(&part, &edge, &[1.0, NAN, 0.0, 0.0], 0.0, CIRCLE_PARAM);
    let removed = volume_of(&part) - volume_of(&shape);
    let expected = revolved_kept(rim, &circle_curve(1.0), &kept_angle(7.0, 7.0, true));
    assert!(near(removed, expected, 5e-6), "removed {removed} expected {expected}");
    let occt = fillet(&part, &edge, 1.0, None).unwrap().unwrap();
    assert!(near(volume_of(&shape), volume_of(&occt), 1e-6), "{} vs OCCT {}", volume_of(&shape), volume_of(&occt));
    let (g0, g1, found) = contacts(&shape);
    assert_eq!(found, contacts(&part).2 + 2);
    assert!(g0 < 1e-6 * diagonal(&shape) && g1 < 1e-3, "g0 {g0} g1 {g1}");
    assert_eq!(face_count(&shape), face_count(&part) + 1);
    assert!(worst_edge_gap(&shape) < 1e-6 * diagonal(&shape), "edge gap {}", worst_edge_gap(&shape));
    let analysis = crate::analyze(&shape).unwrap();
    assert!(analysis.valid && analysis.free_edges == 0 && analysis.solids == 1);
}

#[test]
fn a_changing_size_on_a_straight_edge_ending_on_a_cylinder_is_the_integral_of_the_cut_section() {
    let _serial = crate::serial_blends();
    // the slab 10 x 6 x 3 cut by the cylinder of radius 8 on the z axis: the top front edge runs from x = 0 to x = 8 and ends on the cylinder, which leaves
    // the section planes x = const at the depth y = sqrt(64 - x^2)
    let slab = make_box([0.0; 3], [10.0, 6.0, 3.0]).unwrap().unwrap();
    let part = boolean(BooleanOp::Intersect, &slab, &disc(), false).unwrap().unwrap();
    let edge = edges_where(&part, |e| (num(&e["mid"][2]) - 3.0).abs() < 1e-9 && num(&e["mid"][1]).abs() < 1e-9);
    assert_eq!(edge.len(), 1);
    let forward = num(&topology(&part).unwrap()["edges"][edge[0] as usize]["start"][0]) < 4.0;
    let (r0, r1) = (0.4, 0.8);
    let laws = if forward { [r0, r1, 1.0, 0.0] } else { [r1, r0, 1.0, 0.0] };
    let shape = built(&part, &edge, &laws, 0.0, 0.5);
    let removed = volume_of(&part) - volume_of(&shape);
    // the size grows from r0 at x = 0 to r0 + (r1 - r0) / 8 x ... the law runs over the edge of length 8
    let d = |x: f64| r0 + (r1 - r0) * x / 8.0;
    let depth = |x: f64| (64.0 - x * x).sqrt();
    // x* where the cylinder reaches the leg (depth = d): the section is whole before it
    let (mut lo, mut hi) = (0.0_f64, 8.0_f64);
    for _ in 0..100 {
        let mid = 0.5 * (lo + hi);
        if depth(mid) > d(mid) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let star = 0.5 * (lo + hi);
    let whole = gauss(&|x| d(x) * d(x) / 6.0, 0.0, star, 8);
    // beyond x*, q = sqrt(depth): the kept part of the parabola is d^2 (U^2 - 4 U^3 / 3 + U^4 / 2) with U = q / sqrt(d), and dx = -2 q^3 / x dq
    let top = depth(star).sqrt();
    let cut = gauss(
        &|q| {
            let x = (64.0 - q.powi(4)).sqrt();
            let u2 = q * q / d(x);
            let u = u2.sqrt();
            d(x) * d(x) * (u2 - 4.0 / 3.0 * u2 * u + 0.5 * u2 * u2) * 2.0 * q.powi(3) / x
        },
        0.0,
        top,
        16,
    );
    assert!(near(removed, whole + cut, 1e-5), "removed {removed} expected {} (whole {whole} cut {cut})", whole + cut);
    let (g0, g1, found) = contacts(&shape);
    assert_eq!(found, 2);
    assert!(g0 < 1e-6 * diagonal(&shape) && g1 < 1e-3, "g0 {g0} g1 {g1}");
    assert!(worst_edge_gap(&shape) < 1e-6 * diagonal(&shape), "edge gap {}", worst_edge_gap(&shape));
    // the same part with a constant size agrees with OCCT's fillet
    let constant = built(&part, &edge, &[0.6, 0.6, 1.0, 0.0], 0.0, CIRCLE_PARAM);
    let occt = fillet_laws(&part, &edge, &[0.6, 0.6, 1.0, 0.0]).unwrap().unwrap();
    assert!(near(volume_of(&constant), volume_of(&occt), 1e-6), "{} vs OCCT {}", volume_of(&constant), volume_of(&occt));
}

#[test]
fn what_a_curved_end_face_cannot_have_is_named() {
    let _serial = crate::serial_blends();
    // an end face that leaves the edge at a crease under 0.5 rad: the slab cut by the cylinder of radius 8 on the axis (9, 7.5), whose face meets the top front
    // edge (y = 0) at (6.22, 0) with its normal 0.355 rad from the direction of the edge
    let slab = make_box([0.0; 3], [20.0, 12.0, 3.0]).unwrap().unwrap();
    let round = placed(&make_cylinder(8.0, 5.0).unwrap().unwrap(), [0.0; 3], [9.0, 7.5, -1.0], [0.0; 3]).unwrap().unwrap();
    let part = boolean(BooleanOp::Intersect, &slab, &round, false).unwrap().unwrap();
    let edge = edges_where(&part, |e| (num(&e["mid"][2]) - 3.0).abs() < 1e-9 && num(&e["mid"][1]).abs() < 1e-9);
    assert_eq!(edge.len(), 1);
    let why = blend(&part, &edge, &[0.3, 0.4, 1.0, 0.0], 0.0, 0.5).err().expect("refused");
    assert!(why.contains("ends obliquely") && why.contains("its end face is curved and meets the blend at a crease of 0.35"), "{why}");
    // a varying size whose contact line runs past the end vertex of the edge onto a CURVED end face: the size law is continued past the end of a flat end face only
    // (the slab with the cylinder of radius 8 on the axis (18, 0) cut out: the wall leans away from the edge, x = 18 - sqrt(64 - y^2))
    let slab = make_box([0.0; 3], [13.0, 6.0, 3.0]).unwrap().unwrap();
    let hole = placed(&make_cylinder(8.0, 5.0).unwrap().unwrap(), [0.0; 3], [18.0, 0.0, -1.0], [0.0; 3]).unwrap().unwrap();
    let part = boolean(BooleanOp::Subtract, &slab, &hole, false).unwrap().unwrap();
    let edge = edges_where(&part, |e| (num(&e["mid"][2]) - 3.0).abs() < 1e-9 && num(&e["mid"][1]).abs() < 1e-9);
    assert_eq!(edge.len(), 1);
    let forward = num(&topology(&part).unwrap()["edges"][edge[0] as usize]["start"][0]) < 5.0;
    let laws = if forward { [0.4, 0.8, 1.0, 0.0] } else { [0.8, 0.4, 1.0, 0.0] };
    let why = blend(&part, &edge, &laws, 0.0, 0.5).err().expect("refused");
    assert!(why.contains("does not continue past the end of the edge"), "{why}");
}

#[test]
fn a_contact_point_that_would_move_past_the_edge_of_its_end_face_is_refused_with_both_lengths() {
    let _serial = crate::serial_blends();
    // a top face only 0.9 wide with a blend of 0.85 at the end: the contact point moves 0.022 along the edge of the end wall when the size is continued, which is only 0.056 long
    let part = prism_part(&[[0.0, 0.0], [10.0, 0.0], [10.45, 0.9], [-0.45, 0.9]]);
    let (edge, forward) = crate::blend_rail_end_tests::front_edge(&part);
    let why = blend(&part, &edge, &crate::blend_rail_end_tests::law(0.4, 0.85, forward), 0.0, 0.5).err().expect("refused");
    assert!(why.contains("moves by") && why.contains("along the edge of the end face it lies on, which is only"), "{why}");
}

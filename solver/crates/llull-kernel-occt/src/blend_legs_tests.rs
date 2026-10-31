//! BLD §13.34: profile blends with two legs (`size2`) on curved edges, curved faces and with legs that run along the edge (`features::fillet_profile_legs`,
//! `cpp/blend_legs.cxx`). The removed volume is compared with an integral of the section the test computes itself, never with the builder's own numbers.

use crate::features::{fillet_profile_legs, profile_legs_reason};
use crate::queries::{edge_continuity, topology};
use crate::{boolean, make_box, make_cylinder, make_sphere, mass_properties, BooleanOp, Shape};
use serde_json::Value;

pub(crate) const NAN: f64 = f64::NAN;
pub(crate) const PI: f64 = std::f64::consts::PI;
const SCALES: [f64; 3] = [1.0, 10.0, 100.0];
/// Samples per contact line: the sections are interpolated between 24 stations, so 129 samples read the skin between them (off the stations) as well.
const CONTACT_SAMPLES: f64 = 129.0;

pub(crate) fn num(value: &Value) -> f64 {
    value.as_f64().unwrap()
}

pub(crate) fn volume_of(shape: &Shape) -> f64 {
    mass_properties(shape).unwrap().volume
}

pub(crate) fn edges_where(shape: &Shape, keep: impl Fn(&Value) -> bool) -> Vec<u32> {
    let topo = topology(shape).unwrap();
    topo["edges"].as_array().unwrap().iter().enumerate().filter(|(_, edge)| keep(edge)).map(|(index, _)| index as u32).collect()
}

/// The unique index of the plane face whose outward normal is `normal` and whose centre height is `height`.
pub(crate) fn plane_face(shape: &Shape, normal: [f64; 3]) -> u32 {
    let topo = topology(shape).unwrap();
    let found = topo["faces"]
        .as_array()
        .unwrap()
        .iter()
        .position(|face| face["surface"] == "plane" && (0..3).all(|axis| (num(&face["normal"][axis]) - normal[axis]).abs() < 1e-9))
        .expect("plane face");
    found as u32
}

pub(crate) fn cylinder_face(shape: &Shape) -> u32 {
    let topo = topology(shape).unwrap();
    topo["faces"].as_array().unwrap().iter().position(|face| face["surface"] == "cylinder").expect("cylinder face") as u32
}

/// One edge: the numbers of `legs` (unique edge, face carrying the first leg, size, sizeEnd, size2, size2End).
pub(crate) fn leg_row(edge: u32, side: u32, size: f64, size_end: f64, size2: f64, size2_end: f64) -> [f64; 6] {
    [f64::from(edge), f64::from(side), size, size_end, size2, size2_end]
}

/// The two-leg blend of `rows`, as the evaluator asks for it (no prism specs: the builder under test is the one reached).
pub(crate) fn blend(shape: &Shape, rows: &[[f64; 6]], kind: f64, param: f64) -> Result<Shape, String> {
    let edges: Vec<u32> = rows.iter().map(|row| row[0] as u32).collect();
    let legs: Vec<f64> = rows.iter().flatten().copied().collect();
    match fillet_profile_legs(shape, &[], &edges, &[], &legs, kind, param).unwrap() {
        Some(built) => Ok(built),
        None => Err(profile_legs_reason(shape, &[], &edges, &[], &legs, kind, param).unwrap()),
    }
}

pub(crate) fn built(shape: &Shape, rows: &[[f64; 6]], kind: f64, param: f64) -> Shape {
    blend(shape, rows, kind, param).unwrap_or_else(|why| panic!("refused: {why}"))
}

/// Volume of the revolution about the z axis of the region bounded by the closed polygon `points` (rho, z): 2 pi |closed integral of rho^2 / 2 dz|, exact per segment.
pub(crate) fn revolved(points: &[(f64, f64)]) -> f64 {
    let mut sum = 0.0;
    for k in 0..points.len() {
        let (p, q) = (points[k], points[(k + 1) % points.len()]);
        sum += (p.0 * p.0 + p.0 * q.0 + q.0 * q.0) / 6.0 * (q.1 - p.1);
    }
    2.0 * PI * sum.abs()
}

/// The rational quadratic conic a, t, b of weight w sampled at `n` + 1 points (rho, z).
fn conic(a: (f64, f64), t: (f64, f64), b: (f64, f64), w: f64, n: usize) -> Vec<(f64, f64)> {
    (0..=n)
        .map(|k| {
            let u = k as f64 / n as f64;
            let basis = [(1.0 - u) * (1.0 - u), 2.0 * u * (1.0 - u) * w, u * u];
            let norm: f64 = basis.iter().sum();
            ((basis[0] * a.0 + basis[1] * t.0 + basis[2] * b.0) / norm, (basis[0] * a.1 + basis[1] * t.1 + basis[2] * b.1) / norm)
        })
        .collect()
}

/// The weight of the circular-equivalent conic whose tangent lines meet at `t`: sin of half the angle at `t` between the legs.
fn circular_weight(a: (f64, f64), t: (f64, f64), b: (f64, f64)) -> f64 {
    let (u, v) = ((a.0 - t.0, a.1 - t.1), (b.0 - t.0, b.1 - t.1));
    let cosine = (u.0 * v.0 + u.1 * v.1) / (u.0.hypot(u.1) * v.0.hypot(v.1));
    (cosine.acos() / 2.0).sin()
}

/// Largest position gap and tangent angle over every edge shared by two faces that meet tangentially (the contact lines), and how many there are.
pub(crate) fn contacts(shape: &Shape) -> (f64, f64, usize) {
    let count = topology(shape).unwrap()["edges"].as_array().unwrap().len();
    let (mut g0, mut g1, mut found) = (0.0_f64, 0.0_f64, 0);
    for edge in 0..count {
        let Some(samples) = edge_continuity(shape, edge as f64, CONTACT_SAMPLES).unwrap().as_array().cloned() else { continue };
        if samples.iter().any(|sample| num(&sample["g1"]) > 0.5) {
            continue;
        }
        found += 1;
        for sample in samples {
            g0 = g0.max(num(&sample["g0"]));
            g1 = g1.max(num(&sample["g1"]));
        }
    }
    (g0, g1, found)
}

/// The fewest samples edge_continuity returned for a contact line (an edge where two faces meet tangentially).
fn least_contact_samples(shape: &Shape) -> usize {
    let count = topology(shape).unwrap()["edges"].as_array().unwrap().len();
    (0..count)
        .filter_map(|edge| edge_continuity(shape, edge as f64, CONTACT_SAMPLES).unwrap().as_array().cloned())
        .filter(|samples| samples.iter().all(|sample| num(&sample["g1"]) <= 0.5))
        .map(|samples| samples.len())
        .min()
        .unwrap_or(0)
}

pub(crate) fn diagonal(shape: &Shape) -> f64 {
    let bounds = mass_properties(shape).unwrap().bounds;
    (0..3).map(|axis| (bounds[3 + axis] - bounds[axis]).powi(2)).sum::<f64>().sqrt()
}

#[test]
fn a_cylinder_rim_with_two_unequal_legs_removes_the_revolved_spandrel_at_every_size() {
    let _serial = crate::serial_blends();
    for scale in SCALES {
        let (r, h) = (10.0 * scale, 20.0 * scale);
        let cylinder = make_cylinder(r, h).unwrap().unwrap();
        let rim = edges_where(&cylinder, |e| e["curve"] == "circle" && (num(&e["mid"][2]) - h).abs() < 1e-9 * scale);
        let (top, side) = (plane_face(&cylinder, [0.0, 0.0, 1.0]), cylinder_face(&cylinder));
        for (d_top, d_side, first_face) in [(1.0, 3.0, top), (3.0, 1.0, top), (1.0, 3.0, side)] {
            let (d_top, d_side) = (d_top * scale, d_side * scale);
            // `size` is the leg on the face named by the row: the top (radial) or the cylinder (axial)
            let (size, size2) = if first_face == top { (d_top, d_side) } else { (d_side, d_top) };
            for (kind, param) in [(0.0, 0.5), (2.0, 0.0)] {
                let shape = built(&cylinder, &[leg_row(rim[0], first_face, size, NAN, size2, NAN)], kind, param);
                let removed = volume_of(&cylinder) - volume_of(&shape);
                let (a, t, b) = ((r - d_top, h), (r, h), (r, h - d_side));
                let w = if kind == 0.0 { param / (1.0 - param) } else { circular_weight(a, t, b) };
                let mut outline = vec![t];
                outline.extend(conic(a, t, b, w, 20000));
                let expected = revolved(&outline);
                assert!(
                    (removed - expected).abs() < 1e-6 * expected,
                    "scale {scale} legs {d_top} x {d_side} kind {kind}: removed {removed} vs {expected}"
                );
                let (g0, g1, count) = contacts(&shape);
                assert_eq!(count, 2, "the blend touches the top and the side");
                assert!(g0 < 1e-6 * diagonal(&shape) && g1 < 1e-4, "scale {scale}: contacts G0 {g0} G1 {g1}");
                let topo = topology(&shape).unwrap();
                assert_eq!(topo["faces"].as_array().unwrap().len(), 4, "the blend face replaces the corner");
                assert!(
                    topo["faces"].as_array().unwrap().iter().any(|f| f["name"].as_str().is_some_and(|name| name.starts_with("blend("))),
                    "the blend face is named by its edge"
                );
            }
        }
    }
}

/// Area and first moment about the corner's wall (the x coordinate) of the section region bounded by the corner (0, 0), the conic from a = (d1, 0) to
/// b = (0, d2) of weight `w`: the shoelace sums of the closed polygon.
fn section_moments(d1: f64, d2: f64, w: f64) -> (f64, f64) {
    let mut outline = vec![(0.0, 0.0)];
    outline.extend(conic((d1, 0.0), (0.0, 0.0), (0.0, d2), w, 4000));
    let (mut area, mut moment) = (0.0, 0.0);
    for k in 0..outline.len() {
        let (p, q) = (outline[k], outline[(k + 1) % outline.len()]);
        let cross = p.0 * q.1 - q.0 * p.1;
        area += 0.5 * cross;
        moment += (p.0 + q.0) * cross / 6.0;
    }
    (area.abs(), moment.abs())
}

/// The weight of the section of a right-angle corner (local coordinates of `section_moments`) for the profile `kind`.
fn right_angle_weight(kind: f64, param: f64, d1: f64, d2: f64) -> f64 {
    if kind == 0.0 {
        param / (1.0 - param)
    } else {
        circular_weight((d1, 0.0), (0.0, 0.0), (0.0, d2))
    }
}

/// Simpson's rule of `f` over [0, 1] with 400 intervals.
pub(crate) fn integral(f: impl Fn(f64) -> f64) -> f64 {
    let n = 400;
    (0..=n)
        .map(|k| {
            (if k == 0 || k == n {
                1.0
            } else if k % 2 == 1 {
                4.0
            } else {
                2.0
            }) * f(f64::from(k) / f64::from(n))
        })
        .sum::<f64>()
        / (3.0 * f64::from(n))
}

#[test]
fn a_boss_foot_with_two_legs_adds_the_revolved_spandrel() {
    let _serial = crate::serial_blends();
    for scale in SCALES {
        let plate = make_box([-30.0 * scale, -30.0 * scale, 0.0], [60.0 * scale, 60.0 * scale, 5.0 * scale]).unwrap().unwrap();
        let boss = make_cylinder(5.0 * scale, 10.0 * scale).unwrap().unwrap();
        let part = boolean(BooleanOp::Union, &plate, &boss, true).unwrap().unwrap();
        let foot = edges_where(&part, |e| e["curve"] == "circle" && (num(&e["mid"][2]) - 5.0 * scale).abs() < 1e-9 * scale);
        assert_eq!(foot.len(), 1);
        let (d_plate, d_boss) = (1.5 * scale, 3.0 * scale);
        let shape = built(&part, &[leg_row(foot[0], plane_face(&part, [0.0, 0.0, 1.0]), d_plate, NAN, d_boss, NAN)], 0.0, 0.5);
        let added = volume_of(&shape) - volume_of(&part);
        let (r, z) = (5.0 * scale, 5.0 * scale);
        let mut outline = vec![(r, z)];
        outline.extend(conic((r + d_plate, z), (r, z), (r, z + d_boss), 1.0, 20000));
        let expected = revolved(&outline);
        assert!((added - expected).abs() < 1e-6 * expected, "scale {scale}: added {added} vs {expected}");
        let (g0, g1, count) = contacts(&shape);
        assert!(count >= 2 && g0 < 1e-6 * diagonal(&shape) && g1 < 1e-4, "scale {scale}: contacts {count} G0 {g0} G1 {g1}");
    }
}

#[test]
fn legs_on_a_sphere_are_chords_in_the_plane_of_the_section() {
    let _serial = crate::serial_blends();
    for scale in SCALES {
        let r = 10.0 * scale;
        let ball = make_sphere(r).unwrap().unwrap();
        let cut = make_box([-2.0 * r, -2.0 * r, -2.0 * r], [4.0 * r, 4.0 * r, 2.0 * r + 5.0 * scale]).unwrap().unwrap();
        let cap = boolean(BooleanOp::Intersect, &ball, &cut, true).unwrap().unwrap();
        let rim = edges_where(&cap, |e| e["curve"] == "circle" && (num(&e["mid"][2]) - 5.0 * scale).abs() < 1e-9 * scale);
        assert_eq!(rim.len(), 1);
        let (d_top, d_sphere) = (1.0 * scale, 2.0 * scale);
        let top = plane_face(&cap, [0.0, 0.0, 1.0]);
        let (rho, z) = ((r * r - 25.0 * scale * scale).sqrt(), 5.0 * scale);
        // B: the point of the meridian circle (centre 0, radius r) at the chord d_sphere below the corner
        let to_corner = rho.hypot(z);
        let along = (to_corner * to_corner + r * r - d_sphere * d_sphere) / (2.0 * to_corner);
        let height = (r * r - along * along).sqrt();
        let unit = (rho / to_corner, z / to_corner);
        let candidates = [
            (along * unit.0 + height * -unit.1, along * unit.1 + height * unit.0),
            (along * unit.0 - height * -unit.1, along * unit.1 - height * unit.0),
        ];
        let b = if candidates[0].1 < candidates[1].1 { candidates[0] } else { candidates[1] };
        let a = (rho - d_top, z);
        let t = ((r * r - z * b.1) / b.0, z);
        for (kind, param) in [(0.0, 0.5), (2.0, 0.0)] {
            let shape = built(&cap, &[leg_row(rim[0], top, d_top, NAN, d_sphere, NAN)], kind, param);
            let removed = volume_of(&cap) - volume_of(&shape);
            let w = if kind == 0.0 { param / (1.0 - param) } else { circular_weight(a, t, b) };
            let mut outline = vec![(rho, z), a];
            outline.extend(conic(a, t, b, w, 20000));
            let (start, end) = (b.1.atan2(b.0), z.atan2(rho));
            outline.extend((0..=20000).map(|k| {
                let angle = start + (end - start) * f64::from(k) / 20000.0;
                (r * angle.cos(), r * angle.sin())
            }));
            let expected = revolved(&outline);
            assert!((removed - expected).abs() < 1e-5 * expected, "scale {scale} kind {kind}: removed {removed} vs {expected}");
            let (g0, g1, count) = contacts(&shape);
            assert!(count >= 2 && g0 < 1e-6 * diagonal(&shape) && g1 < 1e-4, "scale {scale}: contacts {count} G0 {g0} G1 {g1}");
        }
    }
}

#[test]
fn legs_that_run_along_a_straight_edge_remove_the_integral_of_the_section() {
    let _serial = crate::serial_blends();
    for scale in SCALES {
        let part = make_box([0.0; 3], [20.0 * scale, 10.0 * scale, 5.0 * scale]).unwrap().unwrap();
        let edge = edges_where(&part, |e| (num(&e["mid"][2]) - 5.0 * scale).abs() < 1e-9 * scale && num(&e["mid"][1]).abs() < 1e-9 * scale);
        let (top, front) = (plane_face(&part, [0.0, 0.0, 1.0]), plane_face(&part, [0.0, -1.0, 0.0]));
        for (side, first, first_end, second, second_end) in
            [(top, 1.0, 2.0, 2.0, 3.0), (front, 1.0, 2.0, 2.0, 3.0), (top, 2.0, 1.0, 1.0, 2.0)]
        {
            for (kind, param) in [(0.0, 0.5), (2.0, 0.0), (0.0, 0.3)] {
                let shape = built(
                    &part,
                    &[leg_row(edge[0], side, first * scale, first_end * scale, second * scale, second_end * scale)],
                    kind,
                    param,
                );
                let removed = volume_of(&part) - volume_of(&shape);
                let expected = 20.0
                    * scale
                    * integral(|s| {
                        let (first_leg, second_leg) =
                            ((first + (first_end - first) * s) * scale, (second + (second_end - second) * s) * scale);
                        section_moments(first_leg, second_leg, right_angle_weight(kind, param, first_leg, second_leg)).0
                    });
                assert!(
                    (removed - expected).abs() < 1e-6 * expected,
                    "scale {scale} side {side} kind {kind}/{param}: removed {removed} vs {expected}"
                );
                let (g0, g1, _) = contacts(&shape);
                assert!(g0 < 1e-6 * diagonal(&shape) && g1 < 1e-4, "scale {scale}: contacts G0 {g0} G1 {g1}");
            }
        }
    }
}

#[test]
fn legs_that_run_along_an_arc_remove_the_revolved_integral_of_the_section() {
    let _serial = crate::serial_blends();
    for scale in [1.0, 10.0] {
        let (r, h) = (20.0 * scale, 10.0 * scale);
        let cylinder = make_cylinder(r, h).unwrap().unwrap();
        let half = make_box([-2.0 * r, 0.0, -scale], [4.0 * r, 2.0 * r, h + 2.0 * scale]).unwrap().unwrap();
        let part = boolean(BooleanOp::Intersect, &cylinder, &half, true).unwrap().unwrap();
        let arc = edges_where(&part, |e| e["curve"] == "circle" && (num(&e["mid"][2]) - h).abs() < 1e-9 * scale);
        assert_eq!(arc.len(), 1);
        let (top, side) = (plane_face(&part, [0.0, 0.0, 1.0]), cylinder_face(&part));
        for (first_face, first, first_end, second, second_end) in
            [(top, 1.0, 2.0, 2.0, 3.0), (side, 1.0, 2.0, 2.0, 3.0), (top, 2.0, 1.0, 1.0, 2.0)]
        {
            let shape = built(
                &part,
                &[leg_row(arc[0], first_face, first * scale, first_end * scale, second * scale, second_end * scale)],
                0.0,
                0.5,
            );
            let removed = volume_of(&part) - volume_of(&shape);
            // a leg on the top plane runs radially inward from the wall (x), a leg on the cylinder down the wall: V = integral (R A - M_x) d theta
            let expected = PI
                * integral(|s| {
                    let (first_leg, second_leg) = ((first + (first_end - first) * s) * scale, (second + (second_end - second) * s) * scale);
                    let (d_top, d_side) = if first_face == top { (first_leg, second_leg) } else { (second_leg, first_leg) };
                    let (area, moment) = section_moments(d_top, d_side, 1.0);
                    r * area - moment
                });
            assert!((removed - expected).abs() < 5e-5 * expected, "scale {scale} face {first_face}: removed {removed} vs {expected}");
            let (g0, g1, count) = contacts(&shape);
            assert!(count >= 2 && g0 < 1e-6 * diagonal(&shape) && g1 < 1e-4, "scale {scale}: contacts {count} G0 {g0} G1 {g1}");
            // off the 24 stations of the skin: every contact line is read at 129 places
            assert!(least_contact_samples(&shape) >= 129, "the contact lines are read between the stations");
        }
    }
}

#[test]
fn what_cannot_be_built_is_refused_with_the_reason() {
    let _serial = crate::serial_blends();
    let cylinder = make_cylinder(10.0, 20.0).unwrap().unwrap();
    let rim = edges_where(&cylinder, |e| e["curve"] == "circle" && (num(&e["mid"][2]) - 20.0).abs() < 1e-9)[0];
    let (top, bottom) = (plane_face(&cylinder, [0.0, 0.0, 1.0]), plane_face(&cylinder, [0.0, 0.0, -1.0]));
    let why = |shape: &Shape, rows: &[[f64; 6]], kind: f64| blend(shape, rows, kind, 0.5).err().expect("refused");
    let says = |shape: &Shape, rows: &[[f64; 6]], kind: f64, needle: &str| {
        let reason = why(shape, rows, kind);
        assert!(reason.contains(needle), "expected \"{needle}\" in: {reason}");
    };
    says(&cylinder, &[leg_row(rim, top, 25.0, NAN, 1.0, NAN)], 0.0, "reaches past");
    says(&cylinder, &[leg_row(rim, bottom, 1.0, NAN, 2.0, NAN)], 0.0, "side1 is not a face");
    says(&cylinder, &[leg_row(rim, top, 1.0, 2.0, 2.0, 3.0)], 0.0, "no start and end around it");
    says(&cylinder, &[leg_row(rim, top, 0.0, NAN, 2.0, NAN)], 0.0, "> 0");
    says(&cylinder, &[leg_row(99, top, 1.0, NAN, 2.0, NAN)], 0.0, "out of range");
    says(&cylinder, &[leg_row(rim, top, 1.0, NAN, 2.0, NAN), leg_row(rim, top, 1.0, NAN, 2.0, NAN)], 0.0, "twice");
    // edges that meet at a vertex have no corner patch
    let part = make_box([0.0; 3], [20.0, 10.0, 5.0]).unwrap().unwrap();
    let at = |x: f64, y: f64, z: f64| {
        edges_where(&part, |e| {
            (num(&e["mid"][0]) - x).abs() < 1e-9 && (num(&e["mid"][1]) - y).abs() < 1e-9 && (num(&e["mid"][2]) - z).abs() < 1e-9
        })[0]
    };
    let (front_top, left_top) = (at(10.0, 0.0, 5.0), at(0.0, 5.0, 5.0));
    let top_face = plane_face(&part, [0.0, 0.0, 1.0]);
    assert!(why(&part, &[leg_row(front_top, top_face, 1.0, 2.0, 1.0, 2.0), leg_row(left_top, top_face, 1.0, 2.0, 1.0, 2.0)], 0.0)
        .contains("meet at a vertex"));
    // a convex rim and a concave foot in one step add and remove material
    let plate = make_box([-30.0, -30.0, 0.0], [60.0, 60.0, 5.0]).unwrap().unwrap();
    let boss = make_cylinder(5.0, 10.0).unwrap().unwrap();
    let joined = boolean(BooleanOp::Union, &plate, &boss, true).unwrap().unwrap();
    let circle_at = |z: f64| edges_where(&joined, |e| e["curve"] == "circle" && (num(&e["mid"][2]) - z).abs() < 1e-9)[0];
    let joined_top = plane_face(&joined, [0.0, 0.0, 1.0]);
    // the boss top is the smaller of the two faces that face up
    let boss_top = topology(&joined).unwrap()["faces"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .filter(|(_, face)| face["surface"] == "plane" && num(&face["normal"][2]) > 0.99)
        .min_by(|a, b| num(&a.1["area"]).total_cmp(&num(&b.1["area"])))
        .map(|(index, _)| index as u32)
        .unwrap();
    let rows = [leg_row(circle_at(5.0), joined_top, 1.0, NAN, 2.0, NAN), leg_row(circle_at(10.0), boss_top, 1.0, NAN, 2.0, NAN)];
    says(&joined, &rows, 0.0, "is concave");
    // OCCT chamfers a whole tangent chain: a D-shaped plate's arc drags its two tangent straight edges
    let half = boolean(
        BooleanOp::Intersect,
        &make_cylinder(10.0, 5.0).unwrap().unwrap(),
        &make_box([-12.0, 0.0, -1.0], [24.0, 12.0, 7.0]).unwrap().unwrap(),
        true,
    )
    .unwrap()
    .unwrap();
    let square = make_box([-10.0, -10.0, 0.0], [20.0, 10.0, 5.0]).unwrap().unwrap();
    let plate = boolean(BooleanOp::Union, &half, &square, true).unwrap().unwrap();
    let arc = edges_where(&plate, |e| e["curve"] == "circle" && (num(&e["mid"][2]) - 5.0).abs() < 1e-9)[0];
    let reason = why(&plate, &[leg_row(arc, plane_face(&plate, [0.0, 0.0, 1.0]), 1.0, NAN, 2.0, NAN)], 0.0);
    assert!(reason.contains("tangent chain"), "{reason}");
}

mod recipe_level {
    //! The `fillet` node as the evaluator reads it: the leg plan (`size2`, `size2End`, `sideFace`), its build, its report and its refusals.
    use crate::recipe::Evaluator;
    use serde_json::{json, Value};

    fn cylinder_leaf() -> Value {
        json!({ "op": "solid", "entity": { "kind": "cylinder", "radius": 10, "height": 20, "position": [0, 0, 0], "rotation": [0, 0, 0] } })
    }

    fn fillet(radii: Value, extra: Value) -> Value {
        let cylinder = crate::make_cylinder(10.0, 20.0).unwrap().unwrap();
        let rim = super::edges_where(&cylinder, |e| e["curve"] == "circle" && super::num(&e["mid"][2]) > 19.0)[0];
        let mut node = json!({ "op": "fillet", "source": cylinder_leaf(), "edges": [rim], "size": 0, "radii": radii });
        for (key, value) in extra.as_object().unwrap() {
            node[key] = value.clone();
        }
        node
    }

    fn top_face() -> u32 {
        super::plane_face(&crate::make_cylinder(10.0, 20.0).unwrap().unwrap(), [0.0, 0.0, 1.0])
    }

    #[test]
    fn a_leg_pair_on_a_rim_builds_reports_the_leg_builder_and_refuses_what_it_cannot_make() {
        let _serial = crate::serial_blends();
        let mut evaluator = Evaluator::new(16);
        let legs = fillet(json!([{ "size": 1, "size2": 3, "sideFace": top_face() }]), json!({}));
        assert!(evaluator.evaluate(&legs).unwrap().is_some());
        let report = evaluator.blend_report(&legs).unwrap();
        assert_eq!(report["stage"], "none");
        assert_eq!(report["notes"]["builder"], "legs");
        assert_eq!(report["notes"]["chamfer"], "occt", "constant legs take the chamfer of the kernel");
        assert!(report["notes"]["legGap"].as_f64().unwrap() <= report["notes"]["gapLimit"].as_f64().unwrap());
        let conic =
            fillet(json!([{ "size": 1, "size2": 3, "sideFace": top_face() }]), json!({ "profile": { "type": "conic", "rho": 0.5 } }));
        assert!(evaluator.evaluate(&conic).unwrap().is_some());
        // legs that run need a start and an end: a rim has neither, the reason is the builder's
        let running = fillet(json!([{ "size": 1, "sizeEnd": 2, "size2": 2, "sideFace": top_face() }]), json!({}));
        assert!(evaluator.evaluate(&running).unwrap().is_none());
        assert!(evaluator.blend_report(&running).unwrap()["message"].as_str().unwrap().contains("no start and end around it"));
        // control points with a leg, and a leg on only some of the edges, are malformed plans
        let points = fillet(json!([{ "size": 1, "sizes": [{ "t": 0.5, "size": 2 }], "size2": 2, "sideFace": top_face() }]), json!({}));
        assert!(evaluator.evaluate(&points).unwrap().is_none());
        assert!(evaluator.blend_report(&points).unwrap()["message"].as_str().unwrap().contains("malformed"));
        let unsided = fillet(json!([{ "size": 1, "size2": 2 }]), json!({}));
        assert!(evaluator.evaluate(&unsided).unwrap().is_none());
    }
}

/// A cylinder R 10 with two pockets of R 5 centred on (10, 5) and (-10, 5): the small arcs of the top meet the pocket walls (cylinders) square, the pocket arcs
/// meet the top face of the part only where the pocket and the small cylinder cross.
fn bitten_cylinder() -> Shape {
    let place = |x: f64| crate::placed(&make_cylinder(5.0, 7.0).unwrap().unwrap(), [0.0; 3], [x, 5.0, -1.0], [0.0; 3]).unwrap().unwrap();
    let cylinder = make_cylinder(10.0, 5.0).unwrap().unwrap();
    let once = boolean(BooleanOp::Subtract, &cylinder, &place(10.0), true).unwrap().unwrap();
    boolean(BooleanOp::Subtract, &once, &place(-10.0), true).unwrap().unwrap()
}

#[test]
fn an_end_that_is_not_a_square_flat_face_and_a_section_that_leaves_the_solid_are_refused() {
    let _serial = crate::serial_blends();
    let part = bitten_cylinder();
    let top = plane_face(&part, [0.0, 0.0, 1.0]);
    let arcs = edges_where(&part, |e| e["curve"] == "circle" && (num(&e["mid"][2]) - 5.0).abs() < 1e-9);
    let reasons: Vec<String> =
        arcs.iter().filter_map(|arc| blend(&part, &[leg_row(*arc, top, 0.5, NAN, 1.0, NAN)], 0.0, 0.5).err()).collect();
    assert!(reasons.iter().any(|why| why.contains("does not end on a face square to the edge")), "{reasons:?}");
    // a sphere cap with a chord leg of 6 on a radius of 10: the tangent at its contact meets the plane line too far out, the section would leave the sphere
    let ball = make_sphere(10.0).unwrap().unwrap();
    let cut = make_box([-20.0, -20.0, -20.0], [40.0, 40.0, 25.0]).unwrap().unwrap();
    let cap = boolean(BooleanOp::Intersect, &ball, &cut, true).unwrap().unwrap();
    let rim = edges_where(&cap, |e| e["curve"] == "circle" && (num(&e["mid"][2]) - 5.0).abs() < 1e-9)[0];
    let cap_top = plane_face(&cap, [0.0, 0.0, 1.0]);
    let why = blend(&cap, &[leg_row(rim, cap_top, 1.0, NAN, 6.0, NAN)], 0.0, 0.5).err().expect("refused");
    assert!(why.contains("is not between the source's") && why.contains("the section leaves the solid"), "{why}");
    // the same chord at 2 builds
    assert!(blend(&cap, &[leg_row(rim, cap_top, 1.0, NAN, 2.0, NAN)], 0.0, 0.5).is_ok());
}

#[test]
fn a_straight_edge_between_planes_with_constant_legs_stays_with_the_prism_builder() {
    let _serial = crate::serial_blends();
    let part = make_box([0.0; 3], [20.0, 10.0, 5.0]).unwrap().unwrap();
    let edge = edges_where(&part, |e| (num(&e["mid"][2]) - 5.0).abs() < 1e-9 && num(&e["mid"][1]).abs() < 1e-9)[0];
    let top = plane_face(&part, [0.0, 0.0, 1.0]);
    let specs = [f64::from(edge), 0.0, 0.5, 1.0, 2.0, f64::from(top), 0.0];
    let legs = leg_row(edge, top, 1.0, NAN, 2.0, NAN);
    let built = fillet_profile_legs(&part, &specs, &[edge], &[], &legs, 0.0, 0.5).unwrap().expect("builds");
    assert_eq!(crate::features::shape_notes(&built).unwrap(), "{\"builder\":\"prism\"}", "the exact builder is tried first");
    // without the prism specs (legs that run) the leg builder takes the same edge
    let running = built_with_notes(&part, &[leg_row(edge, top, 1.0, 2.0, 2.0, 3.0)]);
    assert!(running.contains("\"builder\":\"legs\""), "{running}");
}

fn built_with_notes(shape: &Shape, rows: &[[f64; 6]]) -> String {
    crate::features::shape_notes(&built(shape, rows, 0.0, 0.5)).unwrap()
}

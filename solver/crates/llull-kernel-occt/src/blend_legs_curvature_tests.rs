//! BLD §13.40: the curvature (G2) profile with two legs (`size2`) on curved edges, curved faces and with legs that run. The removed volume is compared with an
//! integral of the quintic section the test builds itself (poles from the support's normal curvature, written out here), never with the builder's own numbers.

use crate::blend_legs_tests::{
    blend, built, contacts, cylinder_face, diagonal, edges_where, integral, leg_row, num, plane_face, revolved, volume_of, NAN, PI,
};
use crate::{boolean, make_box, make_cylinder, make_sphere, BooleanOp, Shape};

pub(crate) type P = (f64, f64);
const SCALES: [f64; 3] = [1.0, 10.0, 100.0];

pub(crate) fn lerp(from: P, to: P, k: f64) -> P {
    (from.0 + (to.0 - from.0) * k, from.1 + (to.1 - from.1) * k)
}

/// The six poles of the curvature section: A, T, B and the offsets (already scaled to the section) of the 3rd and 4th pole.
pub(crate) fn poles(a: P, t: P, b: P, shape: f64, bend_a: P, bend_b: P) -> [P; 6] {
    let (lead, reach) = (0.8 * shape, 0.4 * shape + 0.6);
    let (pa, pb) = (lerp(a, t, reach), lerp(b, t, reach));
    [a, lerp(a, t, lead), (pa.0 + bend_a.0, pa.1 + bend_a.1), (pb.0 + bend_b.0, pb.1 + bend_b.1), lerp(b, t, lead), b]
}

/// The Bezier curve of degree 5 over `poles` at `n` + 1 points.
pub(crate) fn quintic(poles: &[P; 6], n: usize) -> Vec<P> {
    let binomial = [1.0, 5.0, 10.0, 10.0, 5.0, 1.0];
    (0..=n)
        .map(|k| {
            let u = k as f64 / n as f64;
            poles.iter().enumerate().fold((0.0, 0.0), |sum, (i, p)| {
                let weight = binomial[i] * u.powi(i as i32) * (1.0 - u).powi(5 - i as i32);
                (sum.0 + weight * p.0, sum.1 + weight * p.1)
            })
        })
        .collect()
}

/// The pole offset that gives the section the normal curvature `kappa` of its support at `from` (distance `reach` to the apex): 1.25 kappa lead^2 toward `toward`.
pub(crate) fn bend(kappa: f64, reach: f64, shape: f64, toward: P) -> P {
    let lead = 0.8 * shape * reach;
    let h = 1.25 * kappa * lead * lead;
    (toward.0 * h, toward.1 * h)
}

#[test]
fn a_cylinder_rim_with_a_curvature_section_and_two_legs_removes_the_revolved_quintic_at_every_size() {
    let _serial = crate::serial_blends();
    for scale in SCALES {
        let (r, h) = (10.0 * scale, 20.0 * scale);
        let cylinder = make_cylinder(r, h).unwrap().unwrap();
        let rim = edges_where(&cylinder, |e| e["curve"] == "circle" && (num(&e["mid"][2]) - h).abs() < 1e-9 * scale);
        let (top, side) = (plane_face(&cylinder, [0.0, 0.0, 1.0]), cylinder_face(&cylinder));
        for (d_top, d_side, first_face) in [(1.0, 3.0, top), (3.0, 1.0, top), (1.0, 3.0, side)] {
            let (d_top, d_side) = (d_top * scale, d_side * scale);
            let (size, size2) = if first_face == top { (d_top, d_side) } else { (d_side, d_top) };
            for shape_param in [0.3, 0.5, 0.7] {
                let shape = built(&cylinder, &[leg_row(rim[0], first_face, size, NAN, size2, NAN)], 1.0, shape_param);
                let removed = volume_of(&cylinder) - volume_of(&shape);
                // a plane and a cylinder wall cut along the axis are straight in the section: both normal curvatures are 0
                let (a, t, b) = ((r - d_top, h), (r, h), (r, h - d_side));
                let mut outline = vec![t];
                outline.extend(quintic(&poles(a, t, b, shape_param, (0.0, 0.0), (0.0, 0.0)), 20000));
                let expected = revolved(&outline);
                assert!(
                    (removed - expected).abs() < 3e-6 * expected,
                    "scale {scale} legs {d_top} x {d_side} shape {shape_param}: removed {removed} vs {expected}"
                );
                let (g0, g1, count) = contacts(&shape);
                assert_eq!(count, 2, "the blend touches the top and the side");
                assert!(g0 < 1e-6 * diagonal(&shape) && g1 < 1e-4, "scale {scale}: contacts G0 {g0} G1 {g1}");
            }
        }
    }
}

/// A sphere of radius 10 x scale cut at z = 5 x scale: the corner (rho, z), the plane contact A at d_top, the sphere contact B at the chord d_sphere, the apex T.
fn cap_corner(scale: f64, d_top: f64, d_sphere: f64) -> (P, P, P, P) {
    let r = 10.0 * scale;
    let (rho, z) = ((r * r - 25.0 * scale * scale).sqrt(), 5.0 * scale);
    let to_corner = rho.hypot(z);
    let along = (to_corner * to_corner + r * r - d_sphere * d_sphere) / (2.0 * to_corner);
    let height = (r * r - along * along).sqrt();
    let unit = (rho / to_corner, z / to_corner);
    let candidates = [
        (along * unit.0 + height * -unit.1, along * unit.1 + height * unit.0),
        (along * unit.0 - height * -unit.1, along * unit.1 - height * unit.0),
    ];
    let b = if candidates[0].1 < candidates[1].1 { candidates[0] } else { candidates[1] };
    ((rho, z), (rho - d_top, z), ((r * r - z * b.1) / b.0, z), b)
}

fn sphere_cap(scale: f64) -> (Shape, u32, u32) {
    let r = 10.0 * scale;
    let ball = make_sphere(r).unwrap().unwrap();
    let cut = make_box([-2.0 * r, -2.0 * r, -2.0 * r], [4.0 * r, 4.0 * r, 2.0 * r + 5.0 * scale]).unwrap().unwrap();
    let cap = boolean(BooleanOp::Intersect, &ball, &cut, true).unwrap().unwrap();
    let rim = edges_where(&cap, |e| e["curve"] == "circle" && (num(&e["mid"][2]) - 5.0 * scale).abs() < 1e-9 * scale);
    assert_eq!(rim.len(), 1);
    let top = plane_face(&cap, [0.0, 0.0, 1.0]);
    (cap, rim[0], top)
}

#[test]
fn a_sphere_cap_with_a_curvature_section_takes_the_curvature_of_the_sphere_at_its_contact() {
    let _serial = crate::serial_blends();
    for scale in SCALES {
        let r = 10.0 * scale;
        let (cap, rim, top) = sphere_cap(scale);
        for (d_top, d_sphere) in [(1.0, 2.0), (1.0, 3.0)] {
            let (d_top, d_sphere) = (d_top * scale, d_sphere * scale);
            let (corner, a, t, b) = cap_corner(scale, d_top, d_sphere);
            // the normal of the sphere at B, on the side of A: the sphere curves toward its centre, 1 / r in every direction
            let radial = (b.0 / r, b.1 / r);
            let toward = if radial.0 * (a.0 - b.0) + radial.1 * (a.1 - b.1) > 0.0 { radial } else { (-radial.0, -radial.1) };
            for shape_param in [0.4, 0.5] {
                let reach = (t.0 - b.0).hypot(t.1 - b.1);
                let bent = poles(a, t, b, shape_param, (0.0, 0.0), bend(1.0 / r, reach, shape_param, toward));
                let flat = poles(a, t, b, shape_param, (0.0, 0.0), (0.0, 0.0));
                let volume_with = |section: &[P; 6]| {
                    let mut outline = vec![corner, a];
                    outline.extend(quintic(section, 20000));
                    let (start, end) = (b.1.atan2(b.0), corner.1.atan2(corner.0));
                    outline.extend((0..=20000).map(|k| {
                        let angle = start + (end - start) * f64::from(k) / 20000.0;
                        (r * angle.cos(), r * angle.sin())
                    }));
                    revolved(&outline)
                };
                let shape = built(&cap, &[leg_row(rim, top, d_top, NAN, d_sphere, NAN)], 1.0, shape_param);
                let removed = volume_of(&cap) - volume_of(&shape);
                let (expected, g1_only) = (volume_with(&bent), volume_with(&flat));
                assert!(
                    (removed - expected).abs() < 1e-5 * expected,
                    "scale {scale} legs {d_top} x {d_sphere} shape {shape_param}: removed {removed} vs {expected}"
                );
                // the curvature matters: the section without the bend would remove measurably another volume
                assert!(
                    (expected - g1_only).abs() > 20.0 * 1e-5 * expected,
                    "legs {d_top} x {d_sphere}: bend changes the volume by {}",
                    (expected - g1_only).abs() / expected
                );
                let (g0, g1, count) = contacts(&shape);
                assert!(count >= 2 && g0 < 1e-6 * diagonal(&shape) && g1 < 1e-4, "scale {scale}: contacts {count} G0 {g0} G1 {g1}");
            }
        }
    }
}

/// Area and first moment about the wall (x) of the curvature section of a right-angle corner, local coordinates (corner at 0, A = (d1, 0), B = (0, d2)).
fn section_moments(d1: f64, d2: f64, shape: f64) -> (f64, f64) {
    let mut outline = vec![(0.0, 0.0)];
    outline.extend(quintic(&poles((d1, 0.0), (0.0, 0.0), (0.0, d2), shape, (0.0, 0.0), (0.0, 0.0)), 4000));
    let (mut area, mut moment) = (0.0, 0.0);
    for k in 0..outline.len() {
        let (p, q) = (outline[k], outline[(k + 1) % outline.len()]);
        let cross = p.0 * q.1 - q.0 * p.1;
        area += 0.5 * cross;
        moment += (p.0 + q.0) * cross / 6.0;
    }
    (area.abs(), moment.abs())
}

#[test]
fn running_legs_with_a_curvature_section_remove_the_integral_of_the_quintic_on_a_straight_edge_and_an_arc() {
    let _serial = crate::serial_blends();
    for scale in [1.0, 10.0] {
        let part = make_box([0.0; 3], [20.0 * scale, 10.0 * scale, 5.0 * scale]).unwrap().unwrap();
        let edge = edges_where(&part, |e| (num(&e["mid"][2]) - 5.0 * scale).abs() < 1e-9 * scale && num(&e["mid"][1]).abs() < 1e-9 * scale);
        let (top, front) = (plane_face(&part, [0.0, 0.0, 1.0]), plane_face(&part, [0.0, -1.0, 0.0]));
        for (side, first, first_end, second, second_end) in [(top, 1.0, 2.0, 2.0, 3.0), (front, 2.0, 1.0, 1.0, 2.0)] {
            let shape =
                built(&part, &[leg_row(edge[0], side, first * scale, first_end * scale, second * scale, second_end * scale)], 1.0, 0.5);
            let removed = volume_of(&part) - volume_of(&shape);
            let expected = 20.0
                * scale
                * integral(|s| {
                    section_moments((first + (first_end - first) * s) * scale, (second + (second_end - second) * s) * scale, 0.5).0
                });
            assert!((removed - expected).abs() < 1e-6 * expected, "scale {scale} side {side}: removed {removed} vs {expected}");
            let (g0, g1, _) = contacts(&shape);
            assert!(g0 < 1e-6 * diagonal(&shape) && g1 < 1e-4, "scale {scale}: contacts G0 {g0} G1 {g1}");
        }
        // a half disc: legs that run along the arc, on the top and on the wall
        let (r, h) = (20.0 * scale, 10.0 * scale);
        let cylinder = make_cylinder(r, h).unwrap().unwrap();
        let half = make_box([-2.0 * r, 0.0, -scale], [4.0 * r, 2.0 * r, h + 2.0 * scale]).unwrap().unwrap();
        let disc = boolean(BooleanOp::Intersect, &cylinder, &half, true).unwrap().unwrap();
        let arc = edges_where(&disc, |e| e["curve"] == "circle" && (num(&e["mid"][2]) - h).abs() < 1e-9 * scale)[0];
        let (disc_top, wall) = (plane_face(&disc, [0.0, 0.0, 1.0]), cylinder_face(&disc));
        for (first_face, first, first_end, second, second_end) in [(disc_top, 1.0, 2.0, 2.0, 3.0), (wall, 1.0, 2.0, 2.0, 3.0)] {
            let shape =
                built(&disc, &[leg_row(arc, first_face, first * scale, first_end * scale, second * scale, second_end * scale)], 1.0, 0.5);
            let removed = volume_of(&disc) - volume_of(&shape);
            let expected = PI
                * integral(|s| {
                    let (first_leg, second_leg) = ((first + (first_end - first) * s) * scale, (second + (second_end - second) * s) * scale);
                    let (d_top, d_wall) = if first_face == disc_top { (first_leg, second_leg) } else { (second_leg, first_leg) };
                    let (area, moment) = section_moments(d_top, d_wall, 0.5);
                    r * area - moment
                });
            assert!((removed - expected).abs() < 5e-5 * expected, "scale {scale} face {first_face}: removed {removed} vs {expected}");
            let (g0, g1, _) = contacts(&shape);
            assert!(g0 < 1e-6 * diagonal(&shape) && g1 < 1e-4, "scale {scale}: contacts G0 {g0} G1 {g1}");
        }
    }
}

#[test]
fn a_curvature_section_with_no_g2_solution_is_refused_with_the_measured_reason() {
    let _serial = crate::serial_blends();
    // a convex cap: legs 1 x 3 with a large shape push the section past the sphere between the contacts (the volume window)
    let (cap, rim, top) = sphere_cap(1.0);
    let row = [leg_row(rim, top, 1.0, NAN, 3.0, NAN)];
    assert!(blend(&cap, &row, 1.0, 0.5).is_ok());
    let why = blend(&cap, &row, 1.0, 0.9).err().expect("refused");
    assert!(why.contains("is not between the source's") && why.contains("another shape, or a conic profile"), "{why}");
    // the same corner with a conic builds: the refusal is the curvature condition's
    assert!(blend(&cap, &row, 0.0, 0.5).is_ok());

    // a ball (R 5, centre 2 above the plate top) on a plate: the sphere curves away from the corner (normal curvature -0.2), so a G2 section starts out of the
    // triangle of its tangent lines: refused with the offsets that curvature needs, built when the shape keeps that departure below the tolerance
    let plate = make_box([-30.0, -30.0, 0.0], [60.0, 60.0, 5.0]).unwrap().unwrap();
    let ball = crate::placed(&make_sphere(5.0).unwrap().unwrap(), [0.0; 3], [0.0, 0.0, 7.0], [0.0; 3]).unwrap().unwrap();
    let part = boolean(BooleanOp::Union, &plate, &ball, true).unwrap().unwrap();
    let foot = edges_where(&part, |e| e["curve"] == "circle" && (num(&e["mid"][2]) - 5.0).abs() < 1e-9);
    assert_eq!(foot.len(), 1);
    let on_plate = plate_face(&part);
    let legs = [leg_row(foot[0], on_plate, 1.0, NAN, 3.0, NAN)];
    let why = blend(&part, &legs, 1.0, 0.5).err().expect("refused");
    assert!(
        why.contains("leaves the triangle of its tangent lines by 0.12")
            && why.contains("normal curvatures 0 and -0.2")
            && why.contains("pole offsets of 0 and -0.37"),
        "{why}"
    );
    // the departure grows with the shape: legs 1 x 3 on a ball of 10 touching the plate at its equator build at 0.1 and are refused at 0.5
    let equator = crate::placed(&make_sphere(10.0).unwrap().unwrap(), [0.0; 3], [0.0, 0.0, 5.0], [0.0; 3]).unwrap().unwrap();
    let tangent_part = boolean(BooleanOp::Union, &plate, &equator, true).unwrap().unwrap();
    let seam = edges_where(&tangent_part, |e| e["curve"] == "circle" && (num(&e["mid"][2]) - 5.0).abs() < 1e-9);
    let row = [leg_row(seam[0], plate_face(&tangent_part), 1.0, NAN, 3.0, NAN)];
    assert!(blend(&tangent_part, &row, 1.0, 0.1).is_ok());
    assert!(blend(&tangent_part, &row, 1.0, 0.5).err().expect("refused").contains("leaves the triangle"));
}

fn plate_face(shape: &Shape) -> u32 {
    plane_face(shape, [0.0, 0.0, 1.0])
}

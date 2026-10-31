//! BLD §13.40: curvature (G2) sections with two legs where BOTH supports bend (a lens of two spheres), where the curved support is concave (a spherical dimple),
//! on a concave foot (a boss on a plate), and G2 read between the stations (small legs on a large cap). Oracles: revolved outlines (Green's theorem) built here
//! from the circles of the supports; the normal-curvature jump across the contacts is read with `edge_continuity` at samples that are not the stations.

use crate::blend_legs_curvature_tests::{bend, poles, quintic, P};
use crate::blend_legs_tests::{built, contacts, diagonal, edges_where, leg_row, num, plane_face, revolved, volume_of, NAN};
use crate::queries::{edge_continuity, topology};
use crate::{boolean, make_box, make_cylinder, make_sphere, placed, BooleanOp, Shape};

/// The two points of the circle (centre `c`, radius `r`) at distance `d` from `p`.
fn meet(c: P, r: f64, p: P, d: f64) -> [P; 2] {
    let (dx, dy) = (p.0 - c.0, p.1 - c.1);
    let dist = dx.hypot(dy);
    let a = (dist * dist + r * r - d * d) / (2.0 * dist);
    let h = (r * r - a * a).sqrt();
    let u = (dx / dist, dy / dist);
    let m = (c.0 + a * u.0, c.1 + a * u.1);
    [(m.0 - h * u.1, m.1 + h * u.0), (m.0 + h * u.1, m.1 - h * u.0)]
}

/// The meeting point of the line through `p` along `dp` and the line through `q` along `dq`.
fn line_meet(p: P, dp: P, q: P, dq: P) -> P {
    let det = -dp.0 * dq.1 + dq.0 * dp.1;
    let s = ((q.0 - p.0) * -dq.1 + dq.0 * (q.1 - p.1)) / det;
    (p.0 + s * dp.0, p.1 + s * dp.1)
}

/// The tangent direction of the circle about `c` at `p`.
fn tangent(c: P, p: P) -> P {
    (-(p.1 - c.1), p.0 - c.0)
}

/// The pole offset of a sphere contact `p` (centre `c`, radius `r`, apex `t`): toward the centre by 1.25 / r lead^2.
fn toward_centre(c: P, r: f64, p: P, t: P, shape: f64) -> P {
    let reach = (t.0 - p.0).hypot(t.1 - p.1);
    bend(1.0 / r, reach, shape, ((c.0 - p.0) / r, (c.1 - p.1) / r))
}

/// The arc about `c` from `from` to `to` (both on one circle), 20001 points.
fn arc(c: P, from: P, to: P) -> Vec<P> {
    let radius = (from.0 - c.0).hypot(from.1 - c.1);
    let (start, end) = ((from.1 - c.1).atan2(from.0 - c.0), (to.1 - c.1).atan2(to.0 - c.0));
    (0..=20000)
        .map(|k| {
            let angle = start + (end - start) * f64::from(k) / 20000.0;
            (c.0 + radius * angle.cos(), c.1 + radius * angle.sin())
        })
        .collect()
}

/// The largest normal-curvature jump between the blend and its supports over the contact lines read at `count` samples, split into the samples whose index is a
/// multiple of `every` (the stations, when `every` x 24 = count - 1) and the others; and the number of contact lines read.
pub(crate) fn curvature_jumps(shape: &Shape, count: f64, every: usize) -> (f64, f64, usize) {
    let edges = topology(shape).unwrap()["edges"].as_array().unwrap().len();
    let (mut on, mut off, mut lines) = (0.0_f64, 0.0_f64, 0);
    for edge in 0..edges {
        let Some(samples) = edge_continuity(shape, edge as f64, count).unwrap().as_array().cloned() else { continue };
        if samples.iter().any(|sample| num(&sample["g1"]) > 0.5) {
            continue;
        }
        lines += 1;
        for (k, sample) in samples.iter().enumerate() {
            let jump = (num(&sample["normalCurvature"][0]) - num(&sample["normalCurvature"][1])).abs();
            if k % every == 0 {
                on = on.max(jump);
            } else {
                off = off.max(jump);
            }
        }
    }
    (on, off, lines)
}

fn sphere_at(radius: f64, centre_z: f64) -> Shape {
    placed(&make_sphere(radius).unwrap().unwrap(), [0.0; 3], [0.0, 0.0, centre_z], [0.0; 3]).unwrap().unwrap()
}

#[test]
fn a_lens_of_two_spheres_takes_the_curvature_of_both_supports() {
    let _serial = crate::serial_blends();
    for scale in [3.0, 10.0] {
        let r = 10.0 * scale;
        let lens = boolean(BooleanOp::Intersect, &sphere_at(r, -3.0 * scale), &sphere_at(r, 3.0 * scale), true).unwrap().unwrap();
        let rim = edges_where(&lens, |e| e["curve"] == "circle" && e["mid"][2].as_f64().is_some_and(|z| z.abs() < 1e-9));
        assert_eq!(rim.len(), 1);
        // the lens is symmetric: whichever sphere carries the first leg, the removed volume is the mirror image
        let upper = 0;
        let (c1, c2): (P, P) = ((0.0, -3.0 * scale), (0.0, 3.0 * scale));
        let corner: P = ((r * r - 9.0 * scale * scale).sqrt(), 0.0);
        for (d1, d2, shape) in [(1.0 * scale, 2.0 * scale, 0.5), (1.5 * scale, 1.5 * scale, 0.4), (0.8 * scale, 2.5 * scale, 0.5)] {
            let a = meet(c1, r, corner, d1).into_iter().find(|p| p.1 > 0.0).unwrap();
            let b = meet(c2, r, corner, d2).into_iter().find(|p| p.1 < 0.0).unwrap();
            let t = line_meet(a, tangent(c1, a), b, tangent(c2, b));
            let section = poles(a, t, b, shape, toward_centre(c1, r, a, t, shape), toward_centre(c2, r, b, t, shape));
            let mut outline = arc(c1, corner, a);
            outline.extend(quintic(&section, 20000));
            outline.extend(arc(c2, b, corner));
            let expected = revolved(&outline);
            let mut flat_outline = arc(c1, corner, a);
            flat_outline.extend(quintic(&poles(a, t, b, shape, (0.0, 0.0), (0.0, 0.0)), 20000));
            flat_outline.extend(arc(c2, b, corner));
            let unbent = revolved(&flat_outline);
            let shape_built = built(&lens, &[leg_row(rim[0], upper, d1, NAN, d2, NAN)], 1.0, shape);
            let removed = volume_of(&lens) - volume_of(&shape_built);
            // the mass-property integration of the source (a sphere pair) is good to about 5e-7 of its volume: that bounds the difference of two such volumes
            let slack = (1e-5 * expected).max(1e-6 * volume_of(&lens));
            assert!((unbent - expected).abs() > 5.0 * slack, "the bend changes the volume by {}", (unbent - expected).abs());
            assert!((removed - expected).abs() < slack, "legs {d1} x {d2} shape {shape}: removed {removed} vs {expected}");
            let (g0, g1, count) = contacts(&shape_built);
            assert!(count >= 2 && g0 < 1e-6 * diagonal(&shape_built) && g1 < 1e-4, "contacts {count} G0 {g0} G1 {g1}");
            // G2 at both ends, at the stations (every 4th of 97 samples = the 24 intervals) and between them
            let (on, off, lines) = curvature_jumps(&shape_built, 97.0, 4);
            assert_eq!(lines, 2);
            assert!(on * r < 0.02 && off * r < 0.02, "normal-curvature jump x R: stations {} between {}", on * r, off * r);
        }
    }
}

#[test]
fn a_spherical_dimple_with_a_curvature_section_removes_the_revolved_quintic_bent_toward_the_centre() {
    let _serial = crate::serial_blends();
    let (r, centre): (f64, P) = (10.0, (0.0, 6.0));
    let plate = make_box([-12.0, -12.0, -6.0], [24.0, 24.0, 6.0]).unwrap().unwrap();
    let part = boolean(BooleanOp::Subtract, &plate, &sphere_at(r, centre.1), true).unwrap().unwrap();
    let rim = edges_where(&part, |e| e["curve"] == "circle" && num(&e["mid"][2]).abs() < 1e-9);
    assert_eq!(rim.len(), 1);
    let top = plane_face(&part, [0.0, 0.0, 1.0]);
    let corner: P = ((r * r - 36.0_f64).sqrt(), 0.0);
    for (d_top, d_dimple, shape) in [(1.0, 2.0, 0.2), (0.5, 1.0, 0.1)] {
        let a = (corner.0 + d_top, 0.0);
        let b = meet(centre, r, corner, d_dimple).into_iter().find(|p| p.1 < 0.0).unwrap();
        let t = line_meet(a, (1.0, 0.0), b, tangent(centre, b));
        let section = poles(a, t, b, shape, (0.0, 0.0), toward_centre(centre, r, b, t, shape));
        let mut outline = vec![corner];
        outline.extend(quintic(&section, 20000));
        outline.extend(arc(centre, b, corner));
        let expected = revolved(&outline);
        let shape_built = built(&part, &[leg_row(rim[0], top, d_top, NAN, d_dimple, NAN)], 1.0, shape);
        let removed = volume_of(&part) - volume_of(&shape_built);
        assert!((removed - expected).abs() < 3e-5 * expected, "legs {d_top} x {d_dimple}: removed {removed} vs {expected}");
        let (on, off, lines) = curvature_jumps(&shape_built, 97.0, 4);
        assert_eq!(lines, 2);
        assert!(on * r < 0.02 && off * r < 0.02, "normal-curvature jump x R: stations {} between {}", on * r, off * r);
    }
}

#[test]
fn a_boss_foot_with_a_curvature_section_adds_the_revolved_quintic() {
    let _serial = crate::serial_blends();
    let plate = make_box([-30.0, -30.0, 0.0], [60.0, 60.0, 5.0]).unwrap().unwrap();
    let boss = make_cylinder(5.0, 10.0).unwrap().unwrap();
    let part = boolean(BooleanOp::Union, &plate, &boss, true).unwrap().unwrap();
    let foot = edges_where(&part, |e| e["curve"] == "circle" && (num(&e["mid"][2]) - 5.0).abs() < 1e-9);
    assert_eq!(foot.len(), 1);
    let top = plane_face(&part, [0.0, 0.0, 1.0]);
    for (d_plate, d_boss, shape) in [(1.5, 3.0, 0.5), (3.0, 1.0, 0.3)] {
        // the plate leg runs outward along z = 5 from the wall, the boss leg up the wall; both supports are straight in the meridian plane
        let (a, t, b): (P, P, P) = ((5.0 + d_plate, 5.0), (5.0, 5.0), (5.0, 5.0 + d_boss));
        let mut outline = vec![t];
        outline.extend(quintic(&poles(a, t, b, shape, (0.0, 0.0), (0.0, 0.0)), 20000));
        let expected = revolved(&outline);
        let shape_built = built(&part, &[leg_row(foot[0], top, d_plate, NAN, d_boss, NAN)], 1.0, shape);
        let added = volume_of(&shape_built) - volume_of(&part);
        assert!((added - expected).abs() < 3e-6 * expected, "legs {d_plate} x {d_boss} shape {shape}: added {added} vs {expected}");
        let (g0, g1, count) = contacts(&shape_built);
        assert!(count >= 2 && g0 < 1e-6 * diagonal(&shape_built) && g1 < 1e-4, "contacts {count} G0 {g0} G1 {g1}");
        let (on, off, _) = curvature_jumps(&shape_built, 97.0, 4);
        assert!(on * 5.0 < 0.02 && off * 5.0 < 0.02, "jump x R: stations {} between {}", on * 5.0, off * 5.0);
    }
}

#[test]
fn g2_holds_between_the_stations_with_small_legs_on_a_large_cap() {
    let _serial = crate::serial_blends();
    // R 100 cut at z = 50 (diagonal about 300), legs 0.1 and 0.3 (0.05 x 0.15 is not buildable by the OCCT chamfer): the pole offset is about 2e-4, close to the 1e-8 x diagonal pole criterion of the skin
    let r = 100.0;
    let cap = boolean(
        BooleanOp::Intersect,
        &make_sphere(r).unwrap().unwrap(),
        &make_box([-2.0 * r, -2.0 * r, -2.0 * r], [4.0 * r, 4.0 * r, 2.0 * r + 50.0]).unwrap().unwrap(),
        true,
    )
    .unwrap()
    .unwrap();
    assert!(diagonal(&cap) > 250.0);
    let rim = edges_where(&cap, |e| e["curve"] == "circle" && (num(&e["mid"][2]) - 50.0).abs() < 1e-9);
    let top = plane_face(&cap, [0.0, 0.0, 1.0]);
    for shape in [0.3, 0.5] {
        let shape_built = built(&cap, &[leg_row(rim[0], top, 0.1, NAN, 0.3, NAN)], 1.0, shape);
        let (on, off, lines) = curvature_jumps(&shape_built, 97.0, 4);
        assert_eq!(lines, 2);
        // the curvature of the sphere is 0.01: the jump relative to it, at the 25 stations and at the 72 samples between them
        assert!(on * r < 0.02 && off * r < 0.02, "shape {shape}: jump x R stations {} between {}", on * r, off * r);
    }
}

#[test]
fn a_concave_foot_whose_ball_overhangs_the_plate_builds_in_every_profile() {
    let _serial = crate::serial_blends();
    // Ball R 5 centred 2 above the plate top: the sphere leans outward over the foot, so the outward normal at the foot points down into the plate material.
    let (r, centre): (f64, P) = (5.0, (0.0, 7.0));
    let plate = make_box([-12.0, -12.0, 0.0], [24.0, 24.0, 5.0]).unwrap().unwrap();
    let part = boolean(BooleanOp::Union, &plate, &sphere_at(r, centre.1), true).unwrap().unwrap();
    let foot = edges_where(&part, |e| e["curve"] == "circle" && (num(&e["mid"][2]) - 5.0).abs() < 1e-9);
    assert_eq!(foot.len(), 1);
    let top = plane_face(&part, [0.0, 0.0, 1.0]);
    let corner: P = ((r * r - 4.0_f64).sqrt(), 5.0);
    for (d_plate, d_ball) in [(1.0, 2.0), (2.0, 1.0)] {
        let a = (corner.0 + d_plate, 5.0);
        let b = meet(centre, r, corner, d_ball).into_iter().find(|p| p.1 > 5.0).unwrap();
        let t = line_meet(a, (1.0, 0.0), b, tangent(centre, b));
        let weight_circular = {
            let (u, v) = ((a.0 - t.0, a.1 - t.1), (b.0 - t.0, b.1 - t.1));
            ((u.0 * v.0 + u.1 * v.1) / (u.0.hypot(u.1) * v.0.hypot(v.1))).acos() / 2.0
        }
        .sin();
        let shape = 0.2;
        let sections: [(f64, f64, Vec<P>); 3] = [
            (0.0, 0.5, crate::blend_legs_tests::conic(a, t, b, 1.0, 20000)),
            (2.0, 0.0, crate::blend_legs_tests::conic(a, t, b, weight_circular, 20000)),
            (1.0, shape, quintic(&poles(a, t, b, shape, (0.0, 0.0), toward_centre(centre, r, b, t, shape)), 20000)),
        ];
        for (kind, param, curve) in sections {
            let mut outline = vec![corner];
            outline.extend(curve);
            outline.extend(arc(centre, b, corner));
            let expected = revolved(&outline);
            let shape_built = built(&part, &[leg_row(foot[0], top, d_plate, NAN, d_ball, NAN)], kind, param);
            let added = volume_of(&shape_built) - volume_of(&part);
            // the source is 3400 mm3: its mass-property integration bounds the difference to about 1e-6 of that
            let slack = (1e-5 * expected).max(1e-6 * volume_of(&part));
            assert!((added - expected).abs() < slack, "kind {kind} legs {d_plate} x {d_ball}: added {added} vs {expected}");
            let (g0, g1, count) = contacts(&shape_built);
            assert!(count >= 2 && g0 < 1e-6 * diagonal(&shape_built) && g1 < 1e-4, "kind {kind}: contacts {count} G0 {g0} G1 {g1}");
        }
    }
}

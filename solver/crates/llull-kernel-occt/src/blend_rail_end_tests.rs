//! BLD M2 oblique ends of the rail builder (13.35, `cpp/blend_rail_ends.cxx`): a curved edge or a varying size that ends on a flat face which is not
//! square to the blend. The skin runs past the end and is cut by the end plane, so the removed volume is the integral of the spandrel over the part of
//! the section that lies on the solid's side of the plane, and the circular profile (the conic of weight cos 45 degrees) is OCCT's own fillet.

use crate::features::{fillet, fillet_laws, fillet_profile_blend, prism_of_face, profile_blend_reason};
use crate::queries::{edge_continuity, topology};
use crate::{boolean, make_box, make_cylinder, mass_properties, BooleanOp, Shape};
use serde_json::Value;

pub(crate) const NAN: f64 = f64::NAN;
pub(crate) const PI: f64 = std::f64::consts::PI;
/// param / (1 - param) = cos 45 degrees: the conic that is the circle at a right angle.
pub(crate) const CIRCLE_PARAM: f64 = 0.414_213_562_373_095_1;

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

pub(crate) fn diagonal(shape: &Shape) -> f64 {
    let bounds = mass_properties(shape).unwrap().bounds;
    (0..3).map(|axis| (bounds[3 + axis] - bounds[axis]).powi(2)).sum::<f64>().sqrt()
}

pub(crate) fn near(a: f64, b: f64, tolerance: f64) -> bool {
    (a - b).abs() <= tolerance * b.abs().max(1.0)
}

pub(crate) fn blend(shape: &Shape, edges: &[u32], laws: &[f64], kind: f64, param: f64) -> Result<Shape, String> {
    match fillet_profile_blend(shape, &[], edges, laws, kind, param).unwrap() {
        Some(built) => Ok(built),
        None => Err(profile_blend_reason(shape, &[], edges, laws, kind, param).unwrap()),
    }
}

pub(crate) fn built(shape: &Shape, edges: &[u32], laws: &[f64], kind: f64, param: f64) -> Shape {
    blend(shape, edges, laws, kind, param).unwrap_or_else(|why| panic!("refused: {why}"))
}

/// Largest position and tangent gaps over every edge shared by two faces that meet tangentially (the contact lines of the blend), and how many there are.
pub(crate) fn contacts(shape: &Shape) -> (f64, f64, usize) {
    let count = topology(shape).unwrap()["edges"].as_array().unwrap().len();
    let (mut g0, mut g1, mut found) = (0.0_f64, 0.0_f64, 0);
    for edge in 0..count {
        let Some(samples) = edge_continuity(shape, edge as f64, 9.0).unwrap().as_array().cloned() else { continue };
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

pub(crate) fn face_count(shape: &Shape) -> usize {
    topology(shape).unwrap()["faces"].as_array().unwrap().len()
}

/// The area of the single planar face with outward normal `normal`; a split or missing end face fails.
pub(crate) fn end_area(shape: &Shape, normal: [f64; 3]) -> f64 {
    let areas: Vec<f64> = topology(shape).unwrap()["faces"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|face| face["surface"] == "plane" && (0..3).map(|k| num(&face["normal"][k]) * normal[k]).sum::<f64>() > 1.0 - 1e-9)
        .map(|face| num(&face["area"]))
        .collect();
    assert_eq!(areas.len(), 1, "end face {normal:?}: {areas:?}");
    areas[0]
}

const GAUSS_NODES: [f64; 4] = [0.183_434_642_495_649_8, 0.525_532_409_916_329, 0.796_666_477_413_626_7, 0.960_289_856_497_536_3];
const GAUSS_WEIGHTS: [f64; 4] = [0.362_683_783_378_362, 0.313_706_645_877_887_3, 0.222_381_034_453_374_5, 0.101_228_536_290_376_3];

/// Composite 8-point Gauss-Legendre rule of `f` on [a, b] in `panels` equal panels.
pub(crate) fn gauss(f: &dyn Fn(f64) -> f64, a: f64, b: f64, panels: usize) -> f64 {
    let width = (b - a) / panels as f64;
    let mut sum = 0.0;
    for p in 0..panels {
        let (lo, hi) = (a + width * p as f64, a + width * (p + 1) as f64);
        let (mid, half) = (0.5 * (lo + hi), 0.5 * (hi - lo));
        for (node, weight) in GAUSS_NODES.iter().zip(GAUSS_WEIGHTS) {
            sum += weight * half * (f(mid + half * node) + f(mid - half * node));
        }
    }
    sum
}

/// Which spandrel of a rim: the corner is at radius `radius` and height `corner_z`; the section runs inward and down (`convex`: the rim of a cylinder top)
/// or outward and up (concave: the ring around the foot of a boss).
#[derive(Clone, Copy)]
pub(crate) struct Rim {
    pub(crate) radius: f64,
    pub(crate) corner_z: f64,
    pub(crate) convex: bool,
}

/// The volume of the revolved spandrel of a section, on the solid's side `x cos(tilt) + z sin(tilt) <= c` of a plane parallel to y. The spandrel is
/// 0 <= x <= d (the distance from the corner along the top / base), 0 <= y <= y_max(x) (the distance from the corner along the wall); the curve is given
/// through a parameter t in [0, 1] as (x, y_max, |dx/dt|). A point at radius rho is kept for the angles with rho cos(phi) cos(tilt) <= c - z sin(tilt).
fn revolved_cut(rim: Rim, tilt: f64, c: f64, curve: &dyn Fn(f64) -> (f64, f64, f64)) -> f64 {
    let sign = if rim.convex { -1.0 } else { 1.0 };
    let angle = |rho: f64, z: f64| {
        let q = ((c - z * tilt.sin()) / (rho * tilt.cos())).clamp(-1.0, 1.0);
        2.0 * PI - 2.0 * q.acos()
    };
    gauss(
        &|t| {
            let (x, y_max, speed) = curve(t);
            let rho = rim.radius + sign * x;
            speed * gauss(&|y| rho * angle(rho, rim.corner_z + sign * y), 0.0, y_max, 1)
        },
        0.0,
        1.0,
        16,
    )
}

/// The circular spandrel of radius r.
pub(crate) fn circle_curve(r: f64) -> impl Fn(f64) -> (f64, f64, f64) {
    move |t| {
        let theta = 0.5 * PI * t;
        (r * (1.0 - theta.sin()), r * (1.0 - theta.cos()), r * theta.cos() * 0.5 * PI)
    }
}

/// The parabola (rho 0.5) with legs d: sqrt(x / d) + sqrt(y / d) <= 1.
pub(crate) fn parabola_curve(d: f64) -> impl Fn(f64) -> (f64, f64, f64) {
    move |t| (d * t * t, d * (1.0 - t) * (1.0 - t), 2.0 * d * t)
}

/// The prism of the polygon `points` (x, z) in the plane y = 15 along -y by `depth`.
fn xz_prism(points: &[[f64; 2]], depth: f64) -> Shape {
    let mut chain = Vec::new();
    for k in 0..points.len() {
        let (a, b) = (points[k], points[(k + 1) % points.len()]);
        chain.extend([0.0, a[0], depth / 2.0, a[1], b[0], depth / 2.0, b[1]]);
    }
    prism_of_face(&crate::features::chain_face(&chain).unwrap().unwrap(), [0.0, -depth, 0.0]).unwrap().unwrap()
}

/// `shape` kept on the side `x cos(tilt) + z sin(tilt) <= c` of a plane parallel to y.
fn keep_side(shape: &Shape, tilt: f64, c: f64) -> Shape {
    keep_side_scaled(shape, tilt, c, 1.0)
}

/// `keep_side` for a part `scale` times larger (the cutter is scaled with it).
fn keep_side_scaled(shape: &Shape, tilt: f64, c: f64, scale: f64) -> Shape {
    let (cos, sin) = (tilt.cos(), tilt.sin());
    let far = 60.0 * scale;
    let on = [c * cos, c * sin];
    let (along, normal) = ([-sin, cos], [cos, sin]);
    let corner = |s: f64, n: f64| [on[0] + along[0] * s * far + normal[0] * n * far, on[1] + along[1] * s * far + normal[1] * n * far];
    let cutter = xz_prism(&[corner(1.0, 0.0), corner(-1.0, 0.0), corner(-1.0, -1.0), corner(1.0, -1.0)], 30.0 * scale);
    boolean(BooleanOp::Intersect, shape, &cutter, false).unwrap().unwrap()
}

/// The cylinder of radius 8 and height 3 on the z axis cut by the plane.
fn cut_cylinder(tilt: f64, c: f64) -> Shape {
    keep_side(&make_cylinder(8.0, 3.0).unwrap().unwrap(), tilt, c)
}

/// A plate (z from -5 to 0) with a boss of radius 10 (z up to 15), cut by the plane.
fn cut_boss(tilt: f64, c: f64) -> Shape {
    let plate = make_box([-30.0, -30.0, -5.0], [60.0, 60.0, 5.0]).unwrap().unwrap();
    let boss = make_cylinder(10.0, 15.0).unwrap().unwrap();
    keep_side(&boolean(BooleanOp::Union, &plate, &boss, true).unwrap().unwrap(), tilt, c)
}

fn rim_edge(shape: &Shape, z: f64) -> Vec<u32> {
    edges_where(shape, |e| e["curve"] == "circle" && (num(&e["mid"][2]) - z).abs() < 1e-3)
}

#[test]
fn a_circular_rim_ending_on_a_tilted_plane_is_the_integral_of_the_spandrel_and_the_circular_fillet() {
    let _serial = crate::serial_blends();
    let r = 1.0;
    let rim = Rim { radius: 8.0, corner_z: 3.0, convex: true };
    // the end plane leaves the rim arc at an angle even when it is vertical (tilt 0), and leans over or under the blend for the other two
    for tilt in [0.0_f64, 0.3, -0.3] {
        let part = cut_cylinder(tilt, 3.0);
        let edge = rim_edge(&part, 3.0);
        assert_eq!(edge.len(), 1, "tilt {tilt}");
        let shape = built(&part, &edge, &[r, NAN, 0.0, 0.0], 0.0, CIRCLE_PARAM);
        let removed = volume_of(&part) - volume_of(&shape);
        let expected = revolved_cut(rim, tilt, 3.0, &circle_curve(r));
        assert!(near(removed, expected, 1e-6), "tilt {tilt}: removed {removed} expected {expected}");
        let occt = fillet(&part, &edge, r, None).unwrap().unwrap();
        assert!(near(volume_of(&shape), volume_of(&occt), 1e-6), "tilt {tilt}: {} vs OCCT {}", volume_of(&shape), volume_of(&occt));
        let (g0, g1, found) = contacts(&shape);
        assert_eq!(found, 2, "tilt {tilt}");
        assert!(g0 < 1e-6 * diagonal(&shape) && g1 < 1e-3, "tilt {tilt}: g0 {g0} g1 {g1}");
        // the blend is one new face; the end face stays ONE planar face and loses the part of the section on its plane
        assert_eq!(face_count(&shape), face_count(&part) + 1, "tilt {tilt}");
        let normal = [tilt.cos(), 0.0, tilt.sin()];
        assert!(end_area(&shape, normal) < end_area(&part, normal), "tilt {tilt}");
        // the source is untouched
        assert!(near(volume_of(&cut_cylinder(tilt, 3.0)), volume_of(&part), 1e-12));
    }
}

#[test]
fn a_parabolic_rim_ending_on_a_tilted_plane_is_the_integral_of_the_spandrel() {
    let _serial = crate::serial_blends();
    let (d, rim) = (1.0, Rim { radius: 8.0, corner_z: 3.0, convex: true });
    for tilt in [0.3_f64, -0.3] {
        let part = cut_cylinder(tilt, 3.0);
        let edge = rim_edge(&part, 3.0);
        let shape = built(&part, &edge, &[d, NAN, 0.0, 0.0], 0.0, 0.5);
        let removed = volume_of(&part) - volume_of(&shape);
        let expected = revolved_cut(rim, tilt, 3.0, &parabola_curve(d));
        assert!(near(removed, expected, 5e-6), "tilt {tilt}: removed {removed} expected {expected}");
        let (g0, g1, found) = contacts(&shape);
        assert_eq!(found, 2);
        assert!(g0 < 1e-6 * diagonal(&shape) && g1 < 1e-3, "tilt {tilt}: g0 {g0} g1 {g1}");
    }
}

#[test]
fn a_concave_ring_ending_on_a_tilted_plane_adds_the_integral_of_the_spandrel() {
    let _serial = crate::serial_blends();
    let rim = Rim { radius: 10.0, corner_z: 0.0, convex: false };
    for tilt in [0.3_f64, -0.3] {
        let part = cut_boss(tilt, 2.0);
        let edge = rim_edge(&part, 0.0);
        assert_eq!(edge.len(), 1, "tilt {tilt}");
        let shape = built(&part, &edge, &[1.0, NAN, 0.0, 0.0], 0.0, CIRCLE_PARAM);
        let added = volume_of(&shape) - volume_of(&part);
        let expected = revolved_cut(rim, tilt, 2.0, &circle_curve(1.0));
        assert!(near(added, expected, 5e-6), "tilt {tilt}: added {added} expected {expected}");
        let occt = fillet(&part, &edge, 1.0, None).unwrap().unwrap();
        assert!(near(volume_of(&shape), volume_of(&occt), 1e-6), "tilt {tilt}: {} vs OCCT {}", volume_of(&shape), volume_of(&occt));
        let (g0, g1, found) = contacts(&shape);
        assert_eq!(found, 2);
        assert!(g0 < 1e-6 * diagonal(&shape) && g1 < 1e-3, "tilt {tilt}: g0 {g0} g1 {g1}");
    }
}

/// A prism 3 high over the polygon (x, y), drawn in z = 0.
pub(crate) fn prism_part(points: &[[f64; 2]]) -> Shape {
    let mut chain = Vec::new();
    for k in 0..points.len() {
        let (a, b) = (points[k], points[(k + 1) % points.len()]);
        chain.extend([0.0, a[0], a[1], 0.0, b[0], b[1], 0.0]);
    }
    prism_of_face(&crate::features::chain_face(&chain).unwrap().unwrap(), [0.0, 0.0, 3.0]).unwrap().unwrap()
}

/// The top front edge (y = 0, z = 3) and whether it runs from x = 0 to x = 10.
pub(crate) fn front_edge(shape: &Shape) -> (Vec<u32>, bool) {
    let topo = topology(shape).unwrap();
    let edges = edges_where(shape, |e| (num(&e["mid"][2]) - 3.0).abs() < 1e-9 && num(&e["mid"][1]).abs() < 1e-9);
    assert_eq!(edges.len(), 1);
    let forward = num(&topo["edges"][edges[0] as usize]["start"][0]) < 5.0;
    (edges, forward)
}

/// The straight law that makes the radius `start` at x = 0 and `end` at x = 10 on an edge that runs `forward` (start vertex at x = 0) or not.
pub(crate) fn law(start: f64, end: f64, forward: bool) -> [f64; 4] {
    if forward {
        [start, end, 1.0, 0.0]
    } else {
        [end, start, 1.0, 0.0]
    }
}

#[test]
fn a_changing_size_between_narrowing_end_walls_is_the_integral_of_the_parabolic_spandrel() {
    let _serial = crate::serial_blends();
    // the end walls lean over the part: x = y / 2 at the start and x = 10 - y / 2 at the end, so every section lies inside 0 <= x <= 10
    let part = prism_part(&[[0.0, 0.0], [10.0, 0.0], [7.0, 6.0], [3.0, 6.0]]);
    let (edge, forward) = front_edge(&part);
    let (r0, r1) = (0.4, 0.8);
    let shape = built(&part, &edge, &law(r0, r1, forward), 0.0, 0.5);
    // the section at x has the legs d = r0 + (r1 - r0) x / 10 and keeps the depths y <= 2 min(x, 10 - x) of its parabola (z-extent d (1 - sqrt(y / d))^2)
    let area = |x: f64| {
        let d = r0 + (r1 - r0) * x / 10.0;
        let reach = (2.0 * x.min(10.0 - x) / d).min(1.0).sqrt();
        d * d * (reach.powi(2) - 4.0 / 3.0 * reach.powi(3) + 0.5 * reach.powi(4))
    };
    // d(x) = 2 x and d(x) = 2 (10 - x) are where an end wall starts to cut the section
    let slope = (r1 - r0) / 10.0;
    let first = r0 / (2.0 - slope);
    let last = (20.0 - r0) / (2.0 + slope);
    let expected: f64 = [(0.0, first), (first, 5.0), (5.0, last), (last, 10.0)].iter().map(|(a, b)| gauss(&area, *a, *b, 8)).sum();
    let removed = volume_of(&part) - volume_of(&shape);
    assert!(near(removed, expected, 1e-6), "removed {removed} expected {expected}");
    let (g0, g1, found) = contacts(&shape);
    assert_eq!(found, 2);
    assert!(g0 < 1e-6 * diagonal(&shape) && g1 < 1e-3, "g0 {g0} g1 {g1}");
}

#[test]
fn a_constant_size_between_flaring_narrowing_and_skewed_end_walls_is_the_closed_form_and_the_circular_fillet() {
    let _serial = crate::serial_blends();
    let d = 0.6;
    // (outline, sum of the outward leans tan a + tan b of the two end walls): the removed volume is A L + (tan a + tan b) M, A = d^2 / 6, M = d^3 / 30 for the parabola
    for (points, leans) in [
        ([[0.0, 0.0], [10.0, 0.0], [13.0, 6.0], [-3.0, 6.0]], 1.0),
        ([[0.0, 0.0], [10.0, 0.0], [14.0, 6.0], [4.0, 6.0]], 0.0),
        ([[0.0, 0.0], [10.0, 0.0], [7.0, 6.0], [3.0, 6.0]], -1.0),
        ([[0.0, 0.0], [10.0, 0.0], [7.0, 6.0], [-3.0, 6.0]], 0.0),
    ] {
        let part = prism_part(&points);
        let (edge, _) = front_edge(&part);
        let laws = [d, d, 1.0, 0.0];
        let shape = built(&part, &edge, &laws, 0.0, 0.5);
        let removed = volume_of(&part) - volume_of(&shape);
        let expected = 10.0 * d * d / 6.0 + leans * d.powi(3) / 30.0;
        assert!(near(removed, expected, 1e-5), "{points:?}: removed {removed} expected {expected}");
        let circle = built(&part, &edge, &laws, 0.0, CIRCLE_PARAM);
        let occt = fillet_laws(&part, &edge, &laws).unwrap().unwrap();
        assert!(near(volume_of(&circle), volume_of(&occt), 1e-6), "{points:?}: {} vs OCCT {}", volume_of(&circle), volume_of(&occt));
        let (g0, g1, found) = contacts(&shape);
        assert_eq!(found, 2);
        assert!(g0 < 1e-6 * diagonal(&shape) && g1 < 1e-3, "{points:?}: g0 {g0} g1 {g1}");
        assert_eq!(face_count(&shape), face_count(&part) + 1);
    }
}

#[test]
fn what_an_oblique_end_cannot_have_is_named() {
    let _serial = crate::serial_blends();
    // an end face nearly parallel to the edge (a crease of 0.0997 rad)
    let part = prism_part(&[[0.0, 0.0], [10.0, 0.0], [70.0, 6.0], [-60.0, 6.0]]);
    let (edge, _) = front_edge(&part);
    let why = blend(&part, &edge, &[0.4, 0.8, 1.0, 0.0], 0.0, 0.5).err().expect("refused");
    assert!(why.contains("ends obliquely") && why.contains("crease of 0.0996"), "{why}");
    // an end vertex where the outline turns reflex: the solid is still there past the end plane
    let part = prism_part(&[[0.0, 0.0], [10.0, 0.0], [12.0, -3.0], [20.0, -3.0], [20.0, 6.0], [0.0, 6.0]]);
    let edge = edges_where(&part, |e| {
        (num(&e["mid"][2]) - 3.0).abs() < 1e-9 && num(&e["mid"][1]).abs() < 1e-9 && (num(&e["mid"][0]) - 5.0).abs() < 1e-9
    });
    let why = blend(&part, &edge, &[0.4, 0.4, 1.0, 0.0], 0.0, 0.5).err().expect("refused");
    assert!(why.contains("does not leave the blend on the solid's side"), "{why}");
}

#[test]
fn a_steep_tilt_with_a_large_size_still_gets_the_whole_cut_from_the_derived_margin() {
    let _serial = crate::serial_blends();
    let rim = Rim { radius: 8.0, corner_z: 3.0, convex: true };
    // the plane leans 0.5 rad and the size is a large part of the 3 high wall: the cut lies far past the circular blend's patch
    for (tilt, c, r) in [(0.5_f64, 6.0, 2.0), (0.5, 6.0, 1.0), (-0.5, 4.0, 1.0)] {
        let part = keep_side(&make_cylinder(8.0, 3.0).unwrap().unwrap(), tilt, c);
        let edge = rim_edge(&part, 3.0);
        assert_eq!(edge.len(), 1, "tilt {tilt}");
        let shape = built(&part, &edge, &[r, NAN, 0.0, 0.0], 0.0, CIRCLE_PARAM);
        let removed = volume_of(&part) - volume_of(&shape);
        let expected = revolved_cut(rim, tilt, c, &circle_curve(r));
        assert!(near(removed, expected, 1e-6), "tilt {tilt} r {r}: removed {removed} expected {expected}");
        let occt = fillet(&part, &edge, r, None).unwrap().unwrap();
        assert!(near(volume_of(&shape), volume_of(&occt), 1e-6), "tilt {tilt} r {r}: {} vs OCCT {}", volume_of(&shape), volume_of(&occt));
    }
}

#[test]
fn an_oblique_end_on_a_cone_rim_builds_and_meets_the_conical_support_tangentially() {
    let _serial = crate::serial_blends();
    let cone = crate::make_cone(10.0, 5.0, 20.0).unwrap().unwrap();
    let part = keep_side(&cone, -0.3, 2.0);
    let edge = edges_where(&part, |e| e["curve"] == "circle" && (num(&e["mid"][2]) - 20.0).abs() < 1e-3);
    assert_eq!(edge.len(), 1);
    // a conic of rho 0.5 (the fold of the cone against its top is not a right angle, so the circle is a different weight): tangent to both supports to the gate, and it removes material
    let shape = built(&part, &edge, &[1.0, NAN, 0.0, 0.0], 0.0, 0.5);
    assert!(volume_of(&shape) < volume_of(&part) - 1.0);
    let (g0, g1, found) = contacts(&shape);
    assert_eq!(found, 2);
    assert!(g0 < 1e-6 * diagonal(&shape) && g1 < 1e-3, "g0 {g0} g1 {g1}");
}

#[test]
fn a_part_ten_times_larger_holds_the_gap_of_the_new_end_curve_in_the_vertex_tolerance() {
    let _serial = crate::serial_blends();
    // the vertices of the circular blend's end edge carry OCCT's tolerance of its own scale; the conic's end curve misses them by more at 10 times the size
    let s = 10.0;
    let rim = Rim { radius: 8.0, corner_z: 3.0, convex: true };
    for tilt in [0.3_f64, -0.3] {
        let part = keep_side_scaled(&make_cylinder(8.0 * s, 3.0 * s).unwrap().unwrap(), tilt, 3.0 * s, s);
        let edge = rim_edge(&part, 3.0 * s);
        assert_eq!(edge.len(), 1);
        let shape = built(&part, &edge, &[s, NAN, 0.0, 0.0], 0.0, CIRCLE_PARAM);
        let removed = volume_of(&part) - volume_of(&shape);
        let expected = s.powi(3) * revolved_cut(rim, tilt, 3.0, &circle_curve(1.0));
        assert!(near(removed / s.powi(3), expected / s.powi(3), 5e-6), "tilt {tilt}: removed {removed} expected {expected}");
        let occt = fillet(&part, &edge, s, None).unwrap().unwrap();
        assert!(near(volume_of(&shape), volume_of(&occt), 1e-6), "tilt {tilt}: {} vs OCCT {}", volume_of(&shape), volume_of(&occt));
    }
}

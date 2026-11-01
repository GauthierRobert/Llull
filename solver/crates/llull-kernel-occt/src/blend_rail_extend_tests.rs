//! BLD M2 oblique ends where a VARYING size flares past the end of a straight edge (13.37, `cpp/blend_ends_extend.cxx`): the size law is continued past the
//! end vertex by its end tangent, so a section beyond the vertex is the parabola (or circle) of the continued size and the end plane keeps the part of it on
//! the solid side. The oracle is the planar-section integral of that law, integrated here by Gauss-Legendre, independent of OCCT.

use crate::blend_rail_end_tests::{
    built, contacts, diagonal, edges_where, end_area, face_count, front_edge, gauss, law, near, num, prism_part, volume_of, CIRCLE_PARAM,
};
use crate::queries::topology;
use crate::Shape;

/// The section area of a blend with legs `d` (a right angle) that lies deeper than `depth` along the end wall (y >= depth), and the whole area (depth 0).
type Spandrel = fn(f64, f64) -> f64;

/// The parabola (rho 0.5): d^2 (1/6 - (U^2 - 4U^3/3 + U^4/2)), U = sqrt(depth / d).
fn parabola_beyond(d: f64, depth: f64) -> f64 {
    if depth >= d {
        return 0.0;
    }
    let u2 = depth.max(0.0) / d;
    let u = u2.sqrt();
    d * d * (1.0 / 6.0 - (u2 - 4.0 / 3.0 * u2 * u + 0.5 * u2 * u2))
}

/// The circle (the conic of weight cos 45 degrees) of radius d: the area between the corner and the arc, for y from `depth` to d.
fn circle_beyond(d: f64, depth: f64) -> f64 {
    if depth >= d {
        return 0.0;
    }
    let top = d - depth.max(0.0);
    d * top - (0.5 * top * (d * d - top * top).sqrt() + 0.5 * d * d * (top / d).asin())
}

/// How an end wall meets the section: square, flaring (the wall at depth `steep` x (distance past the vertex): the sections beyond the vertex keep the part
/// y >= steep u) or narrowing (the sections inside the vertex lose the part y < steep u, u the distance inside it).
#[derive(Clone, Copy)]
enum End {
    Square,
    Flare(f64),
    Narrow(f64),
}

/// The volume of a blend of the linear law d(s) = r0 + (r1 - r0) s / length on an edge from s = 0 to s = length with the given end walls, the law continued
/// past both ends: the integral of the whole section over the edge, plus the flared sections beyond an end, minus the cut ones inside it.
fn volume_by_law(spandrel: Spandrel, r0: f64, r1: f64, length: f64, start: End, end: End) -> f64 {
    let slope = (r1 - r0) / length;
    volume_by_function(spandrel, &|s| r0 + slope * s, [slope, slope], length, start, end)
}

/// `volume_by_law` for the size `size(s)` along the edge, continued past the ends by the derivatives `slopes` there (the derivative going in the direction of s).
fn volume_by_function(spandrel: Spandrel, size: &dyn Fn(f64) -> f64, slopes: [f64; 2], length: f64, start: End, end: End) -> f64 {
    let mut total = gauss(&|s| spandrel(size(s), 0.0), 0.0, length, 8);
    // (wall, size at the vertex, derivative of the size going outward)
    for (wall, size, outward) in [(start, size(0.0), -slopes[0]), (end, size(length), slopes[1])] {
        // u = w^2 removes the sqrt of the depth; the wall depth steep u equals the leg d at the top of the range
        match wall {
            End::Square => {}
            End::Flare(steep) => {
                let top = (size / (steep - outward)).sqrt();
                total += gauss(&|w| 2.0 * w * spandrel(size + outward * w * w, steep * w * w), 0.0, top, 16);
            }
            End::Narrow(steep) => {
                let top = (size / (steep + outward)).sqrt();
                total -= gauss(&|w| 2.0 * w * spandrel(size - outward * w * w, steep * w * w), 0.0, top, 16);
            }
        }
    }
    total
}

#[test]
fn a_changing_size_flaring_past_both_ends_is_the_integral_of_the_continued_law() {
    let _serial = crate::serial_blends();
    // both end walls lean outward by tan = 1/2: x = -y / 2 and x = 10 + y / 2, so the contact line on the top face runs past each vertex
    let part = prism_part(&[[0.0, 0.0], [10.0, 0.0], [13.0, 6.0], [-3.0, 6.0]]);
    let (edge, forward) = front_edge(&part);
    let square = prism_part(&[[0.0, 0.0], [10.0, 0.0], [10.0, 6.0], [0.0, 6.0]]);
    let (square_edge, square_forward) = front_edge(&square);
    for (name, spandrel, param) in [("parabola", parabola_beyond as Spandrel, 0.5), ("circle", circle_beyond as Spandrel, CIRCLE_PARAM)] {
        for (r0, r1) in [(0.4, 0.8), (0.8, 0.4)] {
            let shape = built(&part, &edge, &law(r0, r1, forward), 0.0, param);
            let removed = volume_of(&part) - volume_of(&shape);
            let expected = volume_by_law(spandrel, r0, r1, 10.0, End::Flare(2.0), End::Flare(2.0));
            assert!(near(removed, expected, 1e-5), "{name} {r0} -> {r1}: removed {removed} expected {expected}");
            // the same law on the square-ended box: the difference is exactly the oblique wedge
            let box_shape = built(&square, &square_edge, &law(r0, r1, square_forward), 0.0, param);
            let box_removed = volume_of(&square) - volume_of(&box_shape);
            let square_expected = volume_by_law(spandrel, r0, r1, 10.0, End::Square, End::Square);
            assert!(near(box_removed, square_expected, 1e-6), "{name} {r0} -> {r1}: square {box_removed}");
            let wedge = removed - box_removed;
            assert!(
                (wedge - (expected - square_expected)).abs() < 1e-3 * wedge,
                "{name} {r0} -> {r1}: wedge {wedge} expected {}",
                expected - square_expected
            );
            let (g0, g1, found) = contacts(&shape);
            assert_eq!(found, 2);
            assert!(g0 < 1e-6 * diagonal(&shape) && g1 < 1e-3, "{name} {r0} -> {r1}: g0 {g0} g1 {g1}");
            assert_eq!(face_count(&shape), face_count(&part) + 1);
            // each wall stays one planar face (outward normals (2, -1, 0) / sqrt 5 at the end, (-2, -1, 0) / sqrt 5 at the start) and loses the section on it
            for normal in [[2.0 / 5.0_f64.sqrt(), -1.0 / 5.0_f64.sqrt(), 0.0], [-2.0 / 5.0_f64.sqrt(), -1.0 / 5.0_f64.sqrt(), 0.0]] {
                assert!(end_area(&shape, normal) < end_area(&part, normal), "{name} {r0} -> {r1}");
            }
        }
    }
}

/// The L-shaped column of the oblique-end tests sheared by `shift` in x over height 6; its reflex edge runs from (5, 5, 0) to (5 + shift, 5, 6).
fn sheared_column(shift: f64) -> (Shape, Vec<u32>, bool) {
    let points = [[0.0, 0.0], [10.0, 0.0], [10.0, 5.0], [5.0, 5.0], [5.0, 10.0], [0.0, 10.0]];
    let mut chain = Vec::new();
    for k in 0..points.len() {
        let (a, b) = (points[k], points[(k + 1) % points.len()]);
        chain.extend([0.0, a[0], a[1], 0.0, b[0], b[1], 0.0]);
    }
    let face = crate::features::chain_face(&chain).unwrap().unwrap();
    let part = crate::features::prism_of_face(&face, [shift, 0.0, 6.0]).unwrap().unwrap();
    let edge = edges_where(&part, |e| (num(&e["mid"][1]) - 5.0).abs() < 1e-9 && (num(&e["mid"][0]) - (5.0 + shift / 2.0)).abs() < 1e-9);
    assert_eq!(edge.len(), 1);
    let forward = num(&topology(&part).unwrap()["edges"][edge[0] as usize]["start"][2]) < 3.0;
    (part, edge, forward)
}

#[test]
fn a_changing_size_on_a_concave_edge_with_one_end_flaring_and_one_narrowing_is_the_integral_of_the_continued_law() {
    let _serial = crate::serial_blends();
    // the end planes z = 0 and z = 6 cross the slanted edge at 1.1 rad from its direction; seen along the edge one end flares and the other narrows, by
    // the depth 6 / shift per unit of length (2 for a shift of 3)
    for (shift, start, end) in [(3.0, End::Narrow(2.0), End::Flare(2.0)), (-3.0, End::Flare(2.0), End::Narrow(2.0))] {
        let (part, edge, forward) = sheared_column(shift);
        let length = (shift * shift + 36.0_f64).sqrt();
        for (name, spandrel, param) in [("parabola", parabola_beyond as Spandrel, 0.5), ("circle", circle_beyond as Spandrel, CIRCLE_PARAM)]
        {
            let shape = built(&part, &edge, &law(0.5, 1.0, forward), 0.0, param);
            let added = volume_of(&shape) - volume_of(&part);
            let expected = volume_by_law(spandrel, 0.5, 1.0, length, start, end);
            assert!(near(added, expected, 1e-5), "{name} shift {shift}: added {added} expected {expected}");
            let (g0, g1, found) = contacts(&shape);
            assert_eq!(found, 2);
            assert!(g0 < 1e-6 * diagonal(&shape) && g1 < 1e-3, "{name} shift {shift}: g0 {g0} g1 {g1}");
            assert_eq!(face_count(&shape), face_count(&part) + 1, "{name} shift {shift}");
        }
    }
}

/// The planar-section integral of the wedge beyond the end walls (leaning 1 in 2: the wall depth 2 u) for a size held at `r0` / `r1` past the start / end.
fn wedge_of_constant_size(spandrel: Spandrel, r0: f64, r1: f64) -> f64 {
    [r0, r1].iter().map(|&size| gauss(&|w| 2.0 * w * spandrel(size, 2.0 * w * w), 0.0, (size / 2.0).sqrt(), 16)).sum()
}

#[test]
fn a_law_with_zero_end_slopes_is_held_constant_past_the_vertex_and_the_wedge_is_the_integral_of_that_size() {
    let _serial = crate::serial_blends();
    let part = prism_part(&[[0.0, 0.0], [4.0, 0.0], [7.0, 6.0], [-3.0, 6.0]]);
    let (edge, _) = front_edge(&part);
    let square = prism_part(&[[0.0, 0.0], [4.0, 0.0], [4.0, 6.0], [0.0, 6.0]]);
    let (square_edge, _) = front_edge(&square);
    // front_edge reads the direction of a 10 long edge: here the edge is 4 long
    let runs_forward = |shape: &Shape, edge: &[u32]| num(&topology(shape).unwrap()["edges"][edge[0] as usize]["start"][0]) < 2.0;
    let (forward, square_forward) = (runs_forward(&part, &edge), runs_forward(&square, &square_edge));
    // mode 0: the kernel's smooth transition between the two sizes, mode 2: the monotone cubic; both are flat at both ends
    for (kind, mode) in [("monotone", 2.0)] {
        for (name, spandrel, param) in [("parabola", parabola_beyond as Spandrel, 0.5), ("circle", circle_beyond as Spandrel, CIRCLE_PARAM)]
        {
            let (r0, r1) = (0.3, 0.9);
            let laws = |forward: bool| if forward { [r0, r1, mode, 0.0] } else { [r1, r0, mode, 0.0] };
            let shape = built(&part, &edge, &laws(forward), 0.0, param);
            let box_shape = built(&square, &square_edge, &laws(square_forward), 0.0, param);
            let removed = volume_of(&part) - volume_of(&shape);
            let wedge = removed - (volume_of(&square) - volume_of(&box_shape));
            // the monotone law is the Hermite cubic with zero end slopes, 3 t^2 - 2 t^3 between the sizes, held constant past both ends
            let smooth = |s: f64| r0 + (r1 - r0) * (3.0 * (s / 4.0).powi(2) - 2.0 * (s / 4.0).powi(3));
            let total = volume_by_function(spandrel, &smooth, [0.0, 0.0], 4.0, End::Flare(2.0), End::Flare(2.0));
            let expected = wedge_of_constant_size(spandrel, r0, r1);
            assert!((removed - total).abs() < 5e-4 * total, "{kind} {name}: removed {removed} expected {total}");
            assert!((wedge - expected).abs() < 2e-2 * wedge, "{kind} {name}: wedge {wedge} expected {expected}");
            let (g0, g1, found) = contacts(&shape);
            assert_eq!(found, 2);
            assert!(g0 < 1e-6 * diagonal(&shape) && g1 < 1e-3, "{kind} {name}: g0 {g0} g1 {g1}");
        }
    }
}

//! BLD §13.39: profile (conic / curvature) corners at a vertex with one unrounded third edge, and the rolling-ball trim builder at the same vertex (`cpp/blend_corner.cxx`).

use crate::blend_corner_tests::{cube, cube_vertices, edges_at, notched_cube, split_faces, tall_pyramid, worst_patch_gap, CornerHooks};
use crate::blend_third_tests::{along_the_crease, patch_edges, read, volume, volume_outside, Reading};
use crate::features::{fillet, fillet_profile_blend, fillet_setback, profile_blend_reason, setback_reason, shape_notes};
use crate::queries::{edge_continuity, face_samples, point_distances, topology, UvRequest};
use crate::{analyze, boolean, make_box, make_cylinder, make_prism, mass_properties, BooleanOp, Shape};
use serde_json::Value;

const NAN: f64 = f64::NAN;

/// The profile specs of the edges `edges` (size `size`, section `kind` 0 conic / 1 curvature, `param` rho / shape).
fn specs_of(edges: &[usize], size: f64, kind: f64, param: f64) -> Vec<f64> {
    edges.iter().flat_map(|edge| [*edge as f64, kind, param, size, NAN, -1.0, 0.0]).collect()
}

/// The profile blend of `edges` of `shape`, the corners found automatically; the reason when it is refused.
fn profile_of(shape: &Shape, edges: &[usize], size: f64, kind: f64, param: f64) -> Result<Shape, String> {
    let specs = specs_of(edges, size, kind, param);
    match fillet_profile_blend(shape, &specs, &[], &[], kind, param).unwrap() {
        Some(built) => Ok(built),
        None => Err(profile_blend_reason(shape, &specs, &[], &[], kind, param).unwrap()),
    }
}

/// The edges at `vertex` but number `sharp` (in the order `edges_at` lists them) with the profile.
fn third(shape: &Shape, vertex: [f64; 3], sharp: usize, size: f64, kind: f64, param: f64) -> Result<Shape, String> {
    let meeting = edges_at(shape, vertex);
    let rounded: Vec<usize> = meeting.iter().enumerate().filter(|(k, _)| *k != sharp).map(|(_, edge)| *edge).collect();
    profile_of(shape, &rounded, size, kind, param)
}

fn notes_of(shape: &Shape) -> Value {
    serde_json::from_str(&shape_notes(shape).unwrap()).unwrap()
}

/// The area removed from the section by a conic of legs 1 and weight `w` (between the two legs and the curve) and the overlap of the two prisms of a mitre at a vertex (the integral of the squared
/// width over the height); both by Simpson's rule over the rational quadratic X(t) = (1-t)^2 / d, Y(t) = t^2 / d, d = (1-t)^2 + 2 w t (1-t) + t^2.
fn conic_integrals(w: f64) -> (f64, f64) {
    let steps = 2000;
    let (mut area, mut overlap) = (0.0, 0.0);
    for k in 0..=steps {
        let t = k as f64 / steps as f64;
        let d = (1.0 - t) * (1.0 - t) + 2.0 * w * t * (1.0 - t) + t * t;
        let dd = -2.0 * (1.0 - t) + 2.0 * w * (1.0 - 2.0 * t) + 2.0 * t;
        let x = (1.0 - t) * (1.0 - t) / d;
        let dy = (2.0 * t * d - t * t * dd) / (d * d);
        let weight = if k == 0 || k == steps {
            1.0
        } else if k % 2 == 1 {
            4.0
        } else {
            2.0
        };
        area += weight * x * dy;
        overlap += weight * x * x * dy;
    }
    (area / (3.0 * steps as f64), overlap / (3.0 * steps as f64))
}

/// The mitre of two conic blends (weight ratio rho / (1 - rho)) of size 1 along two edges of a cube of side `side` that meet at a vertex: the cube minus the two removed prisms, which overlap in
/// the integral of the squared width (13.33.4 for the circle: L^3 - 2 r^2 (1 - pi/4) L + r^3 (5/3 - pi/2)).
fn conic_mitre_volume(side: f64, rho: f64) -> f64 {
    let (area, overlap) = conic_integrals(rho / (1.0 - rho));
    side.powi(3) - 2.0 * area * side + overlap
}

/// The mitre of the two single-edge profile blends of `edges`, as the intersection of the two solids (no corner patch in either): the independent route for a section that has no closed form.
fn mitre_of(shape: &Shape, edges: &[usize], size: f64, kind: f64, param: f64) -> Shape {
    let first = profile_of(shape, &edges[..1], size, kind, param).expect("the first blend");
    let second = profile_of(shape, &edges[1..], size, kind, param).expect("the second blend");
    boolean(BooleanOp::Intersect, &first, &second, true).unwrap().expect("the mitre")
}

/// The crease spoke of a star read by `read`: the angles from the sharp edge to the pole.
fn crease_of(reading: &Reading) -> Vec<f64> {
    assert_eq!(reading.creases.len(), 1, "one crease spoke");
    along_the_crease(&reading.creases[0])
}

/// Every `point` of a JSON value (an array of three numbers under the key "point"), flattened.
fn points_in(value: &Value, found: &mut Vec<f64>) {
    match value {
        Value::Object(map) => {
            for (key, inner) in map {
                match (key.as_str(), inner.as_array()) {
                    ("point", Some(xyz)) if xyz.len() == 3 && xyz.iter().all(Value::is_number) => {
                        found.extend(xyz.iter().map(|n| n.as_f64().unwrap()))
                    }
                    _ => points_in(inner, found),
                }
            }
        }
        Value::Array(list) => list.iter().for_each(|item| points_in(item, found)),
        _ => {}
    }
}

/// B2 (memory-safe, no boolean): the part with its corner blended lies inside the source. The volume is smaller, the bounding box is within the source's, and 9 points per face of every star face
/// (the interior of the patches, not their edges) are inside the source or on its boundary (signed distance <= 1e-6 x the diagonal).
pub(crate) fn assert_inside_source(built: &Shape, source: &Shape, label: &str, slack: f64) {
    assert!(
        volume(built) < volume(source),
        "{label}: the blended part ({}) is smaller than the source ({})",
        volume(built),
        volume(source)
    );
    // (mass_properties bounds of a B-spline face are its control polygon: 0.19 outside the part on the forced-trim cube, so the box is checked on sampled points)
    let outer = mass_properties(source).unwrap().bounds;
    let diagonal = (0..3).map(|axis| (outer[3 + axis] - outer[axis]).powi(2)).sum::<f64>().sqrt();
    let topo = topology(built).unwrap();
    let mut points = Vec::new();
    for (index, face) in topo["faces"].as_array().unwrap().iter().enumerate() {
        if face["name"].as_str().is_some_and(|name| name.starts_with("blend(v:")) {
            points_in(&face_samples(built, index as f64, UvRequest::Grid { nu: 3, nv: 3 }).unwrap(), &mut points);
        }
    }
    assert!(points.len() >= 3 * 9 * 5, "{label}: star points sampled: {}", points.len() / 3);
    for (k, coordinate) in points.iter().enumerate() {
        let axis = k % 3;
        assert!(
            *coordinate >= outer[axis] - slack * diagonal && *coordinate <= outer[3 + axis] + slack * diagonal,
            "{label}: star point {} outside the box of the source",
            k / 3
        );
    }
    for (k, distance) in point_distances(source, &points).unwrap().as_array().unwrap().iter().enumerate() {
        let signed = distance["signed"].as_f64().unwrap();
        assert!(signed <= slack * diagonal, "{label}: star point {k} {:?} is {signed} outside the source", &points[3 * k..3 * k + 3]);
    }
}

fn assert_falls_monotonically(angles: &[f64], entry: f64) {
    assert!((angles[0] - entry).abs() < 1e-6, "the spoke leaves the sharp edge at the dihedral {entry}: {}", angles[0]);
    for pair in angles.windows(2) {
        assert!(pair[1] <= pair[0] + 1e-9, "the crease only fades: {angles:?}");
    }
    assert!(angles[20] < 0.01, "and is flat at the pole: {}", angles[20]);
}

/// BLD §13.39.1: a conic profile (rho 0.5, a parabola) on two edges of a cube vertex, the third left sharp: the corner is the hole and star of 13.33 with the conic sections as blend arcs. G0 and G1 at the
/// contacts, the crease spoke leaves the sharp edge at 90 degrees and fades monotonically to a flat pole, the volume is under the mitre of the two blends (closed form, and the intersection of the two
/// single-edge blends) by the sliver the star removes; with rho = sqrt(2) - 1 (a circle) the star equals the circular star of 13.33.
#[test]
fn a_conic_profile_with_an_unrounded_third_edge_gets_the_star_with_a_crease_spoke() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let shape = cube(10.0);
    let built = third(&shape, [0.0; 3], 2, 1.0, 0.0, 0.5).expect("builds");
    assert_inside_source(&built, &shape, "conic cube", 1e-6);
    assert!(analyze(&built).unwrap().valid);
    assert_eq!(split_faces(topology(&built).unwrap()["faces"].as_array().unwrap()), (8, 5), "6 planes and 2 blends; a star of 5");
    let notes = notes_of(&built);
    let corner = &notes["corners"][0];
    assert_eq!((corner["patch"].as_str(), corner["continuity"].as_str()), (Some("exact"), Some("G1")));
    assert_eq!(notes["corners"].as_array().unwrap().len(), 1);
    let setbacks = corner["setbacks"].as_array().unwrap();
    assert_eq!(setbacks.len(), 3, "the unrounded edge has its entry distance too: {setbacks:?}");
    for entry in setbacks {
        assert!((entry["distance"].as_f64().unwrap() - 2.0).abs() < 1e-9, "factor 2 x the least distance 1: {entry}");
    }
    let reading = read(&built);
    assert!(reading.interior < 2e-3, "G1 over every patch edge but the crease spoke: {}", reading.interior);
    assert!(reading.pole_end < 2e-3, "{}", reading.pole_end);
    assert_falls_monotonically(&crease_of(&reading), std::f64::consts::FRAC_PI_2);
    assert!(worst_patch_gap(&built) < 0.2e-6 * 3.0_f64.sqrt() * 10.0, "G0: {}", worst_patch_gap(&built));
    // the mitre: closed form (a parabola removes 1/6 of the section) against the intersection of the two single-edge blends
    let mitre = conic_mitre_volume(10.0, 0.5);
    let meeting = edges_at(&shape, [0.0; 3]);
    let route = volume(&mitre_of(&shape, &[meeting[0], meeting[1]], 1.0, 0.0, 0.5));
    assert!((route - mitre).abs() < 1e-4, "the closed form {mitre} is the volume of the intersection of the blends {route}");
    let own = volume(&built);
    assert!(
        own < mitre && own > mitre - 1.0,
        "the star removes the sliver between the contact lines and the chords: {own} against the mitre {mitre}"
    );
    // the circular section as a conic is the circular star of 13.33 (same hole, setback 2)
    let conic = third(&shape, [0.0; 3], 2, 1.0, 0.0, std::f64::consts::SQRT_2 - 1.0).expect("builds");
    let mut edges = Vec::new();
    let mut corners = vec![0.0, 0.0, 0.0, 3.0];
    for (k, edge) in meeting.iter().enumerate() {
        corners.extend([*edge as f64, 2.0]);
        if k != 2 {
            edges.extend([*edge as f64, 1.0, 1.0]);
        }
    }
    let circular = fillet_setback(&shape, &edges, &corners).unwrap().expect("the circular star");
    assert!(
        (volume(&conic) - volume(&circular)).abs() < 5e-3,
        "rho = sqrt(2) - 1 is the circle: {} against {}",
        volume(&conic),
        volume(&circular)
    );
}

/// BLD §13.39.1: a curvature profile (shape 0.5) takes the same hole; its star is G1 and says why not G2 (13.36 refuses a crease vertex). The mitre of the two single-edge blends is the reference
/// (the section has no closed form); the star is under it by the sliver and the crease spoke fades as for the conic.
#[test]
fn a_curvature_profile_with_an_unrounded_third_edge_gets_the_g1_star_and_says_why_not_g2() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let shape = cube(10.0);
    let built = third(&shape, [0.0; 3], 2, 1.0, 1.0, 0.5).expect("builds");
    assert!(analyze(&built).unwrap().valid);
    assert_eq!(split_faces(topology(&built).unwrap()["faces"].as_array().unwrap()), (8, 5));
    let notes = notes_of(&built);
    let corner = &notes["corners"][0];
    assert_eq!(corner["continuity"].as_str(), Some("G1"));
    assert!(corner["g2Refused"].as_str().is_some_and(|why| why.contains("unrounded edge enters the hole")), "{corner}");
    let reading = read(&built);
    assert!(reading.interior < 3e-3 && reading.pole_end < 2e-3, "{} {}", reading.interior, reading.pole_end);
    assert_falls_monotonically(&crease_of(&reading), std::f64::consts::FRAC_PI_2);
    assert!(worst_patch_gap(&built) < 0.2e-6 * 3.0_f64.sqrt() * 10.0, "G0: {}", worst_patch_gap(&built));
    let meeting = edges_at(&shape, [0.0; 3]);
    let mitre = volume(&mitre_of(&shape, &[meeting[0], meeting[1]], 1.0, 1.0, 0.5));
    let own = volume(&built);
    assert!(own < mitre && own > mitre - 1.5, "the star is under the mitre of the two blends by the sliver: {own} against {mitre}");
}

/// BLD §13.39.1: every vertex of the cube and every choice of the sharp edge (24 builds) gives one volume.
#[test]
fn all_eight_vertices_and_three_sharp_edges_give_one_conic_volume() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let shape = cube(10.0);
    let mut volumes = Vec::new();
    for vertex in cube_vertices(10.0) {
        for sharp in 0..3 {
            let built = third(&shape, vertex, sharp, 1.0, 0.0, 0.5).unwrap_or_else(|why| panic!("{vertex:?} sharp {sharp}: {why}"));
            assert!(analyze(&built).unwrap().valid, "{vertex:?} sharp {sharp}");
            volumes.push(volume(&built));
        }
    }
    assert_eq!(volumes.len(), 24);
    for each in &volumes {
        assert!((each - volumes[0]).abs() < 1e-6, "{each} against {}", volumes[0]);
    }
}

/// BLD §13.39.1: the star is inside the mitre of its two blends (the boolean of the star's solid minus the mitre is under 1e-2 mm3) and the mitre is outside the star by the sliver.
#[test]
fn the_conic_star_is_inside_the_mitre_of_its_two_blends() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let shape = cube(10.0);
    let built = third(&shape, [0.0; 3], 2, 1.0, 0.0, 0.5).expect("builds");
    let meeting = edges_at(&shape, [0.0; 3]);
    let mitre = mitre_of(&shape, &[meeting[0], meeting[1]], 1.0, 0.0, 0.5);
    assert!(volume_outside(&built, &mitre) < 1e-2, "outside the mitre: {}", volume_outside(&built, &mitre));
    let sliver = volume_outside(&mitre, &built);
    assert!(sliver > 0.3 && sliver < 1.0, "the mitre is outside the star by {sliver}");
}

/// The unique index of the edge among `edges` whose two ends differ in height by more than 1 (a vertical edge).
fn vertical_edge(shape: &Shape, edges: &[usize]) -> usize {
    let topo = topology(shape).unwrap();
    edges
        .iter()
        .position(|edge| {
            (topo["edges"][*edge]["start"][2].as_f64().unwrap() - topo["edges"][*edge]["end"][2].as_f64().unwrap()).abs() > 0.5
        })
        .unwrap()
}

/// BLD §13.39.2: what a profile corner with a sharp edge does not take is refused by name: convex and concave edges at the vertex (the rim of the notch, the concave vertical edge left sharp), a four-edge
/// apex with one edge sharp, a sharp edge shorter than its entry distance (a plate 1.5 thick, entry 2) and a crease the star cannot hold (side faces meeting at 175 degrees).
#[test]
fn what_a_profile_corner_with_a_sharp_edge_does_not_take_is_refused_by_name() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let notch = notched_cube();
    let rim = edges_at(&notch, [5.0, 5.0, 10.0]);
    let vertical = vertical_edge(&notch, &rim);
    let top: Vec<usize> = rim.iter().enumerate().filter(|(k, _)| *k != vertical).map(|(_, edge)| *edge).collect();
    let text = profile_of(&notch, &top, 0.5, 0.0, 0.5).err().expect("refused");
    assert!(text.contains("needs all its edges convex or all concave"), "{text}");
    let pyramid = tall_pyramid(10.0);
    let apex = edges_at(&pyramid, [5.0, 5.0, 10.0]);
    assert_eq!(apex.len(), 4);
    let text = profile_of(&pyramid, &apex[..3], 0.3, 0.0, 0.5).err().expect("refused");
    assert!(
        text.contains("a profile corner leaves at most one edge of a three-edge vertex sharp") && text.contains("4 edges, 1 not rounded"),
        "{text}"
    );
    let plate = make_box([0.0; 3], [10.0, 10.0, 1.5]).unwrap().unwrap();
    let text = third(&plate, [0.0; 3], vertical_edge(&plate, &edges_at(&plate, [0.0; 3])), 1.0, 0.0, 0.5).err().expect("refused");
    assert!(text.contains("the entry point of the unrounded edge") && text.contains("is not before the end of the edge (1.5)"), "{text}");
    // an edge shorter than the placeholder distance of 1: the entry check, not the placeholder, speaks
    let thin = make_box([0.0; 3], [10.0, 10.0, 0.8]).unwrap().unwrap();
    let text = third(&thin, [0.0; 3], vertical_edge(&thin, &edges_at(&thin, [0.0; 3])), 1.0, 0.0, 0.5).err().expect("refused");
    assert!(text.contains("the entry point of the unrounded edge") && text.contains("is not before the end of the edge (0.8)"), "{text}");
    let obtuse =
        make_prism(&[0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 20.0, 0.874, 0.0, 10.0, 8.0, 0.0, 0.0, 8.0, 0.0], [0.0, 0.0, 6.0]).unwrap().unwrap();
    let corner = [10.0, 0.0, 0.0];
    let text = third(&obtuse, corner, vertical_edge(&obtuse, &edges_at(&obtuse, corner)), 0.5, 0.0, 0.5).err().expect("refused");
    assert!(text.contains("not tangent at a vertex") && text.contains("crease the star can hold"), "{text}");
}

/// BLD §13.39.2: no plate holds the crease, so with the star refused (hook 2), only plates (hook 0) or a star that fails after the fills (hook 3) the profile step is refused by name.
#[test]
fn a_profile_hole_with_a_sharp_edge_has_no_plate_fallback() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let shape = cube(10.0);
    for mode in [0, 2, 3] {
        crate::test_bridge::set_corner_exact_patch(mode);
        let text = third(&shape, [0.0; 3], 2, 1.0, 0.0, 0.5).err().expect("refused");
        assert!(text.contains("the only patch that holds the crease"), "mode {mode}: {text}");
    }
    crate::test_bridge::set_corner_exact_patch(1);
    assert!(third(&shape, [0.0; 3], 2, 1.0, 0.0, 0.5).is_ok());
}

/// The block of 13.22 cut by a cylinder (r 12 about z): the vertex (10, 6.633, 5) has the circular top edge, the straight top edge and the straight edge against the cylinder.
fn cylinder_block() -> (Shape, [f64; 3], Vec<usize>) {
    let block = make_box([0.0; 3], [10.0, 10.0, 5.0]).unwrap().unwrap();
    let cylinder = make_cylinder(12.0, 5.0).unwrap().unwrap();
    let shape = boolean(BooleanOp::Intersect, &block, &cylinder, true).unwrap().unwrap();
    let vertex = [10.0, (144.0_f64 - 100.0).sqrt(), 5.0];
    let meeting = edges_at(&shape, vertex);
    assert_eq!(meeting.len(), 3);
    (shape, vertex, meeting)
}

/// The step at `vertex` of `shape`: the edges but number `sharp` rounded with `radius`, every edge at `ball` (the trim builder: the radius of the ball around the vertex).
fn trim_step(shape: &Shape, vertex: [f64; 3], sharp: usize, radius: f64, ball: f64) -> (Vec<f64>, Vec<f64>) {
    let meeting = edges_at(shape, vertex);
    let mut edges = Vec::new();
    let mut corners = vec![vertex[0], vertex[1], vertex[2], meeting.len() as f64];
    for (k, edge) in meeting.iter().enumerate() {
        corners.extend([*edge as f64, ball]);
        if k != sharp {
            edges.extend([*edge as f64, radius, radius]);
        }
    }
    (edges, corners)
}

/// BLD §13.39.3: the trim builder at a vertex with a sharp straight edge. On the cylinder block the circular top edge is rounded with the straight top edge (sharp: the edge against the cylinder, 0.586
/// rad) or with the edge against the cylinder (sharp: the straight top edge, 90 degrees), r 0.5, ball 1.2: the hole of OCCT's mitre cut by the ball is bounded by 5 edges, the star has 5 sub-patches
/// and the crease spoke leaves E at the dihedral of the part (read from the source) and fades to a flat pole. The oracle is OCCT's rolling-ball blend of the same two edges (a mitre): the star differs
/// from it by the sliver, measured +0.061 and -0.064 mm3 of 474.
#[test]
fn the_trim_builder_holds_a_sharp_straight_edge_with_a_crease_spoke() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let (shape, vertex, meeting) = cylinder_block();
    // measured to build (13.39.4): the straight top edge sharp at r 0.5 / ball 1.2 only (9 of 10 other cases miss G0, below), the edge against the cylinder sharp at five radius / ball pairs
    let cases: Vec<(usize, f64, f64)> = vec![(1, 0.5, 1.2), (2, 0.5, 1.2), (2, 0.5, 1.5), (2, 0.3, 1.5), (2, 0.8, 2.0)];
    for (sharp, radius, ball) in cases {
        let (edges, corners) = trim_step(&shape, vertex, sharp, radius, ball);
        assert_eq!(setback_reason(&shape, &edges, &corners).unwrap(), "", "sharp {sharp} r {radius} ball {ball} builds");
        let built = fillet_setback(&shape, &edges, &corners).unwrap().expect("a solid");
        assert!(analyze(&built).unwrap().valid, "sharp {sharp}");
        assert_eq!(
            split_faces(topology(&built).unwrap()["faces"].as_array().unwrap()),
            (9, 5),
            "sharp {sharp} r {radius} ball {ball}: the block, the cylinder, 2 blends; a star of 5"
        );
        let reading = read(&built);
        assert_inside_source(&built, &shape, &format!("sharp {sharp} r {radius} ball {ball}"), 2e-3);
        eprintln!(
            "CASE sharp {sharp} r {radius} ball {ball}: vol {} interior {:e} pole {:e}",
            volume(&built),
            reading.interior,
            reading.pole_end
        );
        assert!(
            reading.interior < 0.0095,
            "sharp {sharp} r {radius} ball {ball}: G1 {} over every patch edge but the crease",
            reading.interior
        );
        assert!(reading.pole_end < 1e-6, "sharp {sharp} r {radius} ball {ball}: the pole {}", reading.pole_end);
        let dihedral = edge_continuity(&shape, meeting[sharp] as f64, 3.0).unwrap()[0]["g1"].as_f64().unwrap().abs();
        assert_falls_monotonically(&crease_of(&reading), dihedral);
        assert!(
            worst_patch_gap(&built) < 1e-6 * (10.0_f64 * 10.0 + 10.0 * 10.0 + 25.0).sqrt(),
            "sharp {sharp} r {radius} ball {ball}: G0 {}",
            worst_patch_gap(&built)
        );
        let rounded: Vec<u32> = meeting.iter().enumerate().filter(|(k, _)| *k != sharp).map(|(_, edge)| *edge as u32).collect();
        let reference = fillet(&shape, &rounded, radius, None).unwrap().expect("the rolling-ball mitre");
        assert!(
            volume(&built) < volume(&reference) && volume(&reference) - volume(&built) < 1.0,
            "sharp {sharp} r {radius} ball {ball}: {} against the mitre {}",
            volume(&built),
            volume(&reference)
        );
    }
}

/// BLD §13.39.3: the oracle with a closed form. The cube of 13.33 (trim builder forced by its hook), two edges rounded r 1 and the third sharp, ball 2: the star is under the closed-form mitre
/// (995.80383, equal to OCCT's rolling ball to 1e-6) within 0.6 mm3 (measured +0.348: unlike the analytic star the ball cuts the blends beyond their mitre and the smooth star lies tangent to both blends outside it; the trim star of three rounded edges is +0.07 %), its crease spoke leaves at 90 degrees and fades.
#[test]
fn the_trim_builder_on_a_cube_is_within_a_sliver_of_the_closed_form_mitre() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    crate::test_bridge::set_corner_trim(true);
    let shape = cube(10.0);
    let (edges, corners) = trim_step(&shape, [0.0; 3], 2, 1.0, 2.0);
    let built = fillet_setback(&shape, &edges, &corners).unwrap().expect("a solid");
    assert!(analyze(&built).unwrap().valid);
    assert_eq!(split_faces(topology(&built).unwrap()["faces"].as_array().unwrap()), (8, 5));
    let quarter = std::f64::consts::FRAC_PI_4;
    let mitre = 1000.0 - 2.0 * (1.0 - quarter) * 10.0 + (5.0 / 3.0 - std::f64::consts::FRAC_PI_2);
    assert_inside_source(&built, &shape, "trim cube", 2e-3);
    let own = volume(&built);
    assert!(own < mitre && own > mitre - 1.0, "{own} against the closed-form mitre {mitre}");
    let reading = read(&built);
    assert!(reading.interior < 0.0095 && reading.pole_end < 1e-5, "{} {}", reading.interior, reading.pole_end);
    assert_falls_monotonically(&crease_of(&reading), std::f64::consts::FRAC_PI_2);
    assert!(patch_edges(&built).iter().any(|edge| edge.both_patches), "the spokes are patch edges");
}

/// BLD §13.39.3: what the trim builder refuses at a vertex with an unrounded edge, by name: a CURVED sharp edge (the circular top edge: the star misses the blend ends by 3e-6 to 9e-6 against 0.2e-6 x
/// the diagonal), two edges left sharp, a radius that varies on a rounded edge, the sharp edge's setback 0, a ball that does not hold the mitre of the two blends (1.2 against r sqrt(2) = 1.414).
#[test]
fn what_the_trim_builder_does_not_take_at_a_sharp_edge_is_refused_by_name() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let (shape, vertex, meeting) = cylinder_block();
    let reason = |shape: &Shape, edges: &[f64], corners: &[f64]| setback_reason(shape, edges, corners).unwrap();
    let (edges, corners) = trim_step(&shape, vertex, 0, 0.5, 1.2);
    let text = reason(&shape, &edges, &corners);
    assert!(
        text.starts_with("[BLD_CORNER_UNSUPPORTED]") && text.contains("must be a straight line") && text.contains("9 of 10 cases"),
        "{text}"
    );
    let one = vec![meeting[1] as f64, 0.5, 0.5];
    let text = reason(&shape, &one, &corners);
    assert!(text.starts_with("[BLD_CORNER_UNSUPPORTED]") && text.contains("at most one edge of a three-edge vertex"), "{text}");
    let (_, corners) = trim_step(&shape, vertex, 1, 0.5, 1.2);
    let taper = vec![meeting[0] as f64, 0.5, 0.4, meeting[2] as f64, 0.5, 0.5];
    let text = reason(&shape, &taper, &corners);
    assert!(text.starts_with("[BLD_CORNER_UNSUPPORTED]") && text.contains("constant radius"), "{text}");
    let (edges, mut corners) = trim_step(&shape, vertex, 1, 0.5, 1.2);
    corners[4 + 2 + 1] = 0.0;
    let text = reason(&shape, &edges, &corners);
    assert!(text.starts_with("[BLD_CORNER_UNSUPPORTED]") && text.contains("left sharp and has setback 0"), "{text}");
    crate::test_bridge::set_corner_trim(true);
    let cube = cube(10.0);
    let (edges, corners) = trim_step(&cube, [0.0; 3], 2, 1.0, 1.2);
    let text = reason(&cube, &edges, &corners);
    assert!(text.starts_with("[BLD_SETBACK_TOO_SHORT]") && text.contains("must exceed"), "{text}");
}

/// BLD §13.39.5: a vertex with a sharp edge takes one ball. Different setbacks (planes normal to each edge) isolate no face of the mitre (measured: 6 of 6 cases, the sharp edge at 1.0 / 1.6 / 2.0 against 1.2),
/// so they are refused by name.
#[test]
fn different_setbacks_at_a_trim_vertex_with_a_sharp_edge_are_refused_by_name() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let (shape, vertex, _) = cylinder_block();
    for (sharp, distance) in [(1usize, 1.6), (2, 2.0)] {
        let (edges, mut corners) = trim_step(&shape, vertex, sharp, 0.5, 1.2);
        corners[4 + 2 * sharp + 1] = distance;
        let text = setback_reason(&shape, &edges, &corners).unwrap();
        assert!(text.starts_with("[BLD_CORNER_UNSUPPORTED]") && text.contains("takes one ball"), "{text}");
    }
}

/// The index, in the unique edge list of `shape`, of the first edge whose two ends satisfy `wanted`.
fn edge_where(shape: &Shape, wanted: impl Fn([f64; 3], [f64; 3]) -> bool) -> usize {
    let topo = topology(shape).unwrap();
    let point = |value: &Value| [value[0].as_f64().unwrap(), value[1].as_f64().unwrap(), value[2].as_f64().unwrap()];
    topo["edges"].as_array().unwrap().iter().position(|edge| wanted(point(&edge["start"]), point(&edge["end"]))).expect("the edge")
}

/// BLD §13.39 review B1: the decision on a crease spoke, as a pure function of its normal angles. A spoke is accepted when the kink is at the end ON the unrounded edge, never rises by more than
/// 0.0095 rad from there and is flat (<= 0.1 rad) at the pole; the end of the kink on the wrong side, both ends or none on the edge, a bump on the way and a pole that is not flat are refused.
#[test]
fn a_crease_spoke_is_accepted_only_when_it_fades_from_the_unrounded_edge() {
    let fade: Vec<f64> = (0..21).map(|k| std::f64::consts::FRAC_PI_2 * (1.0 - k as f64 / 20.0).powi(2) + 0.004).collect();
    let reversed: Vec<f64> = fade.iter().rev().copied().collect();
    use crate::test_bridge::crease_fade;
    assert!(crease_fade(&fade, true, false), "kink at the first end, on the edge");
    assert!(crease_fade(&reversed, false, true), "the same spoke read from the other end");
    assert!(!crease_fade(&fade, false, true), "the kinked end is not the one on the unrounded edge");
    assert!(!crease_fade(&reversed, true, false));
    assert!(!crease_fade(&fade, true, true) && !crease_fade(&fade, false, false), "both ends or none on the edge");
    let mut bump = fade.clone();
    bump[10] += 0.2;
    assert!(!crease_fade(&bump, true, false), "an interior fold of 0.2 rad");
    let mut small = fade.clone();
    small[10] += 0.005;
    assert!(crease_fade(&small, true, false), "a rise under 0.0095 rad is the measurement noise of the fade");
    let mut stuck = fade.clone();
    *stuck.last_mut().unwrap() = 0.3;
    assert!(!crease_fade(&stuck, true, false), "a pole that is not flat");
    assert!(!crease_fade(&[std::f64::consts::FRAC_PI_2; 21], true, false), "a spoke that keeps its angle");
}

/// BLD §13.39 review B1: on a real creased star (the cube, trim builder forced, r 1, ball 2) every sub-patch passes the oriented check against the unrounded edge it continues; against any other
/// edge, or with a sub-patch turned round (a folded star), the sub-patches next to the crease spoke are refused.
#[test]
fn a_creased_star_with_a_wrong_edge_or_a_folded_sub_patch_is_refused_by_the_oriented_check() {
    use crate::test_bridge::oriented_angle_creased;
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    crate::test_bridge::set_corner_trim(true);
    let shape = cube(10.0);
    let (edges, corners) = trim_step(&shape, [0.0; 3], 2, 1.0, 2.0);
    let built = fillet_setback(&shape, &edges, &corners).unwrap().expect("a solid");
    let pt = |value: &Value| [value[0].as_f64().unwrap(), value[1].as_f64().unwrap(), value[2].as_f64().unwrap()];
    let source_topology = topology(&shape).unwrap();
    let source_edge = &source_topology["edges"][edges_at(&shape, [0.0; 3])[2]];
    let (s0, s1) = (pt(&source_edge["start"]), pt(&source_edge["end"]));
    let on_line = |p: [f64; 3]| {
        let d: Vec<f64> = (0..3).map(|k| s1[k] - s0[k]).collect();
        let length = d.iter().map(|c| c * c).sum::<f64>().sqrt();
        let t: f64 = (0..3).map(|k| (p[k] - s0[k]) * d[k]).sum::<f64>() / (length * length);
        (0..3).map(|k| (p[k] - s0[k] - t * d[k]).powi(2)).sum::<f64>().sqrt() < 1e-3
    };
    let sharp = edge_where(&built, |a, b| on_line(a) && on_line(b) && (0..3).map(|k| (a[k] - b[k]).powi(2)).sum::<f64>().sqrt() > 5.0);
    let wrong =
        edge_where(&built, |a, b| a.iter().map(|c| c * c).sum::<f64>().sqrt() > 9.0 && b.iter().map(|c| c * c).sum::<f64>().sqrt() > 9.0);
    let faces = topology(&built).unwrap()["faces"].as_array().unwrap().clone();
    let stars: Vec<i32> = faces
        .iter()
        .enumerate()
        .filter(|(_, f)| f["name"].as_str().is_some_and(|n| n.starts_with("blend(v:")))
        .map(|(k, _)| k as i32)
        .collect();
    assert_eq!(stars.len(), 5);
    for face in &stars {
        let angle = oriented_angle_creased(&built, *face, false, sharp as i32);
        assert!((0.0..=0.0095).contains(&angle), "sub-patch {face} against the edge it continues: {angle}");
    }
    let refused = |reverse: bool, edge: usize| {
        stars.iter().filter(|face| oriented_angle_creased(&built, **face, reverse, edge as i32) > 0.0095).count()
    };
    assert_eq!(
        refused(false, wrong),
        2,
        "the two sub-patches that border the crease spoke are refused when the kink is not on the edge given"
    );
    assert_eq!(refused(true, sharp), 5, "a sub-patch turned round reads pi against its neighbours");
}

/// BLD §13.39 review: TWO creased corners in one step each keep their own star and their own sharp edge (cube, trim forced, vertices (0,0,0) and (10,10,10), ball 2): valid, two stars of 5.
#[test]
fn two_creased_corners_in_one_trim_step_are_judged_each_against_its_own_edge() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    crate::test_bridge::set_corner_trim(true);
    let shape = cube(10.0);
    let far = [10.0, 10.0, 10.0];
    let (mut edges, mut corners) = trim_step(&shape, [0.0; 3], 2, 1.0, 2.0);
    let (more_edges, more_corners) = trim_step(&shape, far, 2, 1.0, 2.0);
    edges.extend(more_edges);
    corners.extend(more_corners);
    let built = fillet_setback(&shape, &edges, &corners).unwrap().expect("a solid");
    assert!(analyze(&built).unwrap().valid);
    assert_eq!(split_faces(topology(&built).unwrap()["faces"].as_array().unwrap()), (10, 10), "6 planes and 4 blends; two stars of 5");
    assert_inside_source(&built, &shape, "two corners", 2e-3);
}

/// BLD §13.39 review: the crease-extent refusal at a second radius: r 0.8 reaches 0.8 sqrt(2) = 1.13 from the vertex, a ball of 1.0 does not hold it and 1.3 does.
#[test]
fn a_ball_that_does_not_hold_the_crease_is_refused_at_a_second_radius_too() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    crate::test_bridge::set_corner_trim(true);
    let shape = cube(10.0);
    let (edges, corners) = trim_step(&shape, [0.0; 3], 2, 0.8, 1.0);
    let text = setback_reason(&shape, &edges, &corners).unwrap();
    assert!(text.starts_with("[BLD_SETBACK_TOO_SHORT]") && text.contains("must exceed 1.13"), "{text}");
    let (edges, corners) = trim_step(&shape, [0.0; 3], 2, 0.8, 1.3);
    assert_eq!(setback_reason(&shape, &edges, &corners).unwrap(), "");
}

/// BLD §13.39.5: where the star is refused the step says so by name with the measure: the straight top edge sharp at r 0.5 / ball 1.5 (the creased star misses the blend ends by 6e-6 against 3.2e-6).
#[test]
fn a_creased_trim_star_that_misses_the_blend_ends_is_refused_with_the_measure() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let (shape, vertex, _) = cylinder_block();
    let (edges, corners) = trim_step(&shape, vertex, 1, 0.5, 1.5);
    let text = setback_reason(&shape, &edges, &corners).unwrap();
    assert!(
        text.starts_with("[BLD_CORNER_FAILED]")
            && text.contains("the only patch that holds the crease")
            && text.contains("leave the edges by 0.00000"),
        "{text}"
    );
}

/// BLD §13.39.3 (review): a corner star that stands outside the part does not pass silently. The trim builder measures 9 x 9 points on every star sub-patch against the source and records the
/// largest distance outside (`overshoot` in the corner log, the notes of the shape); above 1e-3 x the diagonal the step is refused by name. Cube 10, trim forced, r 1: ball 2 stands 1.1e-3 outside
/// (builds), ball 3 stands 2.8e-2 (the limit is 0.0173).
#[test]
fn a_trim_star_that_stands_outside_the_part_is_measured_and_refused_above_the_limit() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    crate::test_bridge::set_corner_trim(true);
    let shape = cube(10.0);
    let limit = 1e-3 * 3.0_f64.sqrt() * 10.0;
    let (edges, corners) = trim_step(&shape, [0.0; 3], 2, 1.0, 2.0);
    let built = fillet_setback(&shape, &edges, &corners).unwrap().expect("ball 2 builds");
    let overshoot = notes_of(&built)["corners"][0]["overshoot"].as_f64().expect("the overshoot is recorded");
    assert!(overshoot > 5e-4 && overshoot < 1.5e-3, "measured overshoot {overshoot}");
    let (edges, corners) = trim_step(&shape, [0.0; 3], 2, 1.0, 3.0);
    let text = setback_reason(&shape, &edges, &corners).unwrap();
    assert!(text.starts_with("[BLD_CORNER_FAILED]") && text.contains("stands 0.0") && text.contains("outside the part, above"), "{text}");
    assert!(text.contains(&format!("above {}", (limit * 1e5).round() / 1e5)) || text.contains("above 0.017"), "{text}");
    // the same gate on the cylinder block: the edge against the cylinder sharp, r 0.3, ball 2 stands 0.0155 outside (limit 1e-3 x the diagonal)    let (block, vertex, _) = cylinder_block();    let (edges, corners) = trim_step(&block, vertex, 2, 0.3, 2.0);    let text = setback_reason(&block, &edges, &corners).unwrap();    assert!(text.contains("stands 0.015") && text.contains("outside the part, above"), "{text}");
}

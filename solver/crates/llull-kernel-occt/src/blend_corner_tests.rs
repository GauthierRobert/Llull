//! BLD M3: setback corners (`features::fillet_setback`, `cpp/blend_corner.cxx`).

use crate::features::{fillet_profile_blend, fillet_setback, profile_blend_reason, setback_reason};
use crate::queries::{edge_continuity, topology};
use crate::{analyze, boolean, make_box, make_sewn_solid, mass_properties, BooleanOp, Shape};
use serde_json::Value;

fn cube(size: f64) -> Shape {
    make_box([0.0; 3], [size; 3]).unwrap().unwrap()
}

fn num(value: &Value) -> f64 {
    value.as_f64().unwrap()
}

fn point(value: &Value) -> [f64; 3] {
    [num(&value[0]), num(&value[1]), num(&value[2])]
}

/// The unique indices of the edges that start or end at `vertex`.
fn edges_at(shape: &Shape, vertex: [f64; 3]) -> Vec<usize> {
    let topo = topology(shape).unwrap();
    let near = |a: [f64; 3], b: [f64; 3]| a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-6);
    topo["edges"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .filter(|(_, edge)| near(point(&edge["start"]), vertex) || near(point(&edge["end"]), vertex))
        .map(|(index, _)| index)
        .collect()
}

/// Edge indices (all of them) with radius `radius`, and one corner per `vertex` with `setback` on every edge that meets it.
fn spec(shape: &Shape, edges: &[usize], radius: f64, vertices: &[[f64; 3]], setback: f64) -> (Vec<f64>, Vec<f64>) {
    let tapers: Vec<(usize, f64, f64)> = edges.iter().map(|&edge| (edge, radius, radius)).collect();
    spec_tapered(shape, &tapers, vertices, setback)
}

/// Like `spec` with a radius that goes linearly from the first to the second number along each edge (edge index, radius at its start, radius at its end).
fn spec_tapered(shape: &Shape, edges: &[(usize, f64, f64)], vertices: &[[f64; 3]], setback: f64) -> (Vec<f64>, Vec<f64>) {
    let mut flat_edges = Vec::new();
    for &(edge, start, end) in edges {
        flat_edges.extend([edge as f64, start, end]);
    }
    let mut flat_corners = Vec::new();
    for vertex in vertices {
        let meeting = edges_at(shape, *vertex);
        flat_corners.extend([vertex[0], vertex[1], vertex[2], meeting.len() as f64]);
        for edge in meeting {
            flat_corners.extend([edge as f64, setback]);
        }
    }
    (flat_edges, flat_corners)
}

fn cube_vertices(size: f64) -> Vec<[f64; 3]> {
    let mut all = Vec::new();
    for x in [0.0, size] {
        for y in [0.0, size] {
            for z in [0.0, size] {
                all.push([x, y, z]);
            }
        }
    }
    all
}

/// The largest angle (radians) between the outward normals across every edge of every corner patch (a face named `blend(v:...`), at 21 samples, WITHOUT the sharp-edge skip of
/// `worst_tangent_angle` (a patch folded back against its neighbour reads pi there and was skipped as a sharp edge).
fn worst_patch_angle(shape: &Shape) -> f64 {
    let topo = topology(shape).unwrap();
    let patches: Vec<usize> = topo["faces"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .filter(|(_, face)| face["name"].as_str().is_some_and(|name| name.starts_with("blend(v:")))
        .map(|(index, _)| index)
        .collect();
    assert!(!patches.is_empty(), "the shape has corner patches");
    let graph = crate::queries::face_graph(shape).unwrap();
    let mut worst: f64 = 0.0;
    for (edge, faces) in graph["edgeFaces"].as_array().unwrap().iter().enumerate() {
        if !faces.as_array().unwrap().iter().any(|face| patches.contains(&(face.as_u64().unwrap() as usize))) {
            continue;
        }
        let samples = edge_continuity(shape, edge as f64, 21.0).unwrap();
        for sample in samples.as_array().expect("a patch edge is measured") {
            worst = worst.max(num(&sample["g1"]));
        }
    }
    worst
}

/// The largest angle (radians) between the two face normals over the 9 samples of every edge whose faces are not at a sharp angle (> 0.5 rad).
fn worst_tangent_angle(shape: &Shape) -> f64 {
    let count = topology(shape).unwrap()["edges"].as_array().unwrap().len();
    let mut worst: f64 = 0.0;
    for edge in 0..count {
        let Some(samples) = edge_continuity(shape, edge as f64, 9.0).unwrap().as_array().cloned() else { continue };
        if samples.iter().any(|sample| num(&sample["g1"]) > 0.5) {
            continue;
        }
        for sample in samples {
            worst = worst.max(num(&sample["g1"]));
        }
    }
    worst
}

fn pyramid() -> Shape {
    tall_pyramid(10.0)
}

/// A pyramid on a 10 x 10 base whose apex is `height` above the centre.
fn tall_pyramid(height: f64) -> Shape {
    let apex = [5.0, 5.0, height];
    let corners = [[0.0, 0.0, 0.0], [10.0, 0.0, 0.0], [10.0, 10.0, 0.0], [0.0, 10.0, 0.0]];
    let mut positions = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let mut push = |a: [f64; 3], b: [f64; 3], c: [f64; 3]| {
        let base = (positions.len() / 3) as u32;
        for p in [a, b, c] {
            positions.extend(p);
        }
        indices.extend([base, base + 1, base + 2]);
    };
    for i in 0..4 {
        push(corners[i], corners[(i + 1) % 4], apex);
    }
    push(corners[0], corners[2], corners[1]);
    push(corners[0], corners[3], corners[2]);
    make_sewn_solid(&positions, &indices).unwrap().unwrap()
}

#[test]
fn a_cube_with_setback_corners_is_a_valid_solid_with_the_blend_span_of_the_definition() {
    let _serial = crate::serial_blends();
    let shape = cube(10.0);
    let all: Vec<usize> = (0..12).collect();
    let (edges, corners) = spec(&shape, &all, 1.0, &cube_vertices(10.0), 2.0);
    assert_eq!(setback_reason(&shape, &edges, &corners).unwrap(), "", "builds");
    let built = fillet_setback(&shape, &edges, &corners).unwrap().expect("a solid");
    let analysis = analyze(&built).unwrap();
    assert!(analysis.valid, "free faces {} edges {}", analysis.free_faces, analysis.free_edges);
    let topo = topology(&built).unwrap();
    let faces = topo["faces"].as_array().unwrap();
    assert_eq!(faces.len(), 26, "6 planes, 12 blend cylinders, 8 corner patches");
    let cylinders: Vec<&Value> = faces.iter().filter(|face| face["surface"] == "cylinder").collect();
    assert_eq!(cylinders.len(), 12);
    for cylinder in &cylinders {
        let span = cylinder["axis"]["span"].as_array().unwrap();
        assert!((num(&span[1]) - num(&span[0]) - 6.0).abs() < 1e-6, "a blend spans 10 - 2 - 2: {cylinder}");
    }
    let patches = faces.iter().filter(|face| face["name"].as_str().is_some_and(|name| name.starts_with("blend(v:"))).count();
    assert_eq!(patches, 8, "each corner patch is named after the edges meeting there");
    assert!(
        faces.iter().filter(|face| face["surface"] == "plane").all(|face| (num(&face["area"]) - 100.0).abs() > 1.0),
        "faces lost their corners"
    );
    let volume = mass_properties(&built).unwrap().volume;
    assert!(volume > 920.548667765 && volume < 984.548667765, "volume {volume}");
    let worst = worst_tangent_angle(&built);
    assert!(worst < 0.01, "every edge of the rounded cube is tangent within 0.01 rad, ends included: {worst}");
}

#[test]
fn a_too_short_setback_is_named() {
    let _serial = crate::serial_blends();
    let shape = cube(10.0);
    let all: Vec<usize> = (0..12).collect();
    for setback in [0.5, 1.0] {
        let (edges, corners) = spec(&shape, &all, 1.0, &cube_vertices(10.0), setback);
        let reason = setback_reason(&shape, &edges, &corners).unwrap();
        assert!(reason.starts_with("[BLD_SETBACK_TOO_SHORT]"), "{setback}: {reason}");
        assert!(reason.contains("must exceed 1"), "{reason}");
        assert!(fillet_setback(&shape, &edges, &corners).unwrap().is_none());
    }
}

#[test]
fn the_pyramid_apex_takes_a_setback_corner() {
    let _serial = crate::serial_blends();
    let shape = pyramid();
    let topo = topology(&shape).unwrap();
    let lateral: Vec<usize> = topo["edges"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .filter(|(_, edge)| num(&edge["start"][2]) > 9.0 || num(&edge["end"][2]) > 9.0)
        .map(|(index, _)| index)
        .collect();
    assert_eq!(lateral.len(), 4);
    let (edges, corners) = spec(&shape, &lateral, 0.5, &[[5.0, 5.0, 10.0]], 1.5);
    assert_eq!(setback_reason(&shape, &edges, &corners).unwrap(), "");
    let built = fillet_setback(&shape, &edges, &corners).unwrap().expect("a solid");
    assert!(analyze(&built).unwrap().valid);
    let faces = topology(&built).unwrap()["faces"].as_array().unwrap().len();
    assert_eq!(faces, 11, "4 sides, 2 base triangles, 4 blends, 1 apex patch");
    let worst = worst_tangent_angle(&built);
    assert!(worst < 0.01, "blends, patch and faces are tangent: {worst}");
    let (edges, corners) = spec(&shape, &lateral, 0.5, &[[5.0, 5.0, 10.0]], 0.3);
    assert!(setback_reason(&shape, &edges, &corners).unwrap().starts_with("[BLD_SETBACK_TOO_SHORT]"));
}

#[test]
fn what_this_build_does_not_make_is_named_not_faked() {
    let _serial = crate::serial_blends();
    let shape = cube(10.0);
    let all: Vec<usize> = (0..12).collect();
    // a vertex where one of the edges is not rounded
    let first = point(&topology(&shape).unwrap()["edges"][0]["start"]);
    let (edges, corners) = spec(&shape, &(1..12).collect::<Vec<_>>(), 1.0, &[first], 2.0);
    let reason = setback_reason(&shape, &edges, &corners).unwrap();
    assert!(reason.starts_with("[BLD_CORNER_UNSUPPORTED]") && reason.contains("is not rounded"), "{reason}");
    // rounded edges that meet at a vertex without a corner
    let (edges, corners) = spec(&shape, &all, 1.0, &[first], 2.0);
    let reason = setback_reason(&shape, &edges, &corners).unwrap();
    assert!(reason.starts_with("[BLD_CORNER_UNSUPPORTED]") && reason.contains("no setback corner"), "{reason}");
    // a vertex that is not on the solid
    let (edges, corners) = spec(&shape, &all, 1.0, &[[0.0, 0.0, 0.0]], 2.0);
    let mut moved = corners.clone();
    moved[0] = 3.0;
    assert!(setback_reason(&shape, &edges, &moved).unwrap().starts_with("[BLD_CORNER_FAILED]"));
    // malformed specs
    assert!(setback_reason(&shape, &[], &corners).unwrap().starts_with("[BLD_CORNER_FAILED]"));
    assert!(setback_reason(&shape, &edges, &[]).unwrap().starts_with("[BLD_CORNER_FAILED]"));
}

#[test]
fn the_patch_is_valid_and_tangent_at_every_size() {
    let _serial = crate::serial_blends();
    // (size, radius, setback): a corner a tenth of the part, and a small corner on a large part
    for (size, radius, setback) in [(1.0, 0.1, 0.2), (10.0, 1.0, 2.0), (100.0, 10.0, 20.0), (1000.0, 100.0, 200.0), (1000.0, 1.0, 2.0)] {
        let shape = cube(size);
        let all: Vec<usize> = (0..12).collect();
        let (edges, corners) = spec(&shape, &all, radius, &cube_vertices(size), setback);
        let reason = setback_reason(&shape, &edges, &corners).unwrap();
        assert_eq!(reason, "", "size {size} builds");
        let built = fillet_setback(&shape, &edges, &corners).unwrap().expect("a solid");
        assert!(analyze(&built).unwrap().valid, "size {size}");
        let worst = worst_tangent_angle(&built);
        assert!(worst < 0.01, "size {size}: tangent within 0.01 rad, ends included: {worst}");
    }
}

/// A 10 cube with the octant [5, 11]^3 cut away: the notch has an inner corner at (5, 5, 5) where three concave edges meet.
fn notched_cube() -> Shape {
    let notch = make_box([5.0; 3], [6.0; 3]).unwrap().unwrap();
    boolean(BooleanOp::Subtract, &cube(10.0), &notch, true).unwrap().unwrap()
}

#[test]
fn a_concave_inner_corner_takes_a_setback_corner_that_adds_material() {
    let _serial = crate::serial_blends();
    let shape = notched_cube();
    let before = mass_properties(&shape).unwrap().volume;
    let inner = [5.0; 3];
    let concave = edges_at(&shape, inner);
    assert_eq!(concave.len(), 3);
    let (edges, corners) = spec(&shape, &concave, 0.5, &[inner], 1.2);
    assert_eq!(setback_reason(&shape, &edges, &corners).unwrap(), "", "builds");
    let built = fillet_setback(&shape, &edges, &corners).unwrap().expect("a solid");
    assert!(analyze(&built).unwrap().valid);
    let topo = topology(&built).unwrap();
    let faces = topo["faces"].as_array().unwrap();
    assert_eq!(faces.len(), 13, "9 planes, 3 blend cylinders, 1 corner patch");
    assert_eq!(faces.iter().filter(|face| face["surface"] == "cylinder").count(), 3);
    for cylinder in faces.iter().filter(|face| face["surface"] == "cylinder") {
        let span = cylinder["axis"]["span"].as_array().unwrap();
        assert!((num(&span[1]) - num(&span[0]) - 3.8).abs() < 1e-6, "a blend spans 5 - 1.2: {cylinder}");
    }
    assert_eq!(faces.iter().filter(|face| face["name"].as_str().is_some_and(|name| name.starts_with("blend(v:"))).count(), 1);
    let after = mass_properties(&built).unwrap().volume;
    // three spandrel prisms of area r^2 (1 - pi / 4) over the 3.8 between the setback sections, plus the patch region (measured 0.339: under a quarter of the sharp corner cube of 1.2, 0.432)
    let prisms = 3.0 * 0.25 * (1.0 - std::f64::consts::FRAC_PI_4) * 3.8;
    assert!(
        after - before > prisms && after - before < prisms + 0.4,
        "a concave blend adds the prisms and a corner: {prisms} + ? = {}",
        after - before
    );
    let worst = worst_tangent_angle(&built);
    assert!(worst < 0.01, "blends, patch and faces are tangent: {worst}");
}

#[test]
fn concave_and_convex_corners_can_share_one_step() {
    let _serial = crate::serial_blends();
    let shape = notched_cube();
    let (inner, outer) = ([5.0; 3], [0.0; 3]);
    let mut rounded = edges_at(&shape, inner);
    rounded.extend(edges_at(&shape, outer));
    let (edges, mut corners) = spec(&shape, &rounded, 0.5, &[inner], 1.2);
    corners.extend(spec(&shape, &rounded, 0.5, &[outer], 1.2).1);
    assert_eq!(setback_reason(&shape, &edges, &corners).unwrap(), "");
    let built = fillet_setback(&shape, &edges, &corners).unwrap().expect("a solid");
    assert!(analyze(&built).unwrap().valid);
    let faces = topology(&built).unwrap()["faces"].as_array().unwrap().len();
    assert_eq!(faces, 9 + 6 + 2, "9 planes, 6 blends, 2 patches");
    assert!(worst_tangent_angle(&built) < 0.01);
}

/// BLD §13.18: a vertex of convex and concave edges. The rim of the notch of `notched_cube`: two convex top edges and the concave edge that goes down the notch meet at (5, 5, 10), where the top face is
/// REFLEX (270 degrees); the hole is bounded by P_a -> Q -> P_b on it. The notch is symmetric about the plane x = y, so the centroid and the inertia must be.
#[test]
fn a_vertex_of_convex_and_concave_edges_takes_a_setback_corner_through_the_contact_line_intersection() {
    let _serial = crate::serial_blends();
    let shape = notched_cube();
    let (rim, inner) = ([5.0, 5.0, 10.0], [5.0; 3]);
    let mut rounded = edges_at(&shape, rim);
    rounded.extend(edges_at(&shape, inner));
    rounded.sort_unstable();
    rounded.dedup();
    assert_eq!(rounded.len(), 5, "two convex top edges, the concave vertical edge, two concave floor edges");
    let (edges, mut corners) = spec(&shape, &rounded, 0.5, &[rim], 1.2);
    corners.extend(spec(&shape, &rounded, 0.5, &[inner], 1.2).1);
    assert_eq!(setback_reason(&shape, &edges, &corners).unwrap(), "", "builds");
    let built = fillet_setback(&shape, &edges, &corners).unwrap().expect("a solid");
    assert!(analyze(&built).unwrap().valid);
    let faces = topology(&built).unwrap()["faces"].as_array().unwrap().len();
    assert_eq!(faces, 9 + 5 + 2, "9 planes, 5 blends, 2 corner patches");
    // prisms: area r^2 (1 - pi / 4) over the 2.6 of the vertical edge and 3.8 of each floor edge (added), 3.8 of each top edge (removed); the inner patch adds 0.339 (13.10.3)
    let area = 0.25 * (1.0 - std::f64::consts::FRAC_PI_4);
    let prisms = area * (2.6 + 3.8 + 3.8) - area * (3.8 + 3.8);
    let change = mass_properties(&built).unwrap().volume - mass_properties(&shape).unwrap().volume;
    let rim_patch = change - prisms - 0.339;
    assert!(rim_patch > 0.03 && rim_patch < 0.07, "prisms + the inner patch 0.339 + the rim patch (measured +0.048): {rim_patch}");
    assert!(worst_patch_angle(&built) < 0.0095, "every edge of a patch is tangent, oriented: {}", worst_patch_angle(&built));
    let mass = mass_properties(&built).unwrap();
    let centroid = (mass.centroid[0], mass.centroid[1]);
    assert!((centroid.0 - centroid.1).abs() < 1e-6, "symmetric about x = y: {centroid:?}");
    assert!((mass.inertia[0] - mass.inertia[1]).abs() < 1e-6 * mass.inertia[0].abs(), "Ixx = Iyy: {:?}", mass.inertia);
    assert!((mass.inertia[4] - mass.inertia[5]).abs() < 1e-6 * mass.inertia[0].abs(), "Ixz = Iyz: {:?}", mass.inertia);
}

/// BLD §13.18: the foot of a boss on a plate. Each of the four foot vertices has two concave foot edges and the convex vertical edge of the boss; the plate face is reflex there. Four-fold symmetry:
/// the centroid is the centre of the boss and Ixx = Iyy.
#[test]
fn the_four_foot_corners_of_a_boss_on_a_plate_are_mixed_vertices_and_build() {
    let _serial = crate::serial_blends();
    let plate = make_box([0.0; 3], [20.0, 20.0, 4.0]).unwrap().unwrap();
    let boss = make_box([6.0, 6.0, 4.0], [8.0, 8.0, 6.0]).unwrap().unwrap();
    let shape = boolean(BooleanOp::Union, &plate, &boss, true).unwrap().unwrap();
    let feet = [[6.0, 6.0, 4.0], [14.0, 6.0, 4.0], [14.0, 14.0, 4.0], [6.0, 14.0, 4.0]];
    let mut rounded: Vec<usize> = feet.iter().flat_map(|corner| edges_at(&shape, *corner)).collect();
    rounded.sort_unstable();
    rounded.dedup();
    assert_eq!(rounded.len(), 8, "4 foot edges and 4 vertical edges of the boss");
    let (edges, mut corners) = spec(&shape, &rounded, 0.5, &feet[..1], 1.2);
    for corner in &feet[1..] {
        corners.extend(spec(&shape, &rounded, 0.5, &[*corner], 1.2).1);
    }
    assert_eq!(setback_reason(&shape, &edges, &corners).unwrap(), "", "builds");
    let built = fillet_setback(&shape, &edges, &corners).unwrap().expect("a solid");
    assert!(analyze(&built).unwrap().valid);
    let faces = topology(&built).unwrap()["faces"].as_array().unwrap().len();
    assert_eq!(faces, 11 + 8 + 4, "11 planes, 8 blends, 4 corner patches");
    let area = 0.25 * (1.0 - std::f64::consts::FRAC_PI_4);
    let prisms = area * 4.0 * 5.6 - area * 4.0 * 4.8;
    let change = mass_properties(&built).unwrap().volume - mass_properties(&shape).unwrap().volume;
    // measured: the four patches take -0.180 together (-0.045 each), the notch rim's one patch adds +0.048: two convex and one concave edge there, two concave and one convex here
    let patches = change - prisms;
    assert!(patches > -0.3 && patches < -0.1, "prisms {prisms} + 4 corner patches: {change} (patches {patches})");
    assert!(worst_patch_angle(&built) < 0.0095, "every edge of a patch is tangent, oriented: {}", worst_patch_angle(&built));
    let mass = mass_properties(&built).unwrap();
    assert!((mass.centroid[0] - 10.0).abs() < 1e-6 && (mass.centroid[1] - 10.0).abs() < 1e-6, "{:?}", mass.centroid);
    assert!((mass.inertia[0] - mass.inertia[1]).abs() < 1e-6 * mass.inertia[0].abs(), "Ixx = Iyy: {:?}", mass.inertia);
}

/// BLD §13.18: a 300 degree reflex face. A prism of an outline with a 60 degree wedge notch (apex D = (4, 5), mirror symmetric about y = 5): at the top and the bottom vertex of the notch
/// apex the top (bottom) face is 300 degrees and Q lies behind the vertex; the solid is symmetric, so the centroid is at y = 5 and the products of inertia with y vanish.
#[test]
fn a_300_degree_reflex_face_takes_the_path_through_q_and_keeps_the_mirror_symmetry() {
    let _serial = crate::serial_blends();
    let reach = 6.0 * (std::f64::consts::PI / 6.0).tan();
    let outline =
        [0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 10.0, 5.0 - reach, 0.0, 4.0, 5.0, 0.0, 10.0, 5.0 + reach, 0.0, 10.0, 10.0, 0.0, 0.0, 10.0, 0.0];
    let shape = crate::make_prism(&outline, [0.0, 0.0, 6.0]).unwrap().unwrap();
    let (top, bottom) = ([4.0, 5.0, 6.0], [4.0, 5.0, 0.0]);
    let mut rounded = edges_at(&shape, top);
    rounded.extend(edges_at(&shape, bottom));
    rounded.sort_unstable();
    rounded.dedup();
    assert_eq!(rounded.len(), 5, "two top edges, two bottom edges, the reflex vertical edge");
    let (edges, mut corners) = spec(&shape, &rounded, 0.4, &[top], 1.0);
    corners.extend(spec(&shape, &rounded, 0.4, &[bottom], 1.0).1);
    assert_eq!(setback_reason(&shape, &edges, &corners).unwrap(), "", "builds");
    let built = fillet_setback(&shape, &edges, &corners).unwrap().expect("a solid");
    assert!(analyze(&built).unwrap().valid);
    assert!(worst_patch_angle(&built) < 0.0095, "oriented tangents: {}", worst_patch_angle(&built));
    let mass = mass_properties(&built).unwrap();
    assert!((mass.centroid[1] - 5.0).abs() < 1e-6, "mirror symmetry about y = 5: {:?}", mass.centroid);
    assert!(
        mass.inertia[3].abs() < 1e-6 * mass.inertia[0] && mass.inertia[5].abs() < 1e-6 * mass.inertia[0],
        "Ixy = Iyz = 0 about the centroid: {:?}",
        mass.inertia
    );
}

/// BLD §13.18 review: a very narrow notch (2 degrees: the top face is 358 degrees, Q would be 0.4 x cot(1 degree) = 23 mm from the vertex) is refused by name at its vertex, never an
/// infinity or a path across the notch. In plain geometry the tangent distance of the notch edge itself (r cot(1 degree), the same 23 mm) outgrows the setback first, so the refusal is
/// BLD_SETBACK_TOO_SHORT; the guard on Q (in the face, in front of the contact points) is behind it and is not reachable here.
#[test]
fn a_reflex_face_too_narrow_for_its_path_is_refused_by_name() {
    let _serial = crate::serial_blends();
    let reach = 6.0 * (std::f64::consts::PI / 180.0).tan();
    let outline =
        [0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 10.0, 5.0 - reach, 0.0, 4.0, 5.0, 0.0, 10.0, 5.0 + reach, 0.0, 10.0, 10.0, 0.0, 0.0, 10.0, 0.0];
    let shape = crate::make_prism(&outline, [0.0, 0.0, 6.0]).unwrap().unwrap();
    let top = [4.0, 5.0, 6.0];
    let rounded = edges_at(&shape, top);
    let (edges, corners) = spec(&shape, &rounded, 0.4, &[top], 1.0);
    let reason = setback_reason(&shape, &edges, &corners).unwrap();
    assert!(reason.starts_with("[BLD_") && reason.contains("[4, 5, 6]") && reason.contains("22.9"), "{reason}");
}

/// BLD §13.18 review: a radius that varies along the edges of a mixed corner. The notch rim with its two top edges tapering 0.5 -> 0.3 builds, or is refused by name: never a NaN, never an
/// invalid solid.
#[test]
fn a_taper_on_a_mixed_corner_builds_or_is_refused_by_name() {
    let _serial = crate::serial_blends();
    let shape = notched_cube();
    let (rim, inner) = ([5.0, 5.0, 10.0], [5.0; 3]);
    let mut rounded = edges_at(&shape, rim);
    rounded.extend(edges_at(&shape, inner));
    rounded.sort_unstable();
    rounded.dedup();
    let top: Vec<usize> = edges_at(&shape, rim).into_iter().filter(|edge| !edges_at(&shape, inner).contains(edge)).collect();
    let tapers: Vec<(usize, f64, f64)> =
        rounded.iter().map(|&edge| if top.contains(&edge) { (edge, 0.5, 0.3) } else { (edge, 0.5, 0.5) }).collect();
    let (edges, mut corners) = spec_tapered(&shape, &tapers, &[rim], 1.2);
    corners.extend(spec_tapered(&shape, &tapers, &[inner], 1.2).1);
    let reason = setback_reason(&shape, &edges, &corners).unwrap();
    if reason.is_empty() {
        let built = fillet_setback(&shape, &edges, &corners).unwrap().expect("a solid");
        assert!(analyze(&built).unwrap().valid);
        assert!(worst_patch_angle(&built) < 0.0095);
        assert!(mass_properties(&built).unwrap().volume.is_finite());
    } else {
        assert!(reason.starts_with("[BLD_CORNER_") || reason.starts_with("[BLD_SETBACK_"), "{reason}");
    }
}

#[test]
fn a_pocket_with_all_its_inner_edges_rounded_and_four_setback_corners() {
    let _serial = crate::serial_blends();
    let pocket = make_box([3.0, 3.0, 3.0], [4.0, 4.0, 8.0]).unwrap().unwrap();
    let shape = boolean(BooleanOp::Subtract, &cube(10.0), &pocket, true).unwrap().unwrap();
    let before = mass_properties(&shape).unwrap().volume;
    let floor_corners = [[3.0, 3.0, 3.0], [7.0, 3.0, 3.0], [7.0, 7.0, 3.0], [3.0, 7.0, 3.0]];
    let mut rounded: Vec<usize> = floor_corners.iter().flat_map(|corner| edges_at(&shape, *corner)).collect();
    rounded.sort_unstable();
    rounded.dedup();
    assert_eq!(rounded.len(), 8, "4 floor edges and 4 vertical edges");
    let (edges, corners) = spec(&shape, &rounded, 0.5, &floor_corners, 1.3);
    assert_eq!(setback_reason(&shape, &edges, &corners).unwrap(), "");
    let built = fillet_setback(&shape, &edges, &corners).unwrap().expect("a solid");
    assert!(analyze(&built).unwrap().valid);
    let faces = topology(&built).unwrap()["faces"].as_array().unwrap().len();
    assert_eq!(faces, 11 + 8 + 4, "11 planes, 8 blends, 4 corner patches");
    assert!(mass_properties(&built).unwrap().volume > before);
    assert!(worst_tangent_angle(&built) < 0.01);
}

#[test]
fn a_radius_that_varies_linearly_along_the_edges_still_gets_tangent_corner_patches() {
    let _serial = crate::serial_blends();
    let shape = cube(10.0);
    let tapers: Vec<(usize, f64, f64)> = (0..12).map(|edge| (edge, 0.8, 1.2)).collect();
    let (edges, corners) = spec_tapered(&shape, &tapers, &cube_vertices(10.0), 2.5);
    assert_eq!(setback_reason(&shape, &edges, &corners).unwrap(), "", "builds");
    let built = fillet_setback(&shape, &edges, &corners).unwrap().expect("a solid");
    assert!(analyze(&built).unwrap().valid);
    let faces = topology(&built).unwrap()["faces"].as_array().unwrap().len();
    assert_eq!(faces, 26, "6 planes, 12 tapered blends, 8 corner patches");
    let worst = worst_tangent_angle(&built);
    assert!(worst < 0.01, "tapered blends, patches and faces are tangent: {worst}");
    // the smaller blends take less material than 1.2 everywhere and more than 0.8 everywhere
    let volume = mass_properties(&built).unwrap().volume;
    let (low, high) = (mass_properties(&corner_cube(0.8)).unwrap().volume, mass_properties(&corner_cube(1.2)).unwrap().volume);
    assert!(volume < low && volume > high, "{high} < {volume} < {low}");
}

/// The cube rounded with a constant radius and setback 2.5 at the 8 corners (the bounds of the tapered one).
fn corner_cube(radius: f64) -> Shape {
    let shape = cube(10.0);
    let all: Vec<usize> = (0..12).collect();
    let (edges, corners) = spec(&shape, &all, radius, &cube_vertices(10.0), 2.5);
    fillet_setback(&shape, &edges, &corners).unwrap().expect("a solid")
}

#[test]
fn a_setback_shorter_than_the_tapered_blends_reach_is_named_with_the_larger_radius_there() {
    let _serial = crate::serial_blends();
    let shape = cube(10.0);
    let tapers: Vec<(usize, f64, f64)> = (0..12).map(|edge| (edge, 0.5, 2.0)).collect();
    let (edges, corners) = spec_tapered(&shape, &tapers, &cube_vertices(10.0), 1.5);
    let reason = setback_reason(&shape, &edges, &corners).unwrap();
    assert!(reason.starts_with("[BLD_SETBACK_TOO_SHORT]"), "{reason}");
}

#[test]
fn profile_corners_on_concave_edges_are_refused_by_name() {
    let _serial = crate::serial_blends();
    let shape = notched_cube();
    let specs: Vec<f64> = edges_at(&shape, [5.0; 3]).iter().flat_map(|&edge| [edge as f64, 0.0, 0.5, 0.5, f64::NAN, -1.0, 0.0]).collect();
    assert!(fillet_profile_blend(&shape, &specs, &[], &[], 0.0, 0.5).unwrap().is_none());
    let reason = profile_blend_reason(&shape, &specs, &[], &[], 0.0, 0.5).unwrap();
    assert!(reason.contains("is concave: profile corners round convex edges"), "{reason}");
}

/// The corner at the origin of a cube with its three edges there rounded with a radius from `start` to `end` along their 10 mm.
fn tapered_corner(shape: &Shape, start: f64, end: f64, setback: f64) -> (Vec<f64>, Vec<f64>) {
    let tapers: Vec<(usize, f64, f64)> = edges_at(shape, [0.0; 3]).into_iter().map(|edge| (edge, start, end)).collect();
    spec_tapered(shape, &tapers, &[[0.0; 3]], setback)
}

#[test]
fn the_least_setback_of_a_tapered_corner_is_the_fixed_point_and_builds() {
    let _serial = crate::serial_blends();
    let shape = cube(10.0);
    let (edges, corners) = tapered_corner(&shape, 0.5, 2.0, 0.5);
    let reason = setback_reason(&shape, &edges, &corners).unwrap();
    assert!(reason.starts_with("[BLD_SETBACK_TOO_SHORT]"), "{reason}");
    let minimum: f64 = reason.split("must exceed ").nth(1).and_then(|rest| rest.split(' ').next()).unwrap().parse().unwrap();
    // r(d) = 0.5 + 0.15 d, and the setback must exceed the tangent distance (45 degrees: equal to the radius): d > 0.5 / (1 - 0.15)
    assert!((minimum - 0.5 / 0.85).abs() < 1e-5, "{minimum}");
    let (edges, corners) = tapered_corner(&shape, 0.5, 2.0, minimum * (1.0 + 1e-6));
    assert_eq!(setback_reason(&shape, &edges, &corners).unwrap(), "", "the reported minimum builds");
    let (edges, corners) = tapered_corner(&shape, 0.5, 2.0, minimum * (1.0 - 1e-6));
    assert!(setback_reason(&shape, &edges, &corners).unwrap().starts_with("[BLD_SETBACK_TOO_SHORT]"));
}

#[test]
fn a_radius_that_grows_as_fast_as_the_setback_is_named() {
    let _serial = crate::serial_blends();
    let shape = cube(10.0);
    let (edges, corners) = tapered_corner(&shape, 0.5, 12.0, 3.0);
    let reason = setback_reason(&shape, &edges, &corners).unwrap();
    assert!(reason.starts_with("[BLD_CORNER_UNSUPPORTED]") && reason.contains("no setback outruns it"), "{reason}");
}

/// The number after "must exceed " in a BLD_SETBACK_TOO_SHORT reason, and the `edge N value` pairs of its list of least setbacks.
fn minimums(reason: &str) -> (f64, Vec<(usize, f64)>) {
    assert!(reason.starts_with("[BLD_SETBACK_TOO_SHORT]"), "{reason}");
    let first = reason.split("must exceed ").nth(1).and_then(|rest| rest.split(' ').next()).unwrap().parse().unwrap();
    let list = reason.split(": edge ").nth(1).unwrap().split(';').next().unwrap();
    let pairs = format!("edge {list}")
        .split(", ")
        .map(|entry| {
            let mut words = entry.split(' ').skip(1);
            (words.next().unwrap().parse().unwrap(), words.next().unwrap().parse().unwrap())
        })
        .collect();
    (first, pairs)
}

/// Whether the corner built with the same setback `scale` x on every edge builds: the reported minimum x (1 + 1e-6) does, x (1 - 1e-6) does not.
fn assert_minimum_is_sharp(shape: &Shape, edges: &[(usize, f64, f64)], vertex: [f64; 3], first: f64) {
    let (flat_edges, corners) = spec_tapered(shape, edges, &[vertex], first * (1.0 + 1e-6));
    assert_eq!(setback_reason(shape, &flat_edges, &corners).unwrap(), "", "the reported minimum {first} builds");
    let (flat_edges, corners) = spec_tapered(shape, edges, &[vertex], first * (1.0 - 1e-6));
    assert!(setback_reason(shape, &flat_edges, &corners).unwrap().starts_with("[BLD_SETBACK_TOO_SHORT]"), "just under {first} is refused");
}

#[test]
fn the_reported_minimum_is_the_joint_one_at_an_angle_other_than_a_right_one() {
    let _serial = crate::serial_blends();
    let shape = pyramid();
    let lateral: Vec<(usize, f64, f64)> = topology(&shape).unwrap()["edges"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .filter(|(_, edge)| num(&edge["start"][2]) > 9.0 || num(&edge["end"][2]) > 9.0)
        .map(|(index, _)| (index, 0.5, 1.0))
        .collect();
    let apex = [5.0, 5.0, 10.0];
    let (edges, corners) = spec_tapered(&shape, &lateral, &[apex], 0.3);
    let (first, _) = minimums(&setback_reason(&shape, &edges, &corners).unwrap());
    assert_minimum_is_sharp(&shape, &lateral, apex, first);
}

#[test]
fn the_reported_minimum_is_the_joint_one_for_unequal_edges_at_right_angles() {
    let _serial = crate::serial_blends();
    let shape = cube(10.0);
    let mut tapers: Vec<(usize, f64, f64)> = edges_at(&shape, [0.0; 3]).into_iter().map(|edge| (edge, 0.5, 0.5)).collect();
    tapers[0].2 = 2.0;
    let (edges, corners) = spec_tapered(&shape, &tapers, &[[0.0; 3]], 0.3);
    let (first, _) = minimums(&setback_reason(&shape, &edges, &corners).unwrap());
    assert_minimum_is_sharp(&shape, &tapers, [0.0; 3], first);
}

#[test]
fn with_a_setback_per_edge_the_reported_minimums_are_the_least_fixed_point_of_all_the_edges() {
    let _serial = crate::serial_blends();
    let shape = cube(10.0);
    let tapers: Vec<(usize, f64, f64)> = edges_at(&shape, [0.0; 3]).into_iter().map(|edge| (edge, 0.5, 2.0)).collect();
    let flat_edges: Vec<f64> = tapers.iter().flat_map(|&(edge, start, end)| [edge as f64, start, end]).collect();
    let corner_with = |distances: &[f64]| -> Vec<f64> {
        let mut flat = vec![0.0, 0.0, 0.0, tapers.len() as f64];
        for (&(edge, _, _), &distance) in tapers.iter().zip(distances) {
            flat.extend([edge as f64, distance]);
        }
        flat
    };
    let reason = setback_reason(&shape, &flat_edges, &corner_with(&[0.3, 0.9, 0.5])).unwrap();
    let (_, least) = minimums(&reason);
    assert_eq!(least.len(), 3, "{reason}");
    let scaled = |factor: f64| -> Vec<f64> { least.iter().map(|&(_, value)| value * factor).collect() };
    assert_eq!(setback_reason(&shape, &flat_edges, &corner_with(&scaled(1.0 + 1e-6))).unwrap(), "", "{least:?}");
    assert!(setback_reason(&shape, &flat_edges, &corner_with(&scaled(1.0 - 1e-6))).unwrap().starts_with("[BLD_SETBACK_TOO_SHORT]"));
}

/// The four lateral edges of `tall_pyramid(18.0)` (a 30 degree angle between two of them on a face) with a radius from `near` at the base to `far` at the apex
/// when `growing`, else the other way, and the apex.
fn narrow_apex(near: f64, far: f64, growing: bool) -> (Shape, Vec<(usize, f64, f64)>, [f64; 3]) {
    let shape = tall_pyramid(18.0);
    let lateral: Vec<(usize, f64, f64)> = topology(&shape).unwrap()["edges"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .filter(|(_, edge)| num(&edge["start"][2]) > 17.0 || num(&edge["end"][2]) > 17.0)
        .map(|(index, edge)| {
            let apex_first = num(&edge["start"][2]) > 17.0;
            let (at_apex, at_base) = if growing { (far, near) } else { (near, far) };
            if apex_first {
                (index, at_apex, at_base)
            } else {
                (index, at_base, at_apex)
            }
        })
        .collect();
    (shape, lateral, [5.0, 5.0, 18.0])
}

#[test]
fn a_narrow_corner_whose_blends_outgrow_every_uniform_setback_is_named() {
    let _serial = crate::serial_blends();
    // two lateral edges of a face meet at about 30 degrees (sin 0.5, cos 0.87): a radius slope g with g (1 + cos) >= sin leaves no uniform setback (and per-edge setbacks that feed each other never settle)
    for far in [8.0, 10.0] {
        let (shape, lateral, apex) = narrow_apex(0.5, far, false);
        let (edges, corners) = spec_tapered(&shape, &lateral, &[apex], 0.1);
        let reason = setback_reason(&shape, &edges, &corners).unwrap();
        assert!(reason.starts_with("[BLD_CORNER_UNSUPPORTED]") && reason.contains("no setback outruns the blends"), "{reason}");
    }
    // a steeper law makes the neighbour's reach grow faster than the setback on its own
    let (shape, lateral, apex) = narrow_apex(0.5, 15.0, false);
    let (edges, corners) = spec_tapered(&shape, &lateral, &[apex], 0.1);
    let reason = setback_reason(&shape, &edges, &corners).unwrap();
    assert!(reason.starts_with("[BLD_CORNER_UNSUPPORTED]") && reason.contains("the reach of its neighbour's blend along edge"), "{reason}");
}

#[test]
fn per_edge_setbacks_whose_blends_outgrow_each_other_do_not_settle_and_are_named() {
    let _serial = crate::serial_blends();
    let (shape, lateral, apex) = narrow_apex(0.5, 10.0, false);
    let flat_edges: Vec<f64> = lateral.iter().flat_map(|&(edge, start, end)| [edge as f64, start, end]).collect();
    let mut flat = vec![apex[0], apex[1], apex[2], lateral.len() as f64];
    for (k, &(edge, _, _)) in lateral.iter().enumerate() {
        flat.extend([edge as f64, 0.1 + 0.05 * k as f64]);
    }
    let reason = setback_reason(&shape, &flat_edges, &flat).unwrap();
    assert!(reason.starts_with("[BLD_CORNER_UNSUPPORTED]") && reason.contains("they do not settle"), "{reason}");
}

/// BLD §13.17: the corner builder keeps a void too. A 10 cube with a spherical pocket (r 3 at its centre), one corner rounded with a setback corner: the volume is the
/// same corner on the solid cube less the pocket.
#[test]
fn a_setback_corner_on_a_box_with_a_spherical_pocket_keeps_the_pocket() {
    let _serial = crate::serial_blends();
    let pocket = crate::placed(&crate::make_sphere(3.0).unwrap().unwrap(), [0.0; 3], [5.0; 3], [0.0; 3]).unwrap().unwrap();
    let hollow = boolean(BooleanOp::Subtract, &cube(10.0), &pocket, true).unwrap().unwrap();
    let corner = [0.0; 3];
    let rounded = |shape: &Shape| {
        let meeting = edges_at(shape, corner);
        let (edges, corners) = spec(shape, &meeting, 0.5, &[corner], 1.2);
        fillet_setback(shape, &edges, &corners).unwrap().expect("a solid")
    };
    let with_pocket = rounded(&hollow);
    let solid = rounded(&cube(10.0));
    let void = 4.0 / 3.0 * std::f64::consts::PI * 27.0;
    let (a, b) = (mass_properties(&with_pocket).unwrap().volume, mass_properties(&solid).unwrap().volume);
    assert!((a - (b - void)).abs() < 1e-6 * b, "{a} vs {}", b - void);
    assert!(analyze(&with_pocket).unwrap().valid);
    assert_eq!(
        topology(&with_pocket).unwrap()["faces"].as_array().unwrap().len(),
        topology(&solid).unwrap()["faces"].as_array().unwrap().len() + 1
    );
}

/// BLD §13.20: the corner fills run in parallel and the build does not depend on the number of threads. The 8-corner cube and the four feet of the boss are built on 1, 2 and 8 threads,
/// twice each: the volume and the area to the bit, the face count and the BRepCheck result are the same.
#[test]
fn the_corner_fills_give_the_same_solid_on_any_number_of_threads() {
    let _serial = crate::serial_blends();
    let cube_shape = cube(10.0);
    let all: Vec<usize> = (0..12).collect();
    let (cube_edges, cube_corners) = spec(&cube_shape, &all, 1.0, &cube_vertices(10.0), 2.0);
    let plate = make_box([0.0; 3], [20.0, 20.0, 4.0]).unwrap().unwrap();
    let boss = make_box([6.0, 6.0, 4.0], [8.0, 8.0, 6.0]).unwrap().unwrap();
    let boss_shape = boolean(BooleanOp::Union, &plate, &boss, true).unwrap().unwrap();
    let feet = [[6.0, 6.0, 4.0], [14.0, 6.0, 4.0], [14.0, 14.0, 4.0], [6.0, 14.0, 4.0]];
    let mut rounded: Vec<usize> = feet.iter().flat_map(|corner| edges_at(&boss_shape, *corner)).collect();
    rounded.sort_unstable();
    rounded.dedup();
    let (boss_edges, mut boss_corners) = spec(&boss_shape, &rounded, 0.5, &feet[..1], 1.2);
    for corner in &feet[1..] {
        boss_corners.extend(spec(&boss_shape, &rounded, 0.5, &[*corner], 1.2).1);
    }
    let fingerprint = |shape: &Shape, edges: &[f64], corners: &[f64]| {
        let built = fillet_setback(shape, edges, corners).unwrap().expect("a solid");
        let mass = mass_properties(&built).unwrap();
        (
            mass.volume.to_bits(),
            mass.area.to_bits(),
            topology(&built).unwrap()["faces"].as_array().unwrap().len(),
            analyze(&built).unwrap().valid,
        )
    };
    let mut reference = None;
    for threads in [1, 2, 8, 1, 8] {
        crate::test_bridge::set_corner_threads(threads);
        let both = (fingerprint(&cube_shape, &cube_edges, &cube_corners), fingerprint(&boss_shape, &boss_edges, &boss_corners));
        assert_eq!((both.0 .2, both.1 .2), (26, 23), "faces on {threads} threads");
        assert!(both.0 .3 && both.1 .3, "valid on {threads} threads");
        if let Some(first) = reference {
            assert_eq!(both, first, "the solid is the same on {threads} threads as on the first run");
        }
        reference = reference.or(Some(both));
    }
    crate::test_bridge::set_corner_threads(0);
}

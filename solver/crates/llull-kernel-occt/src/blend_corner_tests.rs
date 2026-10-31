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

/// The same step built with the plate patches only (the fallback of the star), the hooks put back.
fn plate_of(shape: &Shape, edges: &[f64], corners: &[f64]) -> Shape {
    let _reset = CornerHooks;
    crate::test_bridge::set_corner_exact_patch(0);
    fillet_setback(shape, edges, corners).unwrap().expect("a solid")
}

fn volume_change(built: &Shape, shape: &Shape) -> f64 {
    mass_properties(built).unwrap().volume - mass_properties(shape).unwrap().volume
}

/// The faces that are not corner patches, and the corner patches (faces named `blend(v:...`: the sub-patches of the exact stars, 13.21).
fn split_faces(faces: &[Value]) -> (usize, usize) {
    let patches = faces.iter().filter(|face| face["name"].as_str().is_some_and(|name| name.starts_with("blend(v:"))).count();
    (faces.len() - patches, patches)
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
        if faces.as_array().unwrap().len() < 2 {
            continue; // the collapsed side of a sub-patch: a point, no neighbour
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
    let (others, patches) = split_faces(faces);
    assert_eq!(others, 18, "6 planes, 12 blend cylinders");
    assert_eq!(patches, 8 * 6, "a star of 6 sub-patches at each of the 8 corners");
    let cylinders: Vec<&Value> = faces.iter().filter(|face| face["surface"] == "cylinder").collect();
    assert_eq!(cylinders.len(), 12);
    for cylinder in &cylinders {
        let span = cylinder["axis"]["span"].as_array().unwrap();
        assert!((num(&span[1]) - num(&span[0]) - 6.0).abs() < 1e-6, "a blend spans 10 - 2 - 2: {cylinder}");
    }
    let patches = faces.iter().filter(|face| face["name"].as_str().is_some_and(|name| name.starts_with("blend(v:"))).count();
    assert_eq!(patches, 8 * 6, "each sub-patch of a corner star is named after the edges meeting there");
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
    let (others, patches) = split_faces(topology(&built).unwrap()["faces"].as_array().unwrap());
    assert_eq!(others, 10, "4 sides, 2 base triangles, 4 blends");
    assert_eq!(patches, 8, "the apex star: 2 sub-patches per blend");
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
    let (others, patches) = split_faces(faces);
    assert_eq!((others, patches), (12, 6), "9 planes, 3 blend cylinders; one star of 6 sub-patches");
    assert_eq!(faces.iter().filter(|face| face["surface"] == "cylinder").count(), 3);
    for cylinder in faces.iter().filter(|face| face["surface"] == "cylinder") {
        let span = cylinder["axis"]["span"].as_array().unwrap();
        assert!((num(&span[1]) - num(&span[0]) - 3.8).abs() < 1e-6, "a blend spans 5 - 1.2: {cylinder}");
    }
    assert_eq!(
        faces.iter().filter(|face| face["name"].as_str().is_some_and(|name| name.starts_with("blend(v:"))).count(),
        6,
        "one star of 6 sub-patches"
    );
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
    let (others, patches) = split_faces(topology(&built).unwrap()["faces"].as_array().unwrap());
    assert_eq!((others, patches), (9 + 6, 12), "9 planes, 6 blends, a star of 6 sub-patches at each of the 2 corners");
    assert!(worst_tangent_angle(&built) < 0.01);
    let plate = plate_of(&shape, &edges, &corners);
    assert_eq!(split_faces(topology(&plate).unwrap()["faces"].as_array().unwrap()), (9 + 6, 2), "the plate: one patch per corner");
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
    let (others, patches) = split_faces(topology(&built).unwrap()["faces"].as_array().unwrap());
    assert_eq!((others, patches), (9 + 5, 7 + 6), "9 planes, 5 blends, a star of 7 sub-patches at the rim and of 6 at the inner vertex");
    // prisms: area r^2 (1 - pi / 4) over the 2.6 of the vertical edge and 3.8 of each floor edge (added), 3.8 of each top edge (removed); the inner patch adds 0.339 (13.10.3)
    let area = 0.25 * (1.0 - std::f64::consts::FRAC_PI_4);
    let prisms = area * (2.6 + 3.8 + 3.8) - area * (3.8 + 3.8);
    let change = mass_properties(&built).unwrap().volume - mass_properties(&shape).unwrap().volume;
    let rim_patch = change - prisms - 0.339;
    // the exact star at this mixed corner takes 0.096 less than the thin plate does (13.21.4: the centre rule is weakest on mixed corners); both at their measured values
    assert!((rim_patch + 0.048).abs() < 0.02, "prisms + the inner patch 0.339 + the rim star (measured -0.048): {rim_patch}");
    let plate = plate_of(&shape, &edges, &corners);
    let plate_rim = volume_change(&plate, &shape) - prisms - 0.339;
    assert!(plate_rim > 0.03 && plate_rim < 0.07, "the rim plate (measured +0.048): {plate_rim}");
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
    let (others, patches) = split_faces(topology(&built).unwrap()["faces"].as_array().unwrap());
    assert_eq!((others, patches), (11 + 8, 4 * 7), "11 planes, 8 blends; a star of 7 sub-patches at each of the 4 feet");
    let area = 0.25 * (1.0 - std::f64::consts::FRAC_PI_4);
    let prisms = area * 4.0 * 5.6 - area * 4.0 * 4.8;
    let change = mass_properties(&built).unwrap().volume - mass_properties(&shape).unwrap().volume;
    // measured: the four patches take -0.180 together (-0.045 each), the notch rim's one patch adds +0.048: two convex and one concave edge there, two concave and one convex here
    let patches = change - prisms;
    // the four stars add +0.193 together (measured); the thin plate takes -0.180, the star 0.094 less at each foot (13.21.4: weakest on mixed corners)
    assert!((patches - 0.193).abs() < 0.02, "prisms {prisms} + 4 stars: {change} (patches {patches})");
    let plate = plate_of(&shape, &edges, &corners);
    let plate_patches = volume_change(&plate, &shape) - prisms;
    assert!(plate_patches > -0.3 && plate_patches < -0.1, "the plates (measured -0.180): {plate_patches}");
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
    assert!(worst_tangent_angle(&built) < 0.01, "{}", worst_tangent_angle(&built));
    let topo = topology(&built).unwrap();
    let (others, patches) = split_faces(topo["faces"].as_array().unwrap());
    assert_eq!((others, patches), (9 + 5, 14), "7 sides and 2 caps, 5 blends, a star of 7 sub-patches at each of the 2 corners");
    // Q = V - l / sin(30 degrees) along the bisector: 0.8 behind the apex (4, 5); the polyline corner is a vertex of the built solid on both faces
    let meeting = |q: [f64; 3]| {
        topo["edges"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| {
                (0..3).all(|a| (num(&e["start"][a]) - q[a]).abs() < 1e-6) || (0..3).all(|a| (num(&e["end"][a]) - q[a]).abs() < 1e-6)
            })
            .count()
    };
    assert_eq!(
        (meeting([3.2, 5.0, 6.0]), meeting([3.2, 5.0, 0.0])),
        (3, 3),
        "the two segments of the path and the spoke of the star meet at Q on the top face and on the bottom face"
    );
    // closed form of the prisms: the 4 convex edges (r 0.4, 5.93 long each between the setback and the free end) are removed, the reflex vertical edge (4.0) added: -0.677; the patches take the rest
    // (measured +0.477 together, +0.24 each: the sharp stub of a 300 degree corner is bigger than the notch rim's)
    let change = mass_properties(&built).unwrap().volume - mass_properties(&shape).unwrap().volume;
    let area = 0.16 * (1.0 - std::f64::consts::FRAC_PI_4);
    let prisms = area * 4.0 - area * 4.0 * 5.9282;
    // the exact stars add +0.187 (measured) where the plate adds +0.477 (13.21.4)
    assert!((change - prisms - 0.187).abs() < 0.02, "prisms {prisms} + 2 stars: {change}");
    let plate = plate_of(&shape, &edges, &corners);
    let plate_change = volume_change(&plate, &shape) - prisms;
    assert!(plate_change > 0.4 && plate_change < 0.56, "the plates (measured +0.477): {plate_change}");
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
    assert_eq!(setback_reason(&shape, &edges, &corners).unwrap(), "", "builds");
    let built = fillet_setback(&shape, &edges, &corners).unwrap().expect("a solid");
    assert!(analyze(&built).unwrap().valid);
    let (others, patches) = split_faces(topology(&built).unwrap()["faces"].as_array().unwrap());
    assert_eq!((others, patches), (9 + 5, 7 + 6), "9 planes, 5 blends, a star of 7 sub-patches at the rim and of 6 at the inner vertex");
    // closed form of the prisms (r^2 (1 - pi / 4) x the length between the setback section and the free end, r linear): the vertical edge (0.5, 2.6) and the two floor edges (0.5, 3.8)
    // are added, the two top edges tapering 0.5 -> 0.3 over 3.8 are removed (0.234 or 0.297, by the end the taper starts at); the inner patch adds 0.339 and the rim patch 0.05 to 0.1
    let area = 1.0 - std::f64::consts::FRAC_PI_4;
    let added = area * 0.25 * (2.6 + 2.0 * 3.8);
    let removed = |first: f64, last: f64| 2.0 * area * 3.8 * (first * first + first * last + last * last) / 3.0;
    let (low, high) = (added - removed(0.348, 0.5) + 0.339, added - removed(0.3, 0.452) + 0.339 + 0.1);
    let change = mass_properties(&built).unwrap().volume - mass_properties(&shape).unwrap().volume;
    assert!(change > low && change < high, "prisms + patches in ({low}, {high}): {change} (observed 0.724)");
    assert!(worst_patch_angle(&built) < 0.0095, "{}", worst_patch_angle(&built));
    assert!(worst_tangent_angle(&built) < 0.01, "{}", worst_tangent_angle(&built));
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
    let (others, patches) = split_faces(topology(&built).unwrap()["faces"].as_array().unwrap());
    assert_eq!(others, 11 + 8, "11 planes, 8 blends");
    assert_eq!(patches, 4 * 6, "a star of 6 sub-patches at each of the 4 corners");
    let plate = plate_of(&shape, &edges, &corners);
    assert_eq!(split_faces(topology(&plate).unwrap()["faces"].as_array().unwrap()), (11 + 8, 4), "the plate: one patch per corner");
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
    let (others, patches) = split_faces(topology(&built).unwrap()["faces"].as_array().unwrap());
    assert_eq!((others, patches), (18, 8 * 6), "6 planes, 12 tapered blends; a star of 6 sub-patches at each of the 8 corners");
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
    let _reset = CornerHooks;
    crate::test_bridge::set_corner_exact_patch(0);
    let mut reference = None;
    for threads in [1, 2, 8, 1, 8] {
        crate::test_bridge::set_corner_threads(threads);
        let both = (fingerprint(&cube_shape, &cube_edges, &cube_corners), fingerprint(&boss_shape, &boss_edges, &boss_corners));
        assert_eq!((both.0 .2, both.1 .2), (26, 23), "faces on {threads} threads");
        assert!(both.0 .3 && both.1 .3, "valid on {threads} threads");
        // the hook reports the threads the fill planned: a 1 would make this test compare the serial build with itself
        assert_eq!(
            crate::test_bridge::last_corner_threads(),
            if threads == 1 { 1 } else { 4.min(threads) },
            "threads used for {threads} requested (the boss has 4 corners, the last build)"
        );
        if let Some(first) = reference {
            assert_eq!(both, first, "the solid is the same on {threads} threads as on the first run");
        }
        reference = reference.or(Some(both));
    }
}

/// Puts the test hooks of the corner fills back, even when the test fails.
struct CornerHooks;

impl Drop for CornerHooks {
    fn drop(&mut self) {
        crate::test_bridge::set_corner_threads(0);
        crate::test_bridge::set_corner_fault(-1);
        crate::test_bridge::set_corner_spawn_limit(-1);
        crate::test_bridge::set_corner_exact_patch(1);
        crate::test_bridge::set_corner_trim(false);
    }
}

fn cube_corner_step() -> (Shape, Vec<f64>, Vec<f64>) {
    let shape = cube(10.0);
    let all: Vec<usize> = (0..12).collect();
    let (edges, corners) = spec(&shape, &all, 1.0, &cube_vertices(10.0), 2.0);
    (shape, edges, corners)
}

/// BLD §13.20 review: whatever a worker throws (here std::bad_alloc in the fill of corner 3) reaches the caller as an error from the build, in the corner order of a serial run; it does not
/// end the process (a worker that lets it escape calls std::terminate).
#[test]
fn an_exception_in_a_parallel_fill_is_an_error_of_the_build_not_the_end_of_the_process() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let (shape, edges, corners) = cube_corner_step();
    for threads in [1, 8] {
        crate::test_bridge::set_corner_threads(threads);
        crate::test_bridge::set_corner_fault(3);
        assert!(fillet_setback(&shape, &edges, &corners).is_err(), "{threads} threads");
    }
    crate::test_bridge::set_corner_fault(-1);
    assert!(fillet_setback(&shape, &edges, &corners).unwrap().is_some());
}

/// BLD §13.20 review: when a worker thread cannot be created (the second one here) the calling thread and the started ones take its jobs, every started thread is joined, and the solid is the same
/// as on the planned threads.
#[test]
fn a_thread_that_cannot_be_created_leaves_its_jobs_to_the_others() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let (shape, edges, corners) = cube_corner_step();
    let volume = |built: &Shape| mass_properties(built).unwrap().volume.to_bits();
    crate::test_bridge::set_corner_threads(1);
    let reference = volume(&fillet_setback(&shape, &edges, &corners).unwrap().expect("a solid"));
    crate::test_bridge::set_corner_threads(8);
    for limit in [0, 1, 3] {
        crate::test_bridge::set_corner_spawn_limit(limit);
        let built = fillet_setback(&shape, &edges, &corners).unwrap().expect("a solid");
        assert_eq!(volume(&built), reference, "{limit} workers created");
        assert!(analyze(&built).unwrap().valid);
    }
}

/// BLD §13.18 review: the guards of the mixed corner are exercised on shapes the test chooses (cfg(test) seams in blend_corner.cxx). The oriented patch check on the blend face of a filleted block
/// reads about 0 across its tangent edges, and about pi once the face is turned round in a rebuilt shell; the boundary angle is measured for an intact boundary and refuses (-1, not
/// measured) when a loop edge is missing from it.
#[test]
fn the_guards_of_the_mixed_corner_fail_on_a_patch_turned_round_and_on_an_unmeasured_boundary() {
    let _serial = crate::serial_blends();
    let block = make_box([0.0; 3], [20.0, 10.0, 5.0]).unwrap().unwrap();
    let topo = topology(&block).unwrap();
    let top = topo["edges"]
        .as_array()
        .unwrap()
        .iter()
        .position(|e| ["start", "end"].iter().all(|key| (num(&e[key][2]) - 5.0).abs() < 1e-9 && (num(&e[key][1]) - 10.0).abs() < 1e-9))
        .unwrap() as u32;
    let rounded = crate::features::fillet(&block, &[top], 1.0, None).unwrap().unwrap();
    let blend =
        topology(&rounded).unwrap()["faces"].as_array().unwrap().iter().position(|face| face["surface"] == "cylinder").unwrap() as i32;
    let as_built = crate::test_bridge::oriented_angle(&rounded, blend, false);
    let turned = crate::test_bridge::oriented_angle(&rounded, blend, true);
    assert!((0.0..1e-6).contains(&as_built), "a blend tangent to its faces, outward normals agree: {as_built}");
    assert!((turned - std::f64::consts::PI).abs() < 1e-6, "the same face turned round faces the other way: {turned}");
    let whole = crate::test_bridge::boundary_angle(&rounded, blend, false);
    assert!(whole >= 0.0, "every edge of an intact boundary is measured: {whole}");
    assert_eq!(
        crate::test_bridge::boundary_angle(&rounded, blend, true),
        -1.0,
        "a loop edge missing from the boundary is not measured: the check fails closed"
    );
}

/// The largest distance between the two faces along every edge of every corner patch (the `g0` of the continuity samples, 21 per edge).
fn worst_patch_gap(shape: &Shape) -> f64 {
    let topo = topology(shape).unwrap();
    let patches: Vec<usize> = topo["faces"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .filter(|(_, face)| face["name"].as_str().is_some_and(|name| name.starts_with("blend(v:")))
        .map(|(index, _)| index)
        .collect();
    let graph = crate::queries::face_graph(shape).unwrap();
    let mut worst: f64 = 0.0;
    for (edge, faces) in graph["edgeFaces"].as_array().unwrap().iter().enumerate() {
        let around = faces.as_array().unwrap();
        if around.len() < 2 || !around.iter().any(|face| patches.contains(&(face.as_u64().unwrap() as usize))) {
            continue;
        }
        for sample in edge_continuity(shape, edge as f64, 21.0).unwrap().as_array().expect("a patch edge is measured") {
            worst = worst.max(num(&sample["g0"]));
        }
    }
    worst
}

fn volume_of_step(shape: &Shape, edges: &[f64], corners: &[f64], mode: i32) -> (Shape, f64) {
    crate::test_bridge::set_corner_exact_patch(mode);
    let built = fillet_setback(shape, edges, corners).unwrap().expect("a solid");
    let volume = mass_properties(&built).unwrap().volume;
    (built, volume)
}

/// BLD §13.21: the exact-boundary corner patch. On the 8-corner cube (10 mm, r 1, setback 2; diagonal 17.3) the star of sub-patches meets the blends and the flat faces to a small fraction of the
/// default g0 (1e-6 x the diagonal; the MakeFilling patch needs 5x that), is tangent to them and to its own sub-patches, and encloses the volume of the thin-plate patch to 1e-5.
#[test]
fn the_exact_corner_star_meets_the_default_g0_and_g1_and_agrees_with_the_plate() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let (shape, edges, corners) = cube_corner_step();
    let diagonal = 10.0 * 3.0_f64.sqrt();
    let (star, star_volume) = volume_of_step(&shape, &edges, &corners, 1);
    let (plate, plate_volume) = volume_of_step(&shape, &edges, &corners, 0);
    assert!(analyze(&star).unwrap().valid);
    assert_eq!(split_faces(topology(&star).unwrap()["faces"].as_array().unwrap()), (18, 48));
    assert_eq!(split_faces(topology(&plate).unwrap()["faces"].as_array().unwrap()), (18, 8));
    let gap = worst_patch_gap(&star);
    assert!(
        gap < 0.2e-6 * diagonal,
        "the star meets every neighbour within a fifth of the default g0: {gap} (limit {})",
        0.2e-6 * diagonal
    );
    assert!(gap < worst_patch_gap(&plate), "and closer than the plate: {gap} against {}", worst_patch_gap(&plate));
    let angle = worst_patch_angle(&star);
    assert!(angle < 0.0095, "G1 to the blends, the flat faces and between the sub-patches: {angle}");
    assert!((star_volume - plate_volume).abs() < 1e-5 * plate_volume, "{star_volume} against the plate {plate_volume}");
}

/// BLD §13.21: when the exact star is refused (here by the test hook) the corner falls back to the MakeFilling patch: one face per corner, the same solid to the volume of the plate.
#[test]
fn a_refused_exact_star_falls_back_to_the_plate_patch() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let (shape, edges, corners) = cube_corner_step();
    let (fallback, volume) = volume_of_step(&shape, &edges, &corners, 2);
    let (plate, plate_volume) = volume_of_step(&shape, &edges, &corners, 0);
    assert_eq!(split_faces(topology(&fallback).unwrap()["faces"].as_array().unwrap()), (18, 8));
    assert_eq!(volume.to_bits(), plate_volume.to_bits(), "the fallback is the plate");
    assert!(analyze(&plate).unwrap().valid);
}

/// BLD §13.21: the stars do not depend on the number of threads (the construction is deterministic and the fills are independent).
#[test]
fn the_exact_stars_give_the_same_solid_on_any_number_of_threads() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let (shape, edges, corners) = cube_corner_step();
    let mut reference = None;
    for threads in [1, 8, 2] {
        crate::test_bridge::set_corner_threads(threads);
        let (built, volume) = volume_of_step(&shape, &edges, &corners, 1);
        let area = mass_properties(&built).unwrap().area;
        let bits = (volume.to_bits(), area.to_bits());
        assert_eq!(*reference.get_or_insert(bits), bits, "{threads} threads");
    }
}

/// BLD §13.21 review: the sub-patches of a star are named `blend(v:<edges>)#k` (k = 1..m, ranked by the support / position key of the loop edge they have as bottom: the same on any run and any
/// start of the loop), the plate patch has no suffix; the end samples on the collapsed side are the only ones read with a nudged normal, and they are flagged.
#[test]
fn the_sub_patches_of_a_star_are_named_with_a_stable_rank_and_only_the_pole_end_is_nudged() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let (shape, edges, corners) = cube_corner_step();
    let names_of = |built: &Shape| -> Vec<String> {
        let mut names: Vec<String> = topology(built).unwrap()["faces"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|face| face["name"].as_str().filter(|name| name.starts_with("blend(v:")).map(str::to_string))
            .collect();
        names.sort();
        names
    };
    let (star, _) = volume_of_step(&shape, &edges, &corners, 1);
    let names = names_of(&star);
    assert_eq!(names.len(), 48);
    let mut by_corner: std::collections::BTreeMap<String, Vec<String>> = std::collections::BTreeMap::new();
    for name in &names {
        let (base, rank) = name.rsplit_once('#').expect("every sub-patch has a rank");
        by_corner.entry(base.to_string()).or_default().push(rank.to_string());
    }
    assert_eq!(by_corner.len(), 8, "one base name per corner");
    for ranks in by_corner.values() {
        assert_eq!(ranks, &["1", "2", "3", "4", "5", "6"], "the ranks of one star");
    }
    let (again, _) = volume_of_step(&shape, &edges, &corners, 1);
    assert_eq!(names_of(&again), names, "the same names on a second build");
    let (plate, _) = volume_of_step(&shape, &edges, &corners, 0);
    assert!(names_of(&plate).iter().all(|name| !name.contains('#')), "the plate patch has no rank");
    // the pole: only the first / last sample of an edge may be nudged
    let graph = crate::queries::face_graph(&star).unwrap();
    let mut nudged_ends = 0;
    for (edge, faces) in graph["edgeFaces"].as_array().unwrap().iter().enumerate() {
        if faces.as_array().unwrap().len() < 2 {
            continue;
        }
        let samples = edge_continuity(&star, edge as f64, 21.0).unwrap();
        let samples = samples.as_array().expect("measured");
        for (at, sample) in samples.iter().enumerate() {
            if sample["nudged"] == Value::Bool(true) {
                assert!(at == 0 || at == samples.len() - 1, "a nudged sample inside an edge: {at}");
                assert_eq!((num(&sample["normalCurvature"][0]), num(&sample["normalCurvature"][1])), (0.0, 0.0));
                nudged_ends += 1;
            }
        }
    }
    assert_eq!(nudged_ends, 48, "each sub-patch has its two spokes meeting at the pole once per spoke end: 8 stars x 6 spokes");
}

/// BLD §13.21 review: a star that passes its own checks but whose step fails after the fills is built again with the plate patches (hook 3); when the plate fails too, the message carries both
/// (hook 4).
#[test]
fn a_step_whose_star_fails_after_the_fills_is_built_again_with_the_plate() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let (shape, edges, corners) = cube_corner_step();
    let (retried, volume) = volume_of_step(&shape, &edges, &corners, 3);
    let (plate, plate_volume) = volume_of_step(&shape, &edges, &corners, 0);
    assert_eq!(split_faces(topology(&retried).unwrap()["faces"].as_array().unwrap()), (18, 8));
    assert_eq!(volume.to_bits(), plate_volume.to_bits());
    assert!(analyze(&plate).unwrap().valid);
    crate::test_bridge::set_corner_exact_patch(4);
    assert!(fillet_setback(&shape, &edges, &corners).unwrap().is_none());
    let reason = setback_reason(&shape, &edges, &corners).unwrap();
    assert!(
        reason.starts_with("[BLD_CORNER_FAILED]")
            && reason.contains("(the exact-boundary patch was refused: [BLD_CORNER_FAILED] forced by the test hook"),
        "{reason}"
    );
}

/// BLD §13.21 review: the 66-face cube survives the consumers of a B-rep: STEP export / import keeps the faces and the volume, the tessellation is a closed watertight mesh, a shell with a flat face
/// open builds a valid solid.
#[test]
fn the_cube_of_stars_goes_through_step_the_tessellation_and_a_shell() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let (shape, edges, corners) = cube_corner_step();
    let (star, volume) = volume_of_step(&shape, &edges, &corners, 1);
    let text = crate::export_step(&[&star]).unwrap().expect("a STEP text");
    let options = crate::queries::ImportOptions { precision: 1e-4, max_tolerance: 0.1, heal: true, sew: true };
    let imported = crate::queries::import_step(&text, options).unwrap();
    assert_eq!(imported["census"]["solids"], serde_json::json!(1), "{imported}");
    assert_eq!(imported["solids"][0]["faces"], serde_json::json!(66));
    let back = crate::queries::read_brep(imported["solids"][0]["brep"].as_str().unwrap()).unwrap().unwrap();
    assert!((mass_properties(&back).unwrap().volume - volume).abs() < 1e-5 * volume, "the volume after the round trip");
    let mesh = crate::tessellate(&star, 0.01, 0.2).unwrap();
    assert!(mesh.closed_solid && mesh.missing_faces == 0, "watertight: closed {} missing {}", mesh.closed_solid, mesh.missing_faces);
    // OCCT's thick solid cannot offset the collapsed row of a sub-patch, or the plate patches either: the shell is a refusal (None), never an exception, and a valid solid when it builds
    let (plate, _) = volume_of_step(&shape, &edges, &corners, 0);
    for solid in [&star, &plate] {
        match crate::features::shell_open(solid, 0.3, &[5.0, 5.0, 10.0]).expect("no exception") {
            Some(shelled) => assert!(analyze(&shelled).unwrap().valid),
            None => {}
        }
    }
}
/// BLD §13.22: the rolling-ball trim builder (edges the analytic builder cannot take: forced here on the cube, where the exact answer is known). OCCT's own rolling-ball blend of the 12 edges has a
/// spherical corner; the builder cuts the faces inside a ball of the setback radius around each vertex and fills the hole with the exact star (the loop of a ball cut has 6 smooth vertices: the
/// spokes leave from the middles of its edges). The solid is valid and tangent, the stars meet the neighbours within the default g0, the centre of each star is where OCCT's own corner was, and the
/// volume is within 0.1 % of the rolling-ball cube (975.587; measured 976.29, +0.07 %). With the plate (hook 0) it is 974.57 (-0.10 %).
#[test]
fn a_cube_trimmed_around_its_vertices_is_the_rolling_ball_blend_with_a_star_at_each_corner() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let (shape, edges, corners) = cube_corner_step();
    let diagonal = 10.0 * 3.0_f64.sqrt();
    let all: Vec<u32> = (0..12).collect();
    let reference =
        mass_properties(&crate::features::fillet(&shape, &all, 1.0, None).unwrap().expect("a rolling-ball cube")).unwrap().volume;
    crate::test_bridge::set_corner_trim(true);
    crate::test_bridge::set_corner_exact_patch(5);
    let built = fillet_setback(&shape, &edges, &corners).unwrap().expect("the star is accepted on the trimmed holes");
    assert!(analyze(&built).unwrap().valid);
    let (others, patches) = split_faces(topology(&built).unwrap()["faces"].as_array().unwrap());
    assert_eq!((others, patches), (18, 8 * 6), "6 planes, the 12 rolling-ball blends, a star of 6 at each vertex");
    assert!(worst_tangent_angle(&built) < 0.0095, "{}", worst_tangent_angle(&built));
    assert!(worst_patch_angle(&built) < 0.0095, "{}", worst_patch_angle(&built));
    assert!(worst_patch_gap(&built) < 1e-6 * diagonal, "the default g0: {}", worst_patch_gap(&built));
    let volume = mass_properties(&built).unwrap().volume;
    assert!((volume - reference).abs() < 1e-3 * reference, "{volume} against the rolling-ball cube {reference}");
    // the plate on the same holes
    crate::test_bridge::set_corner_exact_patch(0);
    let plate = fillet_setback(&shape, &edges, &corners).unwrap().expect("a solid");
    assert_eq!(split_faces(topology(&plate).unwrap()["faces"].as_array().unwrap()), (18, 8));
    assert!((mass_properties(&plate).unwrap().volume - reference).abs() < 2e-3 * reference);
}

/// BLD §13.22: what the trim builder does not take is refused by name: balls that overlap, a ball that does not hold
/// OCCT's own corner (s = 0.7 r, s = r sqrt(2)), a face that does not meet the vertex inside the ball, an edge at the vertex that is not rounded.
#[test]
fn the_trim_builder_refuses_by_name_what_it_does_not_take() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    crate::test_bridge::set_corner_trim(true);
    let shape = cube(10.0);
    let all: Vec<usize> = (0..12).collect();
    let reason = |shape: &Shape, edges: &[f64], corners: &[f64]| setback_reason(shape, edges, corners).unwrap();
    let (edges, corners) = spec(&shape, &all, 1.0, &[[0.0; 3], [10.0, 0.0, 0.0]], 5.5);
    let text = reason(&shape, &edges, &corners);
    assert!(text.starts_with("[BLD_CORNER_UNSUPPORTED]") && text.contains("overlap"), "{text}");
    // the ball must hold OCCT's own corner: its farthest point is r sqrt(2) = 1.414 from the vertex of the cube
    for setback in [0.7, 2.0_f64.sqrt()] {
        let (edges, corners) = spec(&shape, &all, 1.0, &cube_vertices(10.0), setback);
        let text = reason(&shape, &edges, &corners);
        assert!(text.starts_with("[BLD_SETBACK_TOO_SHORT]") && text.contains("must exceed"), "{setback}: {text}");
    }
    // an edge at the setback vertex that is not rounded
    let meeting = edges_at(&shape, [0.0; 3]);
    let without: Vec<usize> = all.iter().copied().filter(|edge| *edge != meeting[0]).collect();
    let (edges, corners) = spec(&shape, &without, 1.0, &[[0.0; 3]], 2.0);
    let text = reason(&shape, &edges, &corners);
    assert!(text.starts_with("[BLD_CORNER_UNSUPPORTED]") && text.contains("is not rounded"), "{text}");
    // a rounded edge that ends at no setback vertex
    let (edges, corners) = spec(&shape, &all, 1.0, &[[0.0; 3]], 2.0);
    let text = reason(&shape, &edges, &corners);
    assert!(text.starts_with("[BLD_CORNER_UNSUPPORTED]") && text.contains("does not end at a setback vertex"), "{text}");
    // a face that does not meet the vertex lies 1.7 from it: the pocket wall x = 1.5 is inside a ball of 2 and outside one of 1.2
    let pocket = make_box([1.5, 0.8, 0.0], [2.5, 3.0, 2.0]).unwrap().unwrap();
    let pocketed = boolean(BooleanOp::Subtract, &cube(10.0), &pocket, true).unwrap().unwrap();
    let meeting = edges_at(&pocketed, [0.0; 3]);
    for (setback, refused) in [(2.0, true), (1.2, false)] {
        let (edges, corners) = spec(&pocketed, &meeting, 0.5, &[[0.0; 3]], setback);
        let text = reason(&pocketed, &edges, &corners);
        assert_eq!(text.contains("does not meet the vertex"), refused, "{setback}: {text}");
        if !refused {
            assert_eq!(text, "", "builds with the ball clear of the pocket");
        }
    }
}

/// BLD §13.22: a block cut by a cylinder (r 12 about the z axis). At the vertex (10, 6.63, 5) a circular top edge, a straight top edge and a straight edge against the cylinder meet: the
/// rolling-ball blend of the three edges is cut by a ball of 1.2 and the hole gets the exact star (hook 5: no plate fallback), G1 and G0 as on the cube, the volume within 0.1 % of the rolling-ball
/// blend of the same edges. The ball is not a distance along the edge: that is why the setback is described twice (13.22).
#[test]
fn the_vertex_of_a_circular_edge_a_straight_edge_and_a_cylinder_gets_the_star() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let block = make_box([0.0; 3], [10.0, 10.0, 5.0]).unwrap().unwrap();
    let cylinder = crate::make_cylinder(12.0, 5.0).unwrap().unwrap();
    let dshape = boolean(BooleanOp::Intersect, &block, &cylinder, true).unwrap().unwrap();
    let vertex = [10.0, (144.0_f64 - 100.0).sqrt(), 5.0];
    let meeting = edges_at(&dshape, vertex);
    assert_eq!(meeting.len(), 3);
    let (edges, corners) = spec(&dshape, &meeting, 0.5, &[vertex], 1.2);
    let unique: Vec<u32> = meeting.iter().map(|&edge| edge as u32).collect();
    let reference =
        mass_properties(&crate::features::fillet(&dshape, &unique, 0.5, None).unwrap().expect("a rolling-ball blend")).unwrap().volume;
    crate::test_bridge::set_corner_exact_patch(5);
    let built = fillet_setback(&dshape, &edges, &corners).unwrap().expect("the star is accepted");
    assert!(analyze(&built).unwrap().valid);
    let (others, patches) = split_faces(topology(&built).unwrap()["faces"].as_array().unwrap());
    assert_eq!((others, patches), (10, 6), "the block, the cylinder, the 3 blends; a star of 6");
    assert!(
        worst_tangent_angle(&built) < 0.0095 && worst_patch_angle(&built) < 0.0095,
        "{} {}",
        worst_tangent_angle(&built),
        worst_patch_angle(&built)
    );
    assert!(worst_patch_gap(&built) < 1e-6 * (10.0_f64 * 10.0 + 10.0 * 10.0 + 25.0).sqrt(), "{}", worst_patch_gap(&built));
    let volume = mass_properties(&built).unwrap().volume;
    assert!((volume - reference).abs() < 1e-3 * reference, "{volume} against the rolling-ball blend {reference}");
}

fn dshape_vertex() -> (Shape, [f64; 3], Vec<usize>) {
    let block = make_box([0.0; 3], [10.0, 10.0, 5.0]).unwrap().unwrap();
    let cylinder = crate::make_cylinder(12.0, 5.0).unwrap().unwrap();
    let dshape = boolean(BooleanOp::Intersect, &block, &cylinder, true).unwrap().unwrap();
    let vertex = [10.0, (144.0_f64 - 100.0).sqrt(), 5.0];
    let meeting = edges_at(&dshape, vertex);
    (dshape, vertex, meeting)
}

/// BLD §13.22 review: why the loop is cut into chains with spokes only at corners (or the middles of edges). The loop of a ball cut is smooth at every vertex; with a spoke at EVERY vertex (hook 6)
/// the twist conditions of the two sub-patches at a smooth vertex disagree where the support curvature jumps (a plane against a blend) and the star leaves its supports by 0.03 to 0.09 rad on the
/// cylinder block (r 0.5 / 1 / 2) and on the cube; with the chains (hook 5) the same holes pass at 1.4e-3 to 2.2e-3.
#[test]
fn a_spoke_at_every_vertex_of_a_smooth_hole_leaves_the_supports_where_chains_do_not() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let (dshape, vertex, meeting) = dshape_vertex();
    crate::test_bridge::set_corner_trim(true);
    for (radius, setback) in [(0.5, 1.2), (1.0, 2.0), (2.0, 3.0)] {
        let (edges, corners) = spec(&dshape, &meeting, radius, &[vertex], setback);
        crate::test_bridge::set_corner_exact_patch(5);
        let built = fillet_setback(&dshape, &edges, &corners).unwrap().expect("chains: the star is accepted");
        assert!(worst_patch_angle(&built) < 0.0095, "{radius}: {}", worst_patch_angle(&built));
        crate::test_bridge::set_corner_exact_patch(6);
        let reason = setback_reason(&dshape, &edges, &corners).unwrap();
        let angle: f64 =
            reason.split("supports by ").nth(1).and_then(|rest| rest.split(' ').next()).and_then(|text| text.parse().ok()).unwrap_or(0.0);
        assert!(
            reason.contains("the exact-boundary patch was refused") && angle > 0.0095,
            "{radius} {setback}: spokes at every vertex: {reason}"
        );
    }
    let (shape, edges, corners) = cube_corner_step();
    crate::test_bridge::set_corner_exact_patch(6);
    assert!(setback_reason(&shape, &edges, &corners).unwrap().contains("the exact-boundary patch was refused"));
    // a 4-valent vertex (the apex of the pyramid: an 8-edge loop, chains of two pieces): chains 1.3e-3 and 3.6e-3 rad, a spoke at every vertex 0.041 and 0.034
    let pyramid = pyramid();
    let topo = topology(&pyramid).unwrap();
    let lateral: Vec<usize> = topo["edges"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .filter(|(_, edge)| num(&edge["start"][2]) > 9.0 || num(&edge["end"][2]) > 9.0)
        .map(|(index, _)| index)
        .collect();
    for setback in [1.5, 2.5] {
        let (edges, corners) = spec(&pyramid, &lateral, 0.5, &[[5.0, 5.0, 10.0]], setback);
        crate::test_bridge::set_corner_exact_patch(5);
        let built = fillet_setback(&pyramid, &edges, &corners).unwrap().expect("chains: the star is accepted");
        assert!(worst_patch_angle(&built) < 0.0095);
        crate::test_bridge::set_corner_exact_patch(6);
        let reason = setback_reason(&pyramid, &edges, &corners).unwrap();
        assert!(reason.contains("the exact-boundary patch was refused") && reason.contains("supports by 0.0"), "{setback}: {reason}");
    }
}

/// BLD §13.22 review: the oriented check of the sewn solid is part of the trim path. A star that passes its own measures but fails after the fills (hook 3) is built again with the plate (26 faces on
/// the cube); when the plate fails too (hook 4) the message carries both.
#[test]
fn a_trimmed_step_whose_star_fails_after_the_fills_is_built_again_with_the_plate() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let (shape, edges, corners) = cube_corner_step();
    crate::test_bridge::set_corner_trim(true);
    crate::test_bridge::set_corner_exact_patch(3);
    let retried = fillet_setback(&shape, &edges, &corners).unwrap().expect("the plate builds it");
    assert_eq!(split_faces(topology(&retried).unwrap()["faces"].as_array().unwrap()), (18, 8));
    crate::test_bridge::set_corner_exact_patch(4);
    assert!(fillet_setback(&shape, &edges, &corners).unwrap().is_none());
    let reason = setback_reason(&shape, &edges, &corners).unwrap();
    assert!(reason.contains("(the exact-boundary patch was refused: [BLD_CORNER_FAILED] forced by the test hook"), "{reason}");
}

/// BLD §13.22: a radius that varies along the edges on the trim path (OCCT's evolving fillet, linear from 0.8 to 1.2 along every edge of the cube, ball 2 at the 8 vertices): the loop of the
/// ball cut is still well formed and gets the star; the volume is within 0.2 % of OCCT's evolving fillet of the same edges.
#[test]
fn a_radius_that_varies_along_the_edges_is_cut_by_the_ball_and_gets_the_star() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let shape = cube(10.0);
    let all: Vec<usize> = (0..12).collect();
    let tapers: Vec<(usize, f64, f64)> = all.iter().map(|&edge| (edge, 0.8, 1.2)).collect();
    let (edges, corners) = spec_tapered(&shape, &tapers, &cube_vertices(10.0), 2.0);
    let unique: Vec<u32> = (0..12).collect();
    let reference =
        mass_properties(&crate::features::fillet(&shape, &unique, 0.8, Some(1.2)).unwrap().expect("an evolving fillet")).unwrap().volume;
    crate::test_bridge::set_corner_trim(true);
    crate::test_bridge::set_corner_exact_patch(5);
    let built = fillet_setback(&shape, &edges, &corners).unwrap().expect("the star is accepted on the loops of the evolving fillet");
    assert!(analyze(&built).unwrap().valid);
    assert_eq!(split_faces(topology(&built).unwrap()["faces"].as_array().unwrap()), (18, 48));
    assert!(worst_tangent_angle(&built) < 0.0095 && worst_patch_angle(&built) < 0.0095);
    let volume = mass_properties(&built).unwrap().volume;
    assert!((volume - reference).abs() < 2e-3 * reference, "{volume} against the evolving fillet {reference}");
}

/// BLD §13.22: a rolling-ball neighbour. One of the three edges at the vertex (0, 0, 0) of the cube has the setback 0: OCCT rounds it like the others (r 1), the ball of the other two (2) cuts all
/// three blends and the hole gets the star. The analytic builder refuses it by name; an edge with NO entry, an entry twice or for an edge that does not meet the vertex is an error of the build.
#[test]
fn an_edge_without_a_setback_at_the_vertex_is_a_rolling_ball_neighbour_cut_by_the_same_ball() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let shape = cube(10.0);
    let all: Vec<usize> = (0..12).collect();
    let meeting = edges_at(&shape, [0.0; 3]);
    let (edges, mut corners) = spec(&shape, &all, 1.0, &cube_vertices(10.0), 2.0);
    // the entry of one edge at the first vertex becomes 0: left to the rolling ball
    let mut flat = Vec::new();
    let mut cursor = 0;
    while cursor < corners.len() {
        let count = corners[cursor + 3] as usize;
        let entries: Vec<(f64, f64)> = (0..count).map(|k| (corners[cursor + 4 + 2 * k], corners[cursor + 5 + 2 * k])).collect();
        let origin = corners[cursor..cursor + 3] == [0.0, 0.0, 0.0];
        let kept: Vec<(f64, f64)> = entries
            .into_iter()
            .map(|(edge, distance)| if origin && edge == meeting[0] as f64 { (edge, 0.0) } else { (edge, distance) })
            .collect();
        flat.extend_from_slice(&corners[cursor..cursor + 3]);
        flat.push(kept.len() as f64);
        for (edge, distance) in kept {
            flat.extend([edge, distance]);
        }
        cursor += 4 + 2 * count;
    }
    corners = flat;
    let reason = |hook_trim: bool| {
        crate::test_bridge::set_corner_trim(hook_trim);
        setback_reason(&shape, &edges, &corners).unwrap()
    };
    let text = reason(false);
    assert!(text.starts_with("[BLD_CORNER_UNSUPPORTED]") && text.contains("left to the rolling ball"), "{text}");
    crate::test_bridge::set_corner_exact_patch(5);
    assert_eq!(reason(true), "", "the trim builder takes it");
    let built = fillet_setback(&shape, &edges, &corners).unwrap().expect("a solid");
    assert!(analyze(&built).unwrap().valid);
    assert_eq!(split_faces(topology(&built).unwrap()["faces"].as_array().unwrap()), (18, 48));
    assert!(worst_tangent_angle(&built) < 0.0095 && worst_patch_angle(&built) < 0.0095);
    let unique: Vec<u32> = (0..12).collect();
    let reference =
        mass_properties(&crate::features::fillet(&shape, &unique, 1.0, None).unwrap().expect("a rolling-ball cube")).unwrap().volume;
    assert!((mass_properties(&built).unwrap().volume - reference).abs() < 2e-3 * reference);
}

/// BLD §13.22 review: the entries of a corner on the trim path are checked: an edge of the vertex without an entry, an entry twice, an entry for an edge that does not meet the vertex.
#[test]
fn the_setback_entries_of_a_trimmed_corner_must_name_each_edge_of_the_vertex_once() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    crate::test_bridge::set_corner_trim(true);
    let shape = cube(10.0);
    let all: Vec<usize> = (0..12).collect();
    let meeting = edges_at(&shape, [0.0; 3]);
    let elsewhere = (0..12).find(|edge| !meeting.contains(edge)).unwrap();
    let (edges, _) = spec(&shape, &all, 1.0, &[[0.0; 3]], 2.0);
    let corner = |entries: &[(usize, f64)]| {
        let mut flat = vec![0.0, 0.0, 0.0, entries.len() as f64];
        for &(edge, distance) in entries {
            flat.extend([edge as f64, distance]);
        }
        flat
    };
    let cases: [(&str, Vec<(usize, f64)>); 4] = [
        ("no setback distance for edge", vec![(meeting[0], 2.0), (meeting[1], 2.0)]),
        ("is given twice", vec![(meeting[0], 2.0), (meeting[1], 2.0), (meeting[2], 2.0), (meeting[2], 2.0)]),
        ("does not meet the vertex", vec![(meeting[0], 2.0), (meeting[1], 2.0), (meeting[2], 2.0), (elsewhere, 2.0)]),
        ("no setback distance at", vec![(meeting[0], 0.0), (meeting[1], 0.0), (meeting[2], 0.0)]),
    ];
    for (expected, entries) in cases {
        let text = setback_reason(&shape, &edges, &corner(&entries)).unwrap();
        assert!(text.starts_with("[BLD_CORNER_FAILED]") && text.contains(expected), "{expected}: {text}");
    }
}

/// BLD §13.22 review: the kernel's evolving radius is one linear law over the whole tangent contour of an edge. An edge of a chain of tangent edges (the tangent-continuous top outline of a box united
/// with a cylinder: a line and an arc) with a varying radius is refused by name; with a constant radius the chain is taken.
#[test]
fn a_varying_radius_on_a_chain_of_tangent_edges_is_refused_by_name() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let block = make_box([0.0, -3.0, 0.0], [10.0, 6.0, 5.0]).unwrap().unwrap();
    let cylinder = crate::make_cylinder(3.0, 5.0).unwrap().unwrap();
    let union = boolean(BooleanOp::Union, &block, &cylinder, true).unwrap().unwrap();
    let topo = topology(&union).unwrap();
    let on_top = |edge: &Value| num(&edge["start"][2]) > 4.9 && num(&edge["end"][2]) > 4.9;
    let top: Vec<usize> =
        topo["edges"].as_array().unwrap().iter().enumerate().filter(|(_, edge)| on_top(edge)).map(|(index, _)| index).collect();
    assert!(top.len() >= 3, "the outline of the top: {top:?}");
    crate::test_bridge::set_corner_trim(true);
    let tapers: Vec<(usize, f64, f64)> = top.iter().map(|&edge| (edge, 0.3, 0.5)).collect();
    let (edges, corners) = spec_tapered(&union, &tapers, &[[10.0, 3.0, 5.0]], 1.5);
    let text = setback_reason(&union, &edges, &corners).unwrap();
    assert!(text.starts_with("[BLD_CORNER_UNSUPPORTED]") && text.contains("belongs to a chain of 3 tangent edges"), "{text}");
}

/// BLD §13.22 review: the convention of the evolving radius. On one open edge of the cube (from (0,0,0) to (10,0,0)) the kernel's blend is 0.5 wide at the START of the edge and 1.5 at its end,
/// which is how the recipe's size / sizeEnd and the trim builder (Add(start, end, edge)) read the edge.
#[test]
fn the_evolving_radius_is_the_size_at_the_start_of_the_edge_and_sizeend_at_its_end() {
    let _serial = crate::serial_blends();
    let shape = cube(10.0);
    let topo = topology(&shape).unwrap();
    let edge = topo["edges"].as_array().unwrap().iter().position(|edge| {
        let (start, end) = (&edge["start"], &edge["end"]);
        num(&start[0]) == 0.0
            && num(&start[1]) == 0.0
            && num(&start[2]) == 0.0
            && num(&end[0]) == 10.0
            && num(&end[1]) == 0.0
            && num(&end[2]) == 0.0
    });
    let edge = edge.expect("the edge from the origin along x") as u32;
    let built = crate::features::fillet(&shape, &[edge], 0.5, Some(1.5)).unwrap().expect("an evolving fillet");
    // the contact lines of the blend on the face z = 0 end at (x, w, 0): w is the radius at x
    let width_at = |x: f64| {
        let topo = topology(&built).unwrap();
        let mut found: f64 = 0.0;
        for edge in topo["edges"].as_array().unwrap() {
            for end in [&edge["start"], &edge["end"]] {
                if (num(&end[0]) - x).abs() < 1e-6 && num(&end[2]).abs() < 1e-6 && num(&end[1]) > 1e-6 && num(&end[1]) < 2.0 {
                    found = found.max(num(&end[1]));
                }
            }
        }
        found
    };
    assert!((width_at(0.0) - 0.5).abs() < 1e-3, "at the start: {}", width_at(0.0));
    assert!((width_at(10.0) - 1.5).abs() < 1e-3, "at the end: {}", width_at(10.0));
}

fn cube_with_setbacks_at_origin(distances: [f64; 3]) -> (Shape, Vec<f64>, Vec<f64>) {
    let (shape, edges, corners) = cube_corner_step();
    let meeting = edges_at(&shape, [0.0; 3]);
    let mut flat = Vec::new();
    let mut cursor = 0;
    while cursor < corners.len() {
        let count = corners[cursor + 3] as usize;
        let origin = corners[cursor..cursor + 3] == [0.0, 0.0, 0.0];
        flat.extend_from_slice(&corners[cursor..cursor + 4]);
        for k in 0..count {
            let edge = corners[cursor + 4 + 2 * k];
            let distance =
                if origin { distances[meeting.iter().position(|&m| m as f64 == edge).unwrap()] } else { corners[cursor + 5 + 2 * k] };
            flat.extend([edge, distance]);
        }
        cursor += 4 + 2 * count;
    }
    (shape, edges, flat)
}

fn cylinder_spans(shape: &Shape) -> Vec<f64> {
    let mut spans: Vec<f64> = topology(shape).unwrap()["faces"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|face| face["surface"] == "cylinder")
        .map(|face| num(&face["axis"]["span"][1]) - num(&face["axis"]["span"][0]))
        .collect();
    spans.sort_by(f64::total_cmp);
    spans
}

/// BLD §13.22.6: different setbacks at one vertex on the trim path. The cube (r 1, 8 corners at 2) with the setbacks 1.5 / 2 / 2.5 along the three edges of the origin: planes normal to each edge at
/// its own setback point cut the rolling-ball blend (so the setback is a distance ALONG the edge, as on the analytic path: the blend cylinders span 10 - sqrt(3) - s = 6.768 / 6.268 / 5.768), the star closes the
/// hole. Valid, tangent, the default g0; the volume differs from the equal-setback cube by 0.023 % (976.513 against 976.292).
#[test]
fn a_vertex_with_different_setbacks_is_cut_by_planes_normal_to_its_edges_and_gets_the_star() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    crate::test_bridge::set_corner_trim(true);
    crate::test_bridge::set_corner_exact_patch(5);
    let (shape, edges, equal_corners) = cube_with_setbacks_at_origin([2.0, 2.0, 2.0]);
    let equal = fillet_setback(&shape, &edges, &equal_corners).unwrap().expect("the equal case");
    let (_, _, corners) = cube_with_setbacks_at_origin([1.5, 2.0, 2.5]);
    let built = fillet_setback(&shape, &edges, &corners).unwrap().expect("the planes isolate the vertex");
    assert!(analyze(&built).unwrap().valid);
    assert_eq!(split_faces(topology(&built).unwrap()["faces"].as_array().unwrap()), (18, 48));
    let spans = cylinder_spans(&built);
    assert_eq!(spans.len(), 12);
    // a ball of 2 cuts a blend of r 1 at sqrt(3) along the axis; a plane at s cuts it at s: 10 - sqrt(3) - s at the origin vertex, 10 - 2 sqrt(3) elsewhere
    let (ball_end, count) = (3.0_f64.sqrt(), |value: f64| spans.iter().filter(|span| (**span - value).abs() < 1e-6).count());
    assert_eq!(
        (count(10.0 - ball_end - 1.5), count(10.0 - ball_end - 2.0), count(10.0 - ball_end - 2.5), count(10.0 - 2.0 * ball_end)),
        (1, 1, 1, 9),
        "{spans:?}"
    );
    assert!(worst_tangent_angle(&built) < 0.0095 && worst_patch_angle(&built) < 0.0095);
    assert!(worst_patch_gap(&built) < 1e-6 * 10.0 * 3.0_f64.sqrt(), "{}", worst_patch_gap(&built));
    let (volume, reference) = (mass_properties(&built).unwrap().volume, mass_properties(&equal).unwrap().volume);
    assert!(
        (volume - reference).abs() < 1e-3 * reference && (volume - reference).abs() > 1e-5 * reference,
        "{volume} against the equal setbacks {reference}"
    );
    assert!((volume - 976.513).abs() < 0.02, "{volume}");
}

/// BLD §13.22.6: what the planes do not take is refused by name: a setback not shorter than its edge, a plane inside OCCT's own corner (setback 0.9 against the extent 1), and a region that is not
/// isolated (a pocket wall that does not meet the vertex falls inside the planes; with shorter setbacks the same vertex builds).
#[test]
fn the_planes_of_different_setbacks_are_refused_by_name_when_they_do_not_isolate_the_vertex() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    crate::test_bridge::set_corner_trim(true);
    let block = cube(10.0);
    let meeting_cube = edges_at(&block, [0.0; 3]);
    let reason = |distances: [f64; 3]| {
        let (edges, mut corners) = spec(&block, &meeting_cube, 1.0, &[[0.0; 3]], 2.0);
        for (k, distance) in distances.iter().enumerate() {
            corners[5 + 2 * k] = *distance;
        }
        setback_reason(&block, &edges, &corners).unwrap()
    };
    let text = reason([2.0, 2.0, 12.0]);
    assert!(text.starts_with("[BLD_CORNER_UNSUPPORTED]") && text.contains("is not shorter than the edge"), "{text}");
    let text = reason([0.9, 2.0, 2.5]);
    assert!(text.starts_with("[BLD_SETBACK_TOO_SHORT]") && text.contains("extent of the rolling-ball corner along the edge"), "{text}");
    // the pocket wall x = 1.5 (y from 0.8, z up to 2) does not meet the vertex
    let pocket = make_box([1.5, 0.8, 0.0], [2.5, 3.0, 2.0]).unwrap().unwrap();
    let pocketed = boolean(BooleanOp::Subtract, &cube(10.0), &pocket, true).unwrap().unwrap();
    let meeting = edges_at(&pocketed, [0.0; 3]);
    let build = |distances: [f64; 3]| {
        let (edges, mut corners) = spec(&pocketed, &meeting, 0.5, &[[0.0; 3]], 2.0);
        for (k, distance) in distances.iter().enumerate() {
            corners[5 + 2 * k] = *distance;
        }
        setback_reason(&pocketed, &edges, &corners).unwrap()
    };
    let text = build([2.0, 2.2, 2.4]);
    assert!(text.starts_with("[BLD_CORNER_UNSUPPORTED]") && text.contains("the cut planes do not isolate the vertex"), "{text}");
    assert_eq!(build([1.1, 1.2, 1.3]), "", "clear of the pocket");
}

/// BLD §13.22.6 review: the region of the planes is found from the vertex, not by the planes alone. A cube with a rib behind its top corner (a wall at x in [-5, -3], joined to the cube low down by a
/// bar): the wall is inside the half-spaces of the planes at the corner (0, 0, 10) with the setbacks 1.5 / 2 / 2.5 but not connected to it there; the step builds.
#[test]
fn a_feature_behind_the_vertex_that_the_planes_enclose_but_does_not_touch_is_not_in_the_way() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let cube_block = cube(10.0);
    let wall = make_box([-5.0, 0.0, 0.0], [2.0, 10.0, 10.0]).unwrap().unwrap();
    let bar = make_box([-5.0, 0.0, 0.0], [5.0, 10.0, 2.0]).unwrap().unwrap();
    let with_wall = boolean(BooleanOp::Union, &cube_block, &bar, true).unwrap().unwrap();
    let part = boolean(BooleanOp::Union, &with_wall, &wall, true).unwrap().unwrap();
    let vertex = [0.0, 0.0, 10.0];
    let meeting = edges_at(&part, vertex);
    assert_eq!(meeting.len(), 3, "the top corner of the cube");
    let (edges, mut corners) = spec(&part, &meeting, 0.5, &[vertex], 2.0);
    for (k, distance) in [1.5, 2.0, 2.5].iter().enumerate() {
        corners[5 + 2 * k] = *distance;
    }
    crate::test_bridge::set_corner_trim(true);
    crate::test_bridge::set_corner_exact_patch(5);
    let built = fillet_setback(&part, &edges, &corners).unwrap().unwrap_or_else(|| panic!("{:?}", setback_reason(&part, &edges, &corners)));
    assert!(analyze(&built).unwrap().valid);
    assert!(worst_tangent_angle(&built) < 0.0095);
}

/// BLD §13.22.6 review: a concave vertex (the inner corner of the notch of `notched_cube`) with different setbacks: the planes bound the region on the material side; builds, adds material.
#[test]
fn a_concave_vertex_with_different_setbacks_is_cut_by_planes_too() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let shape = notched_cube();
    let inner = [5.0; 3];
    let meeting = edges_at(&shape, inner);
    let (edges, mut corners) = spec(&shape, &meeting, 0.5, &[inner], 1.5);
    for (k, distance) in [1.2, 1.5, 1.8].iter().enumerate() {
        corners[5 + 2 * k] = *distance;
    }
    crate::test_bridge::set_corner_trim(true);
    crate::test_bridge::set_corner_exact_patch(5);
    let built =
        fillet_setback(&shape, &edges, &corners).unwrap().unwrap_or_else(|| panic!("{:?}", setback_reason(&shape, &edges, &corners)));
    assert!(analyze(&built).unwrap().valid);
    assert!(mass_properties(&built).unwrap().volume > mass_properties(&shape).unwrap().volume, "the concave blends add material");
    assert!(worst_tangent_angle(&built) < 0.0095);
}

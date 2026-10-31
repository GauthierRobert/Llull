//! BLD §13.33: a setback corner at a vertex where two rounded edges meet a third edge that stays sharp (`cpp/blend_corner.cxx`, `cpp/blend_corner_exact.cxx`).

use crate::blend_corner_tests::{
    cube, cube_vertices, edges_at, notched_cube, num, point, spec, split_faces, tall_pyramid, worst_patch_gap, CornerHooks,
};
use crate::features::{fillet, fillet_setback, setback_reason};
use crate::queries::{edge_continuity, face_graph, topology};
use crate::{analyze, boolean, make_box, make_prism, make_sewn_solid, mass_properties, BooleanOp, Shape};

/// The step for the vertex `vertex` of `shape`: every edge there but number `sharp` (0, 1, 2 in the order `edges_at` lists them) rounded with `radius`; the corner gives all of its edges `setback`.
fn step(shape: &Shape, vertex: [f64; 3], sharp: usize, radius: f64, setback: f64) -> (Vec<f64>, Vec<f64>) {
    let meeting = edges_at(shape, vertex);
    let mut corners = vec![vertex[0], vertex[1], vertex[2], meeting.len() as f64];
    let mut edges = Vec::new();
    for (k, edge) in meeting.iter().enumerate() {
        corners.extend([*edge as f64, setback]);
        if k != sharp {
            edges.extend([*edge as f64, radius, radius]);
        }
    }
    (edges, corners)
}

fn volume(shape: &Shape) -> f64 {
    mass_properties(shape).map(|m| m.volume).unwrap_or(0.0)
}

/// The volume of `a - b` (0 when nothing is left).
fn volume_outside(a: &Shape, b: &Shape) -> f64 {
    boolean(BooleanOp::Subtract, a, b, true).unwrap().map(|s| volume(&s)).unwrap_or(0.0)
}

/// One edge that borders a corner patch: whether both its faces are patches, and the G1 angle (rad) at 21 samples along it.
struct PatchEdge {
    edge: usize,
    both_patches: bool,
    g1: Vec<f64>,
}

fn patch_edges(shape: &Shape) -> Vec<PatchEdge> {
    let topo = topology(shape).unwrap();
    let patches: Vec<usize> = topo["faces"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .filter(|(_, face)| face["name"].as_str().is_some_and(|name| name.starts_with("blend(v:")))
        .map(|(index, _)| index)
        .collect();
    let graph = face_graph(shape).unwrap();
    let mut found = Vec::new();
    for (edge, faces) in graph["edgeFaces"].as_array().unwrap().iter().enumerate() {
        let faces: Vec<usize> = faces.as_array().unwrap().iter().map(|face| face.as_u64().unwrap() as usize).collect();
        if faces.len() < 2 || !faces.iter().any(|face| patches.contains(face)) {
            continue;
        }
        let samples = edge_continuity(shape, edge as f64, 21.0).unwrap();
        let g1 = samples.as_array().expect("measured").iter().map(|sample| num(&sample["g1"])).collect();
        found.push(PatchEdge { edge, both_patches: faces.iter().all(|face| patches.contains(face)), g1 });
    }
    found
}

/// What the patches of a step with sharp edges read: the largest G1 angle over every patch edge but the crease spokes at the interior samples (the last sample of a spoke is the nudged pole of the
/// star: read apart), the pole-end reading, and the crease spokes (an edge between two sub-patches that starts at more than 0.1 rad).
struct Reading {
    interior: f64,
    pole_end: f64,
    creases: Vec<PatchEdge>,
}

fn read(shape: &Shape) -> Reading {
    let mut reading = Reading { interior: 0.0, pole_end: 0.0, creases: Vec::new() };
    for edge in patch_edges(shape) {
        if edge.both_patches && edge.g1[0].max(edge.g1[20]) > 0.1 {
            reading.creases.push(edge);
            continue;
        }
        reading.interior = reading.interior.max(edge.g1[..20].iter().cloned().fold(0.0, f64::max));
        if edge.both_patches {
            reading.pole_end = reading.pole_end.max(edge.g1[20]);
        }
    }
    reading
}

/// The crease angles along a crease spoke from its end on the sharp edge (the large one) to the pole.
fn along_the_crease(edge: &PatchEdge) -> Vec<f64> {
    let mut angles = edge.g1.clone();
    if angles[0] < angles[20] {
        angles.reverse();
    }
    angles
}

fn endpoints(shape: &Shape, edge: usize) -> ([f64; 3], [f64; 3]) {
    let topo = topology(shape).unwrap();
    (point(&topo["edges"][edge]["start"]), point(&topo["edges"][edge]["end"]))
}

fn near(a: [f64; 3], b: [f64; 3]) -> bool {
    a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-6)
}

/// The closed form of a cube of side `side` whose two edges at one vertex are rounded by the rolling ball (a mitre of two cylinders, 13.33.4): the two blends each remove r^2 (1 - pi/4) along
/// the edge and the removed prisms overlap in r^3 (5/3 - pi/2) at the vertex.
fn mitre_volume(side: f64, radius: f64) -> f64 {
    let quarter = std::f64::consts::FRAC_PI_4;
    side.powi(3) - 2.0 * radius * radius * (1.0 - quarter) * side + radius.powi(3) * (5.0 / 3.0 - std::f64::consts::FRAC_PI_2)
}

/// BLD §13.33: two edges of a cube rounded at a vertex and the third left sharp (r 1, setback 2 on all three). The hole is bounded by the two blend ends, the chord across the face the two blends
/// share and one chord on each face of the sharp edge, to the point where the sharp edge enters; the star has five sub-patches and one crease spoke that continues the sharp edge. Everything is
/// tangent but that spoke (90 degrees where it leaves the sharp edge, fading to the pole), the sharp edge stays sharp up to the entry point, and the solid is inside OCCT's rolling-ball mitre of the same two edges
/// (the closed form of the mitre is the volume) by the patch that replaces it.
#[test]
fn two_rounded_edges_and_a_sharp_third_get_a_star_with_a_crease_spoke() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let shape = cube(10.0);
    let (edges, corners) = step(&shape, [0.0; 3], 2, 1.0, 2.0);
    assert_eq!(setback_reason(&shape, &edges, &corners).unwrap(), "", "builds");
    let built = fillet_setback(&shape, &edges, &corners).unwrap().expect("a solid");
    assert!(analyze(&built).unwrap().valid);
    let faces = topology(&built).unwrap()["faces"].as_array().unwrap().clone();
    assert_eq!(split_faces(&faces), (8, 5), "6 planes and 2 blend cylinders; a star of 5 sub-patches (two blend ends, the chord on the shared face, two chords to the sharp edge)");
    // the independent route: OCCT's rolling-ball fillet of the same two edges, and the closed form of the mitre
    let rolling = fillet(&shape, &[edges[0] as u32, edges[3] as u32], 1.0, None).unwrap().expect("the rolling-ball mitre");
    let mitre = mitre_volume(10.0, 1.0);
    assert!((volume(&rolling) - mitre).abs() < 1e-6, "the closed form of the mitre is OCCT's volume: {} against {mitre}", volume(&rolling));
    let built_volume = volume(&built);
    assert!(
        built_volume < mitre && built_volume > mitre - 1.0,
        "the patch removes the sliver of the two faces between the contact line and its chord: {built_volume} against the mitre {mitre}"
    );
    assert!(
        volume_outside(&built, &rolling) < 1e-2,
        "the star is inside the rolling-ball solid but for the approximation of the patch: {}",
        volume_outside(&built, &rolling)
    );
    // tangent everywhere but the crease spoke, G0 to the default g0 (1e-6 x the diagonal)
    let reading = read(&built);
    assert!(reading.interior < 0.0095, "G1 to the blends, the faces and between the sub-patches: {}", reading.interior);
    assert!(worst_patch_gap(&built) < 0.2e-6 * 10.0 * 3.0_f64.sqrt(), "G0: {}", worst_patch_gap(&built));
    assert_eq!(reading.creases.len(), 1, "one crease spoke");
    let angles = along_the_crease(&reading.creases[0]);
    assert!(
        (angles[0] - std::f64::consts::FRAC_PI_2).abs() < 1e-6,
        "it leaves the sharp edge at the dihedral angle of the part (90 degrees): {}",
        angles[0]
    );
    assert!(angles[20] < 0.0095, "and fades to nothing at the pole: {}", angles[20]);
    assert!(angles.windows(2).all(|pair| pair[1] <= pair[0] + 1e-3), "monotonically: {angles:?}");
    // the sharp edge: the vertical edge is cut at the entry point (0, 0, 2) and stays an edge of two planes up to it; the crease spoke starts there
    let (from, to) = endpoints(&shape, edges_at(&shape, [0.0; 3])[2]);
    let far = if near(from, [0.0; 3]) { to } else { from };
    let entry = [far[0] * 0.2, far[1] * 0.2, far[2] * 0.2];
    let count = topology(&built).unwrap()["edges"].as_array().unwrap().len();
    let sharp: Vec<usize> = (0..count)
        .filter(|&edge| {
            let (a, b) = endpoints(&built, edge);
            (near(a, entry) && near(b, far)) || (near(b, entry) && near(a, far))
        })
        .collect();
    assert_eq!(sharp.len(), 1, "the sharp edge now runs from its entry point {entry:?} to the far end {far:?}");
    let (a, b) = endpoints(&built, reading.creases[0].edge);
    assert!(near(a, entry) || near(b, entry), "and the crease spoke starts at the same point");
}

/// BLD §13.33: the construction does not depend on which vertex or which of its three edges stays sharp (the loop direction, the support orientation, the stub signs): all 24 give one solid.
#[test]
fn every_vertex_and_every_choice_of_the_sharp_edge_gives_the_same_solid() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let mut volumes = Vec::new();
    for vertex in cube_vertices(10.0) {
        for sharp in 0..3 {
            let shape = cube(10.0);
            let (edges, corners) = step(&shape, vertex, sharp, 1.0, 2.0);
            let built = fillet_setback(&shape, &edges, &corners).unwrap().expect("a solid");
            assert!(analyze(&built).unwrap().valid, "{vertex:?} sharp {sharp}");
            let reading = read(&built);
            assert!(
                reading.interior < 0.0095 && reading.creases.len() == 1,
                "{vertex:?} sharp {sharp}: {} / {}",
                reading.interior,
                reading.creases.len()
            );
            volumes.push(volume(&built));
        }
    }
    let first = volumes[0];
    assert!(volumes.iter().all(|v| (v - first).abs() < 1e-6), "{volumes:?}");
}

/// BLD §13.33: the common case of a box with its four top edges rounded and the four vertical edges left sharp: a corner at each top vertex, four stars of five sub-patches, valid, inside OCCT's
/// rolling-ball solid of the same four edges by less than the patches' sliver.
#[test]
fn a_box_with_its_four_top_edges_rounded_and_the_vertical_edges_sharp_gets_four_corners() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let shape = make_box([0.0; 3], [20.0, 10.0, 8.0]).unwrap().unwrap();
    let top = [[0.0, 0.0, 8.0], [20.0, 0.0, 8.0], [20.0, 10.0, 8.0], [0.0, 10.0, 8.0]];
    let mut rounded: Vec<usize> = Vec::new();
    for vertex in top {
        for edge in edges_at(&shape, vertex) {
            let (a, b) = endpoints(&shape, edge);
            if a[2] > 7.9 && b[2] > 7.9 && !rounded.contains(&edge) {
                rounded.push(edge);
            }
        }
    }
    assert_eq!(rounded.len(), 4);
    let (edges, corners) = spec(&shape, &rounded, 1.0, &top, 2.0);
    assert_eq!(setback_reason(&shape, &edges, &corners).unwrap(), "", "builds");
    let built = fillet_setback(&shape, &edges, &corners).unwrap().expect("a solid");
    assert!(analyze(&built).unwrap().valid);
    assert_eq!(split_faces(topology(&built).unwrap()["faces"].as_array().unwrap()), (6 + 4, 4 * 5), "6 planes and 4 blends; 4 stars of 5");
    let rolling = fillet(&shape, &rounded.iter().map(|&e| e as u32).collect::<Vec<_>>(), 1.0, None).unwrap().expect("rolling ball");
    let (own, other) = (volume(&built), volume(&rolling));
    assert!(
        own < other && (other - own) < 4.0 * 1.0,
        "four corners, each removing less than r^3 more than the mitre: {own} against {other}"
    );
    assert!(volume_outside(&built, &rolling) < 1e-2);
    let reading = read(&built);
    assert!(reading.interior < 0.0095, "{}", reading.interior);
    assert_eq!(reading.creases.len(), 4, "one crease spoke per corner");
}

/// BLD §13.33: the concave vertex of a notch (three concave edges, two rounded, one sharp) takes the same construction and adds material.
#[test]
fn a_concave_vertex_with_a_sharp_edge_adds_material_and_keeps_the_crease() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let shape = notched_cube();
    let (edges, corners) = step(&shape, [5.0, 5.0, 5.0], 1, 0.5, 1.5);
    let built = fillet_setback(&shape, &edges, &corners).unwrap().expect("a solid");
    assert!(analyze(&built).unwrap().valid);
    let gain = volume(&built) - volume(&shape);
    assert!(gain > 0.0 && gain < 2.0, "the blends fill the inner edges: {gain}");
    let reading = read(&built);
    assert!(reading.interior < 0.0095 && reading.creases.len() == 1, "{} / {}", reading.interior, reading.creases.len());
    assert!((along_the_crease(&reading.creases[0])[0] - std::f64::consts::FRAC_PI_2).abs() < 1e-6);
}

/// BLD §13.33: the faces of the sharp edge need not be square: a triangular prism with 60 degree sides (the sharp vertical edge's faces meet at 60 degrees: the normals differ by 120) and an
/// irregular tetrahedron apex build, the crease starting at the angle between the normals of the two faces.
#[test]
fn the_sharp_edge_may_have_any_dihedral_angle() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let prism = make_prism(&[0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 5.0, 75.0_f64.sqrt(), 0.0], [0.0, 0.0, 12.0]).unwrap().unwrap();
    let mut seen = Vec::new();
    for sharp in 0..3 {
        let (edges, corners) = step(&prism, [0.0; 3], sharp, 1.0, 3.0);
        let built = fillet_setback(&prism, &edges, &corners).unwrap().expect("a solid");
        assert!(analyze(&built).unwrap().valid, "sharp {sharp}");
        let reading = read(&built);
        assert!(reading.interior < 0.0095 && reading.creases.len() == 1, "sharp {sharp}: {} / {}", reading.interior, reading.creases.len());
        seen.push(along_the_crease(&reading.creases[0])[0]);
    }
    assert!(
        seen.iter().any(|angle| (angle - 2.0 * std::f64::consts::FRAC_PI_3).abs() < 1e-3),
        "the vertical edge between the 60 degree sides: {seen:?}"
    );
    assert!(seen.iter().any(|angle| (angle - std::f64::consts::FRAC_PI_2).abs() < 1e-3), "{seen:?}");
    let apex = [3.0, 2.0, 9.0];
    let base = [[0.0, 0.0, 0.0], [10.0, 0.0, 0.0], [4.0, 9.0, 0.0]];
    let (mut positions, mut indices) = (Vec::new(), Vec::<u32>::new());
    let mut push = |a: [f64; 3], b: [f64; 3], c: [f64; 3]| {
        let at = (positions.len() / 3) as u32;
        positions.extend(a.iter().chain(&b).chain(&c));
        indices.extend([at, at + 1, at + 2]);
    };
    for i in 0..3 {
        push(base[i], base[(i + 1) % 3], apex);
    }
    push(base[0], base[2], base[1]);
    let tetra = make_sewn_solid(&positions, &indices).unwrap().unwrap();
    for sharp in 0..3 {
        let (edges, corners) = step(&tetra, apex, sharp, 0.5, 2.0);
        let built = fillet_setback(&tetra, &edges, &corners).unwrap().expect("a solid");
        assert!(analyze(&built).unwrap().valid, "tetra sharp {sharp}");
        let reading = read(&built);
        assert!(
            reading.interior < 0.0095 && reading.creases.len() == 1,
            "tetra sharp {sharp}: {} / {}",
            reading.interior,
            reading.creases.len()
        );
        assert!(reading.pole_end < 0.02, "the pole of the star reads {}", reading.pole_end);
    }
}

/// BLD §13.33: what stays refused is refused by name: two edges left sharp, four edges at the vertex, convex and concave edges, a radius that varies, a sharp edge's setback of 0 or past its end, a
/// setback shorter than the reach of the neighbouring blends, a crease the star cannot hold (supports meeting at under 0.2 rad).
#[test]
fn what_a_sharp_edge_does_not_take_is_refused_by_name() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let shape = cube(10.0);
    let reason = |shape: &Shape, edges: &[f64], corners: &[f64]| setback_reason(shape, edges, corners).unwrap();
    // two of the three edges left sharp
    let meeting = edges_at(&shape, [0.0; 3]);
    let (edges, corners) = spec(&shape, &meeting[..1], 1.0, &[[0.0; 3]], 2.0);
    let text = reason(&shape, &edges, &corners);
    assert!(text.starts_with("[BLD_CORNER_UNSUPPORTED]") && text.contains("is not rounded") && text.contains("at most one edge"), "{text}");
    // four edges at the vertex (a pyramid apex), one of them left sharp
    let pyramid = tall_pyramid(10.0);
    let (edges, corners) = step(&pyramid, [5.0, 5.0, 10.0], 3, 0.5, 2.0);
    let text = reason(&pyramid, &edges, &corners);
    assert!(text.starts_with("[BLD_CORNER_UNSUPPORTED]") && text.contains("at most one edge of a three-edge vertex"), "{text}");
    // convex and concave edges: the rim vertex of the notch with a convex top edge left sharp
    let notch = notched_cube();
    let rim = [5.0, 5.0, 10.0];
    let meeting = edges_at(&notch, rim);
    assert_eq!(meeting.len(), 3);
    let convex_top = meeting
        .iter()
        .position(|&edge| {
            let (a, b) = endpoints(&notch, edge);
            a[2] > 9.9 && b[2] > 9.9
        })
        .unwrap();
    let (edges, corners) = step(&notch, rim, convex_top, 0.5, 1.5);
    let text = reason(&notch, &edges, &corners);
    assert!(text.starts_with("[BLD_CORNER_UNSUPPORTED]") && text.contains("needs all its edges convex or all concave"), "{text}");
    // a radius that varies along a rounded edge
    let meeting = edges_at(&shape, [0.0; 3]);
    let taper = vec![meeting[0] as f64, 1.0, 0.8, meeting[1] as f64, 1.0, 1.0];
    let (_, corners) = step(&shape, [0.0; 3], 2, 1.0, 2.0);
    let text = reason(&shape, &taper, &corners);
    assert!(text.starts_with("[BLD_CORNER_UNSUPPORTED]") && text.contains("constant radius"), "{text}");
    // the sharp edge: a setback of 0, a setback past its end
    let (edges, mut corners) = step(&shape, [0.0; 3], 2, 1.0, 2.0);
    let last = corners.len() - 1;
    corners[last] = 0.0;
    let text = reason(&shape, &edges, &corners);
    assert!(text.starts_with("[BLD_CORNER_UNSUPPORTED]") && text.contains("left sharp and has setback 0"), "{text}");
    corners[last] = 10.0;
    let text = reason(&shape, &edges, &corners);
    assert!(text.starts_with("[BLD_CORNER_UNSUPPORTED]") && text.contains("not shorter than the edge"), "{text}");
    // a setback that does not outrun the neighbours' blends: r 1 needs more than 1
    let (edges, corners) = step(&shape, [0.0; 3], 2, 1.0, 0.8);
    let text = reason(&shape, &edges, &corners);
    assert!(text.starts_with("[BLD_SETBACK_TOO_SHORT]") && text.contains("must exceed"), "{text}");
    // a crease the star cannot hold: the vertical edge of a prism whose side faces meet at 175 degrees (the normals differ by 0.087 rad)
    let obtuse =
        make_prism(&[0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 20.0, 0.874, 0.0, 10.0, 8.0, 0.0, 0.0, 8.0, 0.0], [0.0, 0.0, 6.0]).unwrap().unwrap();
    let vertex = [10.0, 0.0, 0.0];
    let found = edges_at(&obtuse, vertex);
    assert_eq!(found.len(), 3);
    let vertical = found
        .iter()
        .position(|&edge| {
            let (a, b) = endpoints(&obtuse, edge);
            (a[2] - b[2]).abs() > 1.0
        })
        .unwrap();
    let (edges, corners) = step(&obtuse, vertex, vertical, 0.5, 2.0);
    let text = reason(&obtuse, &edges, &corners);
    assert!(
        text.starts_with("[BLD_CORNER_FAILED]") && text.contains("not tangent at a vertex") && text.contains("crease the star can hold"),
        "{text}"
    );
}

/// BLD §13.33: the trim builder (curved edges or faces at the vertex, or its test hook) still rounds every edge there or names the one that is not.
#[test]
fn the_trim_builder_still_names_an_unrounded_edge() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    crate::test_bridge::set_corner_trim(true);
    let shape = cube(10.0);
    let (edges, corners) = step(&shape, [0.0; 3], 2, 1.0, 2.0);
    let text = setback_reason(&shape, &edges, &corners).unwrap();
    assert!(text.starts_with("[BLD_CORNER_UNSUPPORTED]") && text.contains("is not rounded"), "{text}");
}

/// BLD §13.33.3: a plate (MakeFilling) cannot hold the crease of the sharp edge, so a hole with a sharp edge has no plate fallback: with the star refused (hook 2), with only plates (hook 0) and
/// with a star that fails after the fills (hook 3: the plate pass) the step is refused by name, never filled with a plate that is tangent to two planes at 90 degrees.
#[test]
fn a_hole_with_a_sharp_edge_has_no_plate_fallback() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let shape = cube(10.0);
    let (edges, corners) = step(&shape, [0.0; 3], 2, 1.0, 2.0);
    for mode in [0, 2, 3] {
        crate::test_bridge::set_corner_exact_patch(mode);
        let text = setback_reason(&shape, &edges, &corners).unwrap();
        assert!(text.starts_with("[BLD_CORNER_FAILED]") && text.contains("the only patch that holds the crease"), "mode {mode}: {text}");
    }
    crate::test_bridge::set_corner_exact_patch(1);
    assert_eq!(setback_reason(&shape, &edges, &corners).unwrap(), "");
}

/// BLD §13.33.7: the far end (the pole) of the crease spokes of real stars, which justifies the 0.3 rad of `checkCornerCrease.ts` (a spoke whose smaller end is not under it is no fading crease)
/// and the 0.1 rad at which the check fails the pole reading: the cube (r 1, setback 2), the 60 degree prism (r 1, setback 3, three choices of the sharp edge) and the tetrahedron apex (r 0.5,
/// setback 2, three choices). Measured: cube 0.0035, prism 0.0040 / 0.0078 / 0.0078, tetrahedron 0.0044 to 0.0047; the largest is pinned under 0.01 rad.
#[test]
fn the_far_end_of_every_crease_spoke_is_a_few_hundredths_of_a_radian_at_most() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let mut far_ends = Vec::new();
    let cube = cube(10.0);
    let (edges, corners) = step(&cube, [0.0; 3], 2, 1.0, 2.0);
    let built = fillet_setback(&cube, &edges, &corners).unwrap().expect("a solid");
    far_ends.push(("cube", along_the_crease(&read(&built).creases[0])[20]));
    let prism = make_prism(&[0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 5.0, 75.0_f64.sqrt(), 0.0], [0.0, 0.0, 12.0]).unwrap().unwrap();
    for sharp in 0..3 {
        let (edges, corners) = step(&prism, [0.0; 3], sharp, 1.0, 3.0);
        let built = fillet_setback(&prism, &edges, &corners).unwrap().expect("a solid");
        far_ends.push(("prism", along_the_crease(&read(&built).creases[0])[20]));
    }
    let apex = [3.0, 2.0, 9.0];
    let base = [[0.0, 0.0, 0.0], [10.0, 0.0, 0.0], [4.0, 9.0, 0.0]];
    let (mut positions, mut indices) = (Vec::new(), Vec::<u32>::new());
    let mut push = |a: [f64; 3], b: [f64; 3], c: [f64; 3]| {
        let at = (positions.len() / 3) as u32;
        positions.extend(a.iter().chain(&b).chain(&c));
        indices.extend([at, at + 1, at + 2]);
    };
    for i in 0..3 {
        push(base[i], base[(i + 1) % 3], apex);
    }
    push(base[0], base[2], base[1]);
    let tetra = make_sewn_solid(&positions, &indices).unwrap().unwrap();
    for sharp in 0..3 {
        let (edges, corners) = step(&tetra, apex, sharp, 0.5, 2.0);
        let built = fillet_setback(&tetra, &edges, &corners).unwrap().expect("a solid");
        far_ends.push(("tetra", along_the_crease(&read(&built).creases[0])[20]));
    }
    assert!(far_ends.iter().all(|(_, far)| *far < 0.01), "{far_ends:?}");
}

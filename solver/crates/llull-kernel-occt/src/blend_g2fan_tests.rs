//! BLD §13.45: the vertex fans of a G2 corner star (`cpp/blend_corner_fan.cxx`): the curvature across the spokes read at fixed shares of a spoke from its vertex, on the sewn shell.

use crate::blend_corner_tests::{cube, num, point, CornerHooks};
use crate::blend_g2corner_tests::{all, corners_of, profile_of, readings, spoke_note, spokes_of, volume};
use crate::features::{fillet_profile_blend, is_valid, shape_notes};
use crate::queries::{edge_continuity, face_bspline, face_graph, topology};
use crate::{make_box, Shape};
use serde_json::Value;

/// The shares of a spoke from its vertex at which the curvature across it is read (the marks of BLD 13.44.7).
pub(crate) const MARKS: [f64; 8] = [0.0025, 0.005, 0.01, 0.02, 0.04, 0.08, 0.16, 0.24];

/// What the sewn shell reads across the spokes of its corner stars.
pub(crate) struct SpokeMarks {
    /// Per mark: the largest relative jump of the normal curvature across a spoke (|k1 - k2| / the larger), over every spoke.
    pub relative: [f64; 8],
    /// Per mark: the largest amount by which the jump exceeds the gate (0.02 of the larger curvature + 2e-4 over the mean contact length); <= 0 passes.
    pub excess: [f64; 8],
    /// The largest G1 angle over all samples of the seams.
    pub g1: f64,
}

fn same(a: [f64; 3], b: [f64; 3]) -> bool {
    a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-6)
}

fn dist(a: [f64; 3], b: [f64; 3]) -> f64 {
    a.iter().zip(b).map(|(x, y)| (x - y) * (x - y)).sum::<f64>().sqrt()
}

/// The curvature jump across the seams between corner sub-patches, at 401 samples of each, read at `MARKS` of the spoke length counted from the vertex (the end that touches a contact edge).
pub(crate) fn spoke_marks(shape: &Shape) -> SpokeMarks {
    let topo = topology(shape).unwrap();
    let names: Vec<String> = topo["faces"].as_array().unwrap().iter().map(|f| f["name"].as_str().unwrap_or("").to_string()).collect();
    let graph = face_graph(shape).unwrap();
    let edges = topo["edges"].as_array().unwrap();
    let is_star = |face: usize| names[face].starts_with("blend(v:");
    let (mut contact, mut seams) = (Vec::new(), Vec::new());
    for (edge, faces) in graph["edgeFaces"].as_array().unwrap().iter().enumerate() {
        let faces: Vec<usize> = faces.as_array().unwrap().iter().map(|f| f.as_u64().unwrap() as usize).collect();
        match (faces.len() == 2, faces.iter().filter(|f| is_star(**f)).count()) {
            (true, 1) => contact.push(edge),
            (true, 2) => seams.push(edge),
            _ => {}
        }
    }
    let floor = 2e-4 / (contact.iter().map(|e| num(&edges[*e]["length"])).sum::<f64>() / contact.len().max(1) as f64);
    let touches_contact = |p: [f64; 3]| contact.iter().any(|e| same(point(&edges[*e]["start"]), p) || same(point(&edges[*e]["end"]), p));
    // the poles: points where five or more seams end
    let ends: Vec<[f64; 3]> = seams.iter().flat_map(|e| [point(&edges[*e]["start"]), point(&edges[*e]["end"])]).collect();
    let poles: Vec<[f64; 3]> =
        ends.iter().copied().filter(|p| ends.iter().filter(|q| same(*p, **q)).count() >= 5 && !touches_contact(*p)).collect();
    let mut out = SpokeMarks { relative: [0.0; 8], excess: [f64::NEG_INFINITY; 8], g1: 0.0 };
    for edge in seams {
        let (start, end) = (point(&edges[edge]["start"]), point(&edges[edge]["end"]));
        let vertex = if touches_contact(start) {
            start
        } else if touches_contact(end) {
            end
        } else {
            continue;
        };
        let Some(pole) = poles.iter().copied().min_by(|a, b| dist(*a, vertex).partial_cmp(&dist(*b, vertex)).unwrap()) else { continue };
        let length = dist(pole, vertex);
        let samples = edge_continuity(shape, edge as f64, 401.0).unwrap();
        for sample in samples.as_array().unwrap() {
            out.g1 = out.g1.max(num(&sample["g1"]));
            let at = dist(point(&sample["point"]), vertex) / length;
            for (slot, mark) in MARKS.iter().enumerate() {
                if (at / mark - 1.0).abs() > 0.1 {
                    continue;
                }
                let (k0, k1) = (num(&sample["normalCurvature"][0]), num(&sample["normalCurvature"][1]));
                let (jump, scale) = ((k0 - k1).abs(), k0.abs().max(k1.abs()));
                if scale > 1e-12 {
                    out.relative[slot] = out.relative[slot].max(jump / scale);
                }
                out.excess[slot] = out.excess[slot].max(jump - (0.02 * scale + floor));
            }
        }
    }
    out
}

fn uneven_box() -> Shape {
    let uneven = make_box([0.0; 3], [10.0, 7.0, 5.0]).unwrap().unwrap();
    let count = topology(&uneven).unwrap()["edges"].as_array().unwrap().len();
    let specs: Vec<f64> = (0..count).flat_map(|edge| [edge as f64, 1.0, 0.5, 0.8 + 0.1 * (edge % 4) as f64, f64::NAN, -1.0, 0.0]).collect();
    fillet_profile_blend(&uneven, &specs, &[], &[], 1.0, 0.5).unwrap().expect("a box with sizes 0.8 to 1.1")
}

/// The star test bodies of 13.36 / 13.38: the cube with the section shapes and sizes, and the box with unequal sizes.
fn bodies() -> Vec<(&'static str, Shape)> {
    let mut bodies: Vec<(&'static str, Shape)> =
        [("cube", 1.0, 0.5), ("cube size 2.4", 2.4, 0.5), ("cube shape 0.3", 1.0, 0.3), ("cube shape 0.8", 1.0, 0.8)]
            .into_iter()
            .map(|(label, size, shape_factor)| {
                (label, profile_of(&cube(10.0), size, 1.0, shape_factor).unwrap_or_else(|why| panic!("{label} refused: {why}")))
            })
            .collect();
    bodies.push(("box", uneven_box()));
    bodies
}

/// The (degreeU, degreeV) of every corner face.
fn star_degrees(shape: &Shape) -> Vec<(u64, u64)> {
    let topo = topology(shape).unwrap();
    let mut degrees = Vec::new();
    for (index, face) in topo["faces"].as_array().unwrap().iter().enumerate() {
        if face["name"].as_str().is_some_and(|name| name.starts_with("blend(v:")) {
            let surface = face_bspline(shape, index as f64).unwrap();
            degrees.push((surface["degreeU"].as_u64().unwrap(), surface["degreeV"].as_u64().unwrap()));
        }
    }
    degrees
}

fn faces_of(shape: &Shape) -> usize {
    topology(shape).unwrap()["faces"].as_array().unwrap().len()
}

fn corner_notes(shape: &Shape) -> Vec<Value> {
    let notes: Value = serde_json::from_str(&shape_notes(shape).unwrap()).unwrap();
    notes["corners"].as_array().unwrap().clone()
}

/// BLD §13.45: with the vertex fans every mark of 13.44.7 passes the curvature gate on the cube and the box, the star is G2 to its supports and G1 across its spokes, and the solid is valid.
#[test]
fn the_vertex_fans_pass_every_spoke_mark_on_the_cube_and_the_box() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    crate::test_bridge::set_corner_fan(1);
    for (label, shape) in bodies().into_iter().filter(|(label, _)| *label == "cube" || *label == "box") {
        assert!(is_valid(&shape).unwrap(), "{label}");
        assert_eq!(corners_of(&shape), all("G2"), "{label}");
        assert_eq!(spokes_of(&shape), vec!["G2-fan".to_string(); 8], "{label}");
        let marks = spoke_marks(&shape);
        assert!(marks.excess.iter().all(|excess| *excess <= 0.0), "{label}: over the gate by {:?}", marks.excess);
        assert!(marks.relative[..2].iter().all(|relative| *relative < 0.1), "{label}: {:?}", marks.relative);
        assert!(marks.relative[2..].iter().all(|relative| *relative < 0.02), "{label}: {:?}", marks.relative);
        let measured = readings(&shape);
        assert!(
            measured.contacts.1 < 1e-3 && measured.contacts.0 < 1e-4,
            "{label}: contacts {:e} {:e}",
            measured.contacts.1,
            measured.contacts.0
        );
        assert!(measured.spokes.0 < 1e-4 && marks.g1 < 1e-4, "{label}: the spokes are G1: {:e} {:e}", measured.spokes.0, marks.g1);
        assert!(measured.spokes.1 < 5e-3, "{label}: spoke curvature jump {:e}", measured.spokes.1);
        // 6 trimmed sub-patches and 12 fans per corner, all degree 7
        assert_eq!(star_degrees(&shape), vec![(7, 7); 8 * 18], "{label}");
        assert!(spoke_note(&shape, "spokeReach").iter().all(|value| *value == 0.0), "{label}");
        assert!(spoke_note(&shape, "spokeRelative").iter().all(|value| *value < 0.1), "{label}");
        assert!(spoke_note(&shape, "spokeVertexRelative").iter().all(|value| *value < 0.1), "{label}");
        assert!(spoke_note(&shape, "spokeJump").iter().all(|value| *value < 5e-3), "{label}");
        assert!(
            corner_notes(&shape).iter().all(|corner| corner["spokeFanRefused"].is_null() && corner["spokeRefused"].is_null()),
            "{label}"
        );
    }
}

/// BLD §13.45: on every star test body the fan is never worse than the G2-beyond-reach spokes at any mark (it passes the gate, or reads no more than they do), keeps the volume and the contacts.
#[test]
fn the_vertex_fans_are_never_worse_than_the_beyond_reach_spokes() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    crate::test_bridge::set_corner_fan(0);
    let beyond = bodies();
    crate::test_bridge::set_corner_fan(1);
    let fans = bodies();
    for ((label, reference), (_, fan)) in beyond.iter().zip(fans.iter()) {
        assert_eq!(spokes_of(reference), vec!["G2-beyond-reach".to_string(); 8], "{label}");
        assert_eq!(spokes_of(fan), vec!["G2-fan".to_string(); 8], "{label}");
        let (before, after) = (spoke_marks(reference), spoke_marks(fan));
        for mark in 0..8 {
            assert!(
                after.excess[mark] <= 0.0 || after.relative[mark] <= before.relative[mark] + 1e-9,
                "{label}: mark {mark}: relative {} against {}, over the gate by {}",
                after.relative[mark],
                before.relative[mark],
                after.excess[mark]
            );
            assert!(after.excess[mark] <= before.excess[mark].max(0.0), "{label}: mark {mark} passes less than the beyond-reach spokes");
        }
        assert!(
            (volume(fan) - volume(reference)).abs() < 1e-4 * volume(reference),
            "{label}: {} against {}",
            volume(fan),
            volume(reference)
        );
        let (contacts_fan, contacts_reference) = (readings(fan), readings(reference));
        assert!(
            contacts_fan.contacts.1 < 1e-3 && contacts_fan.contacts.0 < 1e-4,
            "{label}: {:e} {:e}",
            contacts_fan.contacts.1,
            contacts_fan.contacts.0
        );
        assert!(
            contacts_fan.spokes.1 < contacts_reference.spokes.1,
            "{label}: spoke jump {:e} against {:e}",
            contacts_fan.spokes.1,
            contacts_reference.spokes.1
        );
        assert!(is_valid(fan).unwrap(), "{label}");
    }
}

/// BLD §13.45: a star whose fans are refused keeps the G2-beyond-reach spokes (so it is never worse) and the note says why.
#[test]
fn refused_vertex_fans_leave_the_beyond_reach_spokes_with_the_reason() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    crate::test_bridge::set_corner_fan(2);
    let shape = profile_of(&cube(10.0), 1.0, 1.0, 0.5).unwrap();
    assert!(is_valid(&shape).unwrap());
    assert_eq!(corners_of(&shape), all("G2"));
    assert_eq!(spokes_of(&shape), vec!["G2-beyond-reach".to_string(); 8]);
    assert_eq!(faces_of(&shape), 66);
    for corner in corner_notes(&shape) {
        assert!(corner["spokeFanRefused"].as_str().is_some_and(|why| why.contains("refused by the test hook")), "{corner}");
    }
    // off: nothing is attempted, nothing is said
    crate::test_bridge::set_corner_fan(0);
    let plain = profile_of(&cube(10.0), 1.0, 1.0, 0.5).unwrap();
    assert_eq!(spokes_of(&plain), vec!["G2-beyond-reach".to_string(); 8]);
    assert!(corner_notes(&plain).iter().all(|corner| corner["spokeFanRefused"].is_null()));
}

/// BLD §13.46: an OCCT exception inside the fan construction (hook mode 3) is caught: every corner keeps the G2-beyond-reach spokes (66 faces as with the fans off) and names the exception.
#[test]
fn an_occt_exception_inside_the_fans_falls_back_to_the_beyond_reach_spokes() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    crate::test_bridge::set_corner_fan(3);
    let shape = profile_of(&cube(10.0), 1.0, 1.0, 0.5).unwrap();
    assert!(is_valid(&shape).unwrap());
    assert_eq!(corners_of(&shape), all("G2"));
    assert_eq!(spokes_of(&shape), vec!["G2-beyond-reach".to_string(); 8]);
    assert_eq!(faces_of(&shape), 66);
    for corner in corner_notes(&shape) {
        assert!(
            corner["spokeFanRefused"].as_str().is_some_and(|why| why.contains("OCCT exception") && why.contains("fault injected")),
            "{corner}"
        );
    }
}

/// BLD §13.46 review: a std::exception inside the fans (hook 4), an exception after they are built, while their seams are read (hook 6), and a rung whose faces OCCT cannot make (hook 5: the next
/// rung builds the fans, so the star still has them).
#[test]
fn every_kind_of_failure_in_the_fan_branch_falls_back_or_climbs_to_the_next_rung() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    for (mode, expected, reason) in [
        (4, "G2-beyond-reach", "an exception inside the vertex fans"),
        (6, "G2-beyond-reach", "while the vertex fans were read"),
        (5, "G2-fan", ""),
    ] {
        crate::test_bridge::set_corner_fan(mode);
        let shape = profile_of(&cube(10.0), 1.0, 1.0, 0.5).unwrap();
        assert!(is_valid(&shape).unwrap(), "mode {mode}");
        assert_eq!(spokes_of(&shape), vec![expected.to_string(); 8], "mode {mode}");
        assert_eq!(faces_of(&shape), if expected == "G2-fan" { 162 } else { 66 }, "mode {mode}");
        for corner in corner_notes(&shape) {
            match corner["spokeFanRefused"].as_str() {
                Some(why) => assert!(why.contains(reason), "mode {mode}: {corner}"),
                None => assert!(reason.is_empty(), "mode {mode}: {corner}"),
            }
        }
    }
}

/// BLD §13.46 review: a step whose shell with fans fails after the fills (hook 8 of the exact patch) is built again with the 13.38 spokes, not with the G1 star or the plate: every corner is G2 with
/// G2-beyond-reach spokes and says so in `spokeFanRefused`.
#[test]
fn a_step_with_fans_that_fails_after_the_sewing_is_rebuilt_with_the_beyond_reach_spokes() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    crate::test_bridge::set_corner_exact_patch(8);
    let shape = profile_of(&cube(10.0), 1.0, 1.0, 0.5).unwrap();
    assert!(is_valid(&shape).unwrap());
    assert_eq!(corners_of(&shape), all("G2"));
    assert_eq!(spokes_of(&shape), vec!["G2-beyond-reach".to_string(); 8]);
    assert_eq!(faces_of(&shape), 66);
    for corner in corner_notes(&shape) {
        assert!(
            corner["spokeFanRefused"].as_str().is_some_and(|why| why.contains("the step with the vertex fans failed after the sewing")),
            "{corner}"
        );
    }
}

/// BLD §13.46: the box of the fan shell comes from the Bezier patches of its faces (the trimmed sub-patches count by their rectangle) and is the box of the part: the blends round the edges
/// inside it, so it is the cube itself to 1e-6, with the fans and without; the volume, area and the corner count are the same.
#[test]
fn the_bounds_of_the_fan_shell_are_the_box_of_the_part() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let mut areas = Vec::new();
    for mode in [0, 1] {
        crate::test_bridge::set_corner_fan(mode);
        let shape = profile_of(&cube(10.0), 1.0, 1.0, 0.5).unwrap();
        let bounds = crate::shape_bounds(&shape).unwrap().expect("a box");
        for (axis, value) in bounds.iter().enumerate() {
            let expected = if axis < 3 { 0.0 } else { 10.0 };
            assert!((value - expected).abs() < 1e-6, "mode {mode}: {bounds:?}");
        }
        areas.push(crate::analyze(&shape).unwrap().area);
    }
    assert!((areas[0] - areas[1]).abs() < 1e-6 * areas[0], "{areas:?}");
}

/// BLD §13.46: the gates themselves refuse (not the hook): on the block cut by a cylinder (radius 15, size 0.2) one corner gets its fans and the other seven miss the seam curvature gate
/// (the chain of the bottom has a joint where the support changes, inside a corner triangle, 13.45.3). They keep the 13.38 spokes, name the gate, and the face count is the 13.38 one plus 12 per fan corner.
#[test]
fn fans_that_miss_a_gate_keep_the_beyond_reach_spokes_and_name_the_gate() {
    let _serial = crate::serial_blends();
    let _reset = CornerHooks;
    let (block, _, _) = crate::blend_corner_tests::cut_block_vertex(15.0);
    crate::test_bridge::set_corner_fan(0);
    let reference = profile_of(&block, 0.2, 1.0, 0.5).unwrap();
    crate::test_bridge::set_corner_fan(1);
    let shape = profile_of(&block, 0.2, 1.0, 0.5).unwrap();
    assert!(is_valid(&shape).unwrap());
    let spokes = spokes_of(&shape);
    let fans = spokes.iter().filter(|spokes| *spokes == "G2-fan").count();
    assert!(fans >= 1 && fans < spokes.len(), "{spokes:?}");
    assert_eq!(corners_of(&shape), corners_of(&reference));
    assert_eq!(faces_of(&shape), faces_of(&reference) + 12 * fans);
    for (spoke, corner) in spokes.iter().zip(corner_notes(&shape)) {
        if spoke == "G2-fan" {
            assert!(corner["spokeFanRefused"].is_null(), "{corner}");
        } else {
            assert_eq!(spoke, "G2-beyond-reach");
            assert!(corner["spokeFanRefused"].as_str().is_some_and(|why| why.contains("over the curvature gate by")), "{corner}");
        }
    }
}

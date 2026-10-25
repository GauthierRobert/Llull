//! BLD M3: setback corners (`features::fillet_setback`, `cpp/blend_corner.cxx`).

use crate::features::{fillet_setback, setback_reason};
use crate::queries::{edge_continuity, topology};
use crate::{analyze, make_box, make_sewn_solid, mass_properties, Shape};
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

/// Edge indices (all of them) with radius `radius`, and one corner per `vertex` with `setback` on every edge that meets it.
fn spec(shape: &Shape, edges: &[usize], radius: f64, vertices: &[[f64; 3]], setback: f64) -> (Vec<f64>, Vec<f64>) {
    let topo = topology(shape).unwrap();
    let list = topo["edges"].as_array().unwrap();
    let near = |a: [f64; 3], b: [f64; 3]| a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-6);
    let mut flat_edges = Vec::new();
    for &edge in edges {
        flat_edges.extend([edge as f64, radius]);
    }
    let mut flat_corners = Vec::new();
    for vertex in vertices {
        let meeting: Vec<usize> = list
            .iter()
            .enumerate()
            .filter(|(_, edge)| near(point(&edge["start"]), *vertex) || near(point(&edge["end"]), *vertex))
            .map(|(index, _)| index)
            .collect();
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
    let apex = [5.0, 5.0, 10.0];
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

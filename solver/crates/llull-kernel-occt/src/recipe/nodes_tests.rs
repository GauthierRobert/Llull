//! Tests of the recipe nodes in `nodes.rs` and `wrap_nodes.rs`.

use super::nodes::*;
use super::{Evaluated, Evaluator};
use serde_json::{json, Value};

fn volume(evaluated: Evaluated) -> f64 {
    crate::mass_properties(&evaluated.unwrap().unwrap()).unwrap().volume
}

fn cube_leaf(size: f64) -> Value {
    json!({ "op": "solid", "entity": { "kind": "box", "size": [size, size, size], "position": [0, 0, 0], "rotation": [0, 0, 0] } })
}

#[test]
fn a_feature_cut_tries_brep_feat_then_the_lowered_tool() {
    let mut evaluator = Evaluator::new(16);
    let tool = cube_leaf(1.0);
    let lowered = json!({ "op": "featureCut", "mode": "subtract", "source": cube_leaf(2.0), "tool": tool });
    assert!((volume(evaluator.evaluate(&lowered)) - 7.0).abs() < 1e-9);
    let refused = json!({ "op": "featureCut", "mode": "subtract", "source": cube_leaf(2.0), "tool": null });
    assert!(evaluator.evaluate(&refused).unwrap().is_none());
    let profile = [0.0, 0.0, 1.5, 0.25, 0.0, 1.5, 0.25, 0.0, -1.5, 0.0, 0.0, -1.5];
    let drilled = json!({
        "op": "featureCut", "mode": "subtract", "source": cube_leaf(2.0), "tool": tool,
        "holes": { "profiles": [profile], "origins": [[0, 0, 0]], "normal": [0, 0, 1] },
    });
    let expected = 8.0 - std::f64::consts::PI * 0.0625 * 2.0;
    assert!((volume(evaluator.evaluate(&drilled)) - expected).abs() < 1e-9, "the BRepFeat revolution, not the tool");
}

#[test]
fn a_pocket_floor_fillet_adds_the_concave_fillet_material() {
    let _serial = crate::serial_blends();
    let mut evaluator = Evaluator::new(16);
    let source = json!({ "op": "solid", "entity": { "kind": "box", "size": [10, 10, 2], "position": [0, 0, 0], "rotation": [0, 0, 0] } });
    let tool =
        json!({ "op": "solid", "entity": { "kind": "cylinder", "radius": 2, "height": 2, "position": [0, 0, 1], "rotation": [0, 0, 0] } });
    let half = |from: [f64; 2], through: [f64; 2], to: [f64; 2]| json!({ "type": "arc", "points": [from, through, to] });
    let floor = |radius: f64| {
        json!({
            "radius": radius, "floorDepth": 1, "origin": [0, 0, 1], "normal": [0, 0, 1], "xDir": [1, 0, 0],
            "outlines": [[half([2.0, 0.0], [0.0, 2.0], [-2.0, 0.0]), half([-2.0, 0.0], [0.0, -2.0], [2.0, 0.0])]],
        })
    };
    let pocket = |floor: Value| json!({ "op": "featureCut", "mode": "subtract", "source": source, "tool": tool, "floorFillet": floor });
    let (pi, r, big_r) = (std::f64::consts::PI, 0.5, 2.0);
    let material = 2.0 * pi * (r * r * (big_r - r / 2.0) - pi * r * r / 4.0 * (big_r - r) - r.powi(3) / 3.0);
    let expected = 200.0 - 4.0 * pi + material;
    assert!((volume(evaluator.evaluate(&pocket(floor(r)))) - expected).abs() < 1e-6, "Pappus volume of the floor fillet");
    let nowhere = json!({ "radius": r, "floorDepth": 0.25, "origin": [0, 0, 1], "normal": [0, 0, 1], "xDir": [1, 0, 0], "outlines": [] });
    assert!(evaluator.evaluate(&pocket(nowhere)).unwrap().is_none(), "no floor edge = refused");
}

#[test]
fn a_sheet_leaf_and_a_face_slab_build_from_their_payloads() {
    let mut evaluator = Evaluator::new(16);
    // bilinear sheet over [0, 4] x [0, 3] (u, v in [0, 1]), trimmed to the middle half in u, placed 1 up in z
    let surface = [
        1.0, 1.0, 2.0, 2.0, 2.0, 2.0, 0.0, 0.0, 0.0, 0.0, 0.0, 3.0, 0.0, 4.0, 0.0, 0.0, 4.0, 3.0, 0.0, 0.0, 1.0, 2.0, 2.0, 0.0, 1.0, 2.0,
        2.0,
    ];
    let trim = [1.0, 4.0, 1.0, 0.25, 0.0, 0.75, 0.0, 0.75, 1.0, 0.25, 1.0];
    let sheet = |native: Value| json!({ "op": "solid", "entity": { "id": "s", "kind": "nurbs_surface", "position": [0, 0, 1], "rotation": [0, 0, 0], "native": native } });
    let area = |evaluated: Evaluated| crate::mass_properties(&evaluated.unwrap().unwrap()).unwrap();
    let whole = area(evaluator.evaluate(&sheet(json!({ "surface": surface }))));
    assert!((whole.area - 12.0).abs() < 1e-9 && (whole.bounds[2] - 1.0).abs() < 1e-3, "placed sheet area {}", whole.area);
    let trimmed = area(evaluator.evaluate(&sheet(json!({ "surface": surface, "loops": trim }))));
    assert!((trimmed.area - 6.0).abs() < 1e-9, "trimmed sheet area {}", trimmed.area);
    assert!(evaluator.evaluate(&sheet(json!({}))).unwrap().is_none(), "a sheet without its payload is refused");
    let slab = json!({
        "op": "faceSlab", "surface": { "type": "bspline", "data": surface }, "loops": trim, "from": 0.5, "to": 1.0, "direction": [0, 0, 1],
    });
    assert!((volume(evaluator.evaluate(&slab)) - 3.0).abs() < 1e-6, "slab = trimmed area x thickness");
    let backwards = json!({ "op": "faceSlab", "surface": { "type": "plane", "data": [0, 0, 0, 1, 0, 0, 0, 1, 0] }, "loops": trim, "from": 1, "to": 1, "direction": [0, 0, 1] });
    assert!(evaluator.evaluate(&backwards).unwrap().is_none());
}

#[test]
fn malformed_payloads_are_refused_before_the_kernel_reads_them() {
    let mut evaluator = Evaluator::new(16);
    let plane = json!({ "type": "plane", "data": [0, 0, 0, 1, 0, 0, 0, 1, 0] });
    let square = json!([1, 4, 1, 0, 0, 1, 0, 1, 1, 0, 1]);
    let slab = |surface: Value, loops: Value| json!({ "op": "faceSlab", "surface": surface, "loops": loops, "from": 0, "to": 1, "direction": [0, 0, 1] });
    assert!((volume(evaluator.evaluate(&slab(plane.clone(), square.clone()))) - 1.0).abs() < 1e-9);
    let refused = [
        slab(plane.clone(), json!([1, 1e19, 1, 0, 0])),
        slab(plane.clone(), json!([1, 4, 1, 0, 0])),
        slab(plane.clone(), json!([2, 4, 1, 0, 0, 1, 0, 1, 1, 0, 1, 4, 1, 0, 0, 1, 0, 1, 1, 0, 1])),
        slab(plane.clone(), json!([1, 4, 0, 0, 0, 1, 0, 1, 1, 0, 1])),
        slab(plane.clone(), json!([])),
        slab(json!({ "type": "plane", "data": [0, 0, 0] }), square.clone()),
        slab(json!({ "type": "cylinder", "data": [0, 0, 0, 0, 0, 1, 1, 0, 0, -1] }), square.clone()),
        slab(json!({ "type": "bspline", "data": [1, 1, 1e19, 2, 2, 2, 0] }), square.clone()),
        slab(json!({ "type": "bspline", "data": [] }), square.clone()),
        slab(json!({ "type": "torus", "data": [] }), square.clone()),
    ];
    for recipe in &refused {
        assert!(evaluator.evaluate(recipe).unwrap().is_none(), "{recipe}");
    }
    let sheet = json!({ "op": "solid", "entity": { "id": "s", "kind": "nurbs_surface", "position": [0, 0, 0], "rotation": [0, 0, 0], "native": { "surface": [1, 1, 2, 2, 2, 2, 0], "loops": [] } } });
    assert!(evaluator.evaluate(&sheet).unwrap().is_none());
}

#[test]
fn freeform_leaves_build_from_the_host_payload() {
    let mut evaluator = Evaluator::new(16);
    let leaf = |entity: Value| json!({ "op": "solid", "entity": entity });
    let square = |z: f64| -> Vec<f64> {
        let corners = [[1.0, 1.0], [-1.0, 1.0], [-1.0, -1.0], [1.0, -1.0], [1.0, 1.0]];
        corners.windows(2).flat_map(|pair| [0.0, pair[0][0], pair[0][1], z, pair[1][0], pair[1][1], z]).collect()
    };
    let loft = json!({ "kind": "loft", "native": { "chains": [square(0.0), square(2.0)], "ruled": true } });
    assert!((volume(evaluator.evaluate(&leaf(loft))) - 8.0).abs() < 1e-6);
    // the same loft from B-spline sections (degree 1, five poles, closed square): volume 8; malformed B-spline data falls back to the chains
    let bspline_square = |z: f64| -> Vec<f64> {
        let corners = [[1.0, 1.0], [-1.0, 1.0], [-1.0, -1.0], [1.0, -1.0], [1.0, 1.0]];
        let mut data = vec![1.0, 5.0, 5.0, 0.0, 0.0];
        data.extend(corners.iter().flat_map(|corner| [corner[0], corner[1], z]));
        data.extend([0.0, 1.0, 2.0, 3.0, 4.0, 2.0, 1.0, 1.0, 1.0, 2.0]);
        data
    };
    let exact = json!({ "kind": "loft", "native": { "bsplines": [bspline_square(0.0), bspline_square(2.0)], "chains": [square(0.0), square(2.0)], "ruled": true } });
    assert!((volume(evaluator.evaluate(&leaf(exact))) - 8.0).abs() < 1e-6, "B-spline sections");
    let malformed =
        json!({ "kind": "loft", "native": { "bsplines": [[1.0, 5.0], [1.0]], "chains": [square(0.0), square(2.0)], "ruled": true } });
    assert!((volume(evaluator.evaluate(&leaf(malformed))) - 8.0).abs() < 1e-6, "fallback to the chains");
    let sweep = json!({ "kind": "sweep", "native": { "spine": [0, 0, 0, 0, 0, 0, 2], "chain": square(0.0) } });
    assert!((volume(evaluator.evaluate(&leaf(sweep))) - 8.0).abs() < 1e-6);
    let tetra = json!({ "positions": [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], "indices": [0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2] });
    let faceted = json!({ "kind": "subdivision", "native": { "patches": [0.0], "triangles": tetra } });
    assert!((volume(evaluator.evaluate(&leaf(faceted))) - 1.0 / 6.0).abs() < 1e-9, "bad patches fall back to the triangles");
    let extrusion = json!({ "kind": "extrusion", "profile": [[1, 1], [-1, 1], [-1, -1], [1, -1]], "depth": 3, "chain": square(0.0) });
    assert!((volume(evaluator.evaluate(&leaf(extrusion))) - 12.0).abs() < 1e-9);
}

/// The four lateral faces of a square prism of half width `half` and height 2 (clamped bilinear surfaces).
fn prism_sides(half: f64) -> Vec<Vec<f64>> {
    let side = |a: [f64; 2], b: [f64; 2]| {
        let mut data = vec![1.0, 1.0, 2.0, 2.0, 2.0, 2.0, 0.0];
        data.extend([a[0], a[1], 0.0, a[0], a[1], 2.0, b[0], b[1], 0.0, b[0], b[1], 2.0]);
        data.extend([0.0, 1.0, 2.0, 2.0, 0.0, 1.0, 2.0, 2.0]);
        data
    };
    vec![
        side([-half, -half], [half, -half]),
        side([half, -half], [half, half]),
        side([half, half], [-half, half]),
        side([-half, half], [-half, -half]),
    ]
}

fn sheet_node(faces: Vec<Vec<f64>>) -> Value {
    json!({ "op": "sheetSolid", "faces": faces, "tolerance": 1e-6, "caps": 2, "position": [0, 0, 0], "rotation": [0, 0, 0] })
}

#[test]
fn a_sheet_solid_node_sews_caps_places_and_cuts_a_bore() {
    let mut evaluator = Evaluator::new(16);
    // the four sides of a 2 x 2 x 2 prism are sewn and capped
    assert!((volume(evaluator.evaluate(&sheet_node(prism_sides(1.0)))) - 8.0).abs() < 1e-9, "fitted faces");
    // placed like an entity leaf, and named after its entity
    let mut placed = sheet_node(prism_sides(1.0));
    placed["position"] = json!([5, 0, 0]);
    placed["name"] = json!("sweep-1");
    let shape = evaluator.evaluate(&placed).unwrap().unwrap();
    let bounds = crate::mass_properties(&shape).unwrap();
    assert!((bounds.volume - 8.0).abs() < 1e-9 && (bounds.centroid[0] - 5.0).abs() < 1e-9, "placed at x = 5");
    // a bored prism: outer 4 x 4 x 2 minus the inner 2 x 2 x 2
    let mut hollow = sheet_node(prism_sides(2.0));
    hollow["bore"] = json!(prism_sides(1.0));
    assert!((volume(evaluator.evaluate(&hollow)) - 24.0).abs() < 1e-9, "outer minus bore");
    // malformed data is refused, never a panic: face data, tolerance, caps, bore faces, placement
    let mut bad_face = sheet_node(prism_sides(1.0));
    bad_face["faces"] = json!([[1.0]]);
    let mut bad_tolerance = sheet_node(prism_sides(1.0));
    bad_tolerance["tolerance"] = json!(0);
    let mut bad_caps = sheet_node(prism_sides(1.0));
    bad_caps["caps"] = json!(3);
    let mut bad_bore = sheet_node(prism_sides(2.0));
    bad_bore["bore"] = json!([[1.0]]);
    let mut no_placement = sheet_node(prism_sides(1.0));
    no_placement.as_object_mut().unwrap().remove("position");
    let mut open = sheet_node(prism_sides(1.0)[..3].to_vec());
    open["caps"] = json!(2);
    for (label, node) in
        [("face", bad_face), ("tolerance", bad_tolerance), ("caps", bad_caps), ("bore", bad_bore), ("placement", no_placement)]
    {
        assert!(evaluator.evaluate(&node).unwrap().is_none(), "{label} is refused");
    }
    assert!(evaluator.evaluate(&open).map_or(true, |shape| shape.is_none()), "an open prism is refused");
}

#[test]
fn a_sheet_solid_node_accepts_a_pipe_shell_only_when_it_matches_the_fitted_faces() {
    let mut evaluator = Evaluator::new(16);
    // a 2 x 2 square section along +z by 2: the pipe shell builds the same prism, so it passes (volume 8 either way)
    let corners = [[1.0, 1.0], [-1.0, 1.0], [-1.0, -1.0], [1.0, -1.0], [1.0, 1.0]];
    let chain: Vec<f64> = corners.windows(2).flat_map(|pair| [0.0, pair[0][0], pair[0][1], 0.0, pair[1][0], pair[1][1], 0.0]).collect();
    let mut node = sheet_node(prism_sides(1.0));
    node["pipeShell"] = json!({ "spine": [0, 0, 0, 0, 0, 0, 2], "chain": chain, "mode": 0, "direction": [0, 0, 1], "transition": 0, "tolerance": 1e-6, "probes": [], "check": 1e-6 });
    assert!((volume(evaluator.evaluate(&node)) - 8.0).abs() < 1e-6, "pipe shell or fitted faces, the same prism");
    // a pipe shell without a section falls back to the fitted faces
    node["pipeShell"] = json!({ "spine": [0, 0, 0, 0, 0, 0, 2], "mode": 0 });
    assert!((volume(evaluator.evaluate(&node)) - 8.0).abs() < 1e-9, "fitted faces");
}

#[test]
fn a_thread_tool_marks_every_recipe_built_on_it() {
    let groove = json!({ "op": "solid", "entity": { "kind": "mesh", "threadTool": true } });
    let union = json!({ "op": "boolean", "boolean": "union", "a": cube_leaf(1.0), "b": { "op": "place", "source": groove } });
    assert!(thread_bearing(&union));
    assert!(!thread_bearing(&json!({ "op": "blend", "sources": [cube_leaf(1.0), cube_leaf(2.0)] })));
}

fn plate_with_bore() -> Value {
    let plate = json!({ "op": "solid", "entity": { "kind": "box", "size": [20, 20, 10], "position": [0, 0, 0], "rotation": [0, 0, 0] } });
    let pin =
        json!({ "op": "solid", "entity": { "kind": "cylinder", "radius": 3, "height": 20, "position": [0, 0, 0], "rotation": [0, 0, 0] } });
    json!({ "op": "boolean", "boolean": "subtract", "a": plate, "b": pin })
}

fn face_op(source: &Value, node: Value) -> Value {
    let mut recipe = node;
    recipe["op"] = json!("faceOp");
    recipe["source"] = source.clone();
    recipe
}

#[test]
fn move_faces_offsets_a_bore_translates_a_plane_and_rotates_a_plane() {
    let mut evaluator = Evaluator::new(16);
    let plate = plate_with_bore();
    let before = volume(evaluator.evaluate(&plate));
    assert!((before - (4000.0 - std::f64::consts::PI * 90.0)).abs() < 1e-6);
    // the bore wall is the only cylindrical face: try each face, exactly one widens the bore by the offset
    let widened = (0..8)
        .map(|face| face_op(&plate, json!({ "kind": "moveFaces", "faces": [face], "move": { "type": "offset", "distance": 1 } })))
        .filter_map(|recipe| evaluator.evaluate(&recipe).ok().flatten())
        .map(|shape| crate::mass_properties(&shape).unwrap().volume)
        .filter(|volume| (volume - (4000.0 - std::f64::consts::PI * 160.0)).abs() < 1e-6)
        .count();
    assert_eq!(widened, 1, "only the bore wall offsets radially away from its axis");
    let cube = cube_leaf(10.0);
    let up = |faces: Vec<u32>, vector: [f64; 3]| {
        face_op(&cube, json!({ "kind": "moveFaces", "faces": faces, "move": { "type": "translate", "vector": vector } }))
    };
    let grown = (0..6).any(|face| {
        evaluator
            .evaluate(&up(vec![face], [0.0, 0.0, 2.0]))
            .ok()
            .flatten()
            .is_some_and(|shape| (crate::mass_properties(&shape).unwrap().volume - 1200.0).abs() < 1e-6)
    });
    assert!(grown, "the +z face moved by the normal component");
    assert!(evaluator.evaluate(&up(vec![0], [0.0, 0.0, 0.0])).unwrap().is_none(), "a zero vector is refused");
    let tilted = (0..6).any(|face| {
        let recipe = face_op(
            &cube,
            json!({ "kind": "moveFaces", "faces": [face], "move": { "type": "rotate", "axis": { "origin": [5.0, 0.0, -5.0], "direction": [0.0, 1.0, 0.0] }, "angle": 10f64.to_radians() } }),
        );
        evaluator.evaluate(&recipe).ok().flatten().is_some_and(|shape| (crate::mass_properties(&shape).unwrap().volume - 1088.16349035).abs() < 1e-6)
    });
    assert!(tilted, "the +x face tilted 10 degrees about its bottom edge");
}

#[test]
fn delete_faces_refuses_what_it_cannot_heal_and_fills_a_bore() {
    let mut evaluator = Evaluator::new(16);
    let plate = plate_with_bore();
    let filled = (0..8)
        .map(|face| face_op(&plate, json!({ "kind": "deleteFaces", "faces": [face] })))
        .filter_map(|recipe| evaluator.evaluate(&recipe).ok().flatten())
        .map(|shape| crate::mass_properties(&shape).unwrap().volume)
        .filter(|volume| (volume - 4000.0).abs() < 1e-6)
        .count();
    assert_eq!(filled, 1, "deleting the bore wall fills the hole");
    let cube = cube_leaf(10.0);
    let every_face = face_op(&cube, json!({ "kind": "deleteFaces", "faces": [0, 1, 2, 3, 4, 5] }));
    assert!(evaluator.evaluate(&every_face).unwrap().is_none(), "nothing is left to extend");
    let beyond = face_op(&cube, json!({ "kind": "deleteFaces", "faces": [99] }));
    assert!(evaluator.evaluate(&beyond).unwrap().is_none(), "a face index outside the solid is refused");
    let bad = face_op(&cube, json!({ "kind": "moveFaces", "faces": [0], "move": { "type": "spin" } }));
    assert!(evaluator.evaluate(&bad).unwrap().is_none(), "an unknown move type is refused");
}

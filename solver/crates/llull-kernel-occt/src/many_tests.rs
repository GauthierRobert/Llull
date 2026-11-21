//! ASC M1a: the multi-tool boolean (`cpp/boolean_many.cxx`, `recipe/many.rs`) and the deadline / cancel of native operations (`cpp/progress.cxx`).

use crate::recipe::{Evaluator, TIMEOUT};
use crate::test_bridge::set_many_fault;
use serde_json::{json, Value};

fn solid(kind: &str, fields: Value) -> Value {
    let mut base = json!({ "id": "e", "kind": kind, "position": [0, 0, 0], "rotation": [0, 0, 0], "layerId": "l", "color": "#888" });
    base.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());
    json!({ "op": "solid", "entity": base })
}

/// The balanced union `boolean.ts` builds: split at ceil(n / 2).
fn balanced(tools: &[Value]) -> Value {
    if tools.len() == 1 {
        return tools[0].clone();
    }
    let head = tools.len().div_ceil(2);
    json!({ "op": "boolean", "boolean": "union", "a": balanced(&tools[..head]), "b": balanced(&tools[head..]) })
}

fn node(boolean: &str, a: &Value, tools: &[Value], many: bool) -> Value {
    let mut node = json!({ "op": "boolean", "boolean": boolean, "a": a, "b": balanced(tools) });
    if many {
        node["many"] = json!(tools.len());
    }
    node
}

/// Boxes `step` apart, each overlapping the next one along x.
fn boxes(count: usize) -> Vec<Value> {
    (0..count)
        .map(|k| solid("box", json!({ "size": [3, 2, 2], "position": [2.0 * k as f64, if k % 2 == 0 { 0.0 } else { 0.5 }, 0] })))
        .collect()
}

/// Cylinders on a grid, through the plate of `plate()`.
fn drills(columns: usize, rows: usize) -> Vec<Value> {
    (0..columns * rows)
        .map(|k| {
            let (x, y) = ((k % columns) as f64 * 4.0 + 2.0, (k / columns) as f64 * 4.0 + 2.0);
            solid("cylinder", json!({ "radius": 1, "height": 6, "position": [x, y, 0] }))
        })
        .collect()
}

fn plate(columns: usize, rows: usize) -> Value {
    let (width, depth) = (columns as f64 * 4.0, rows as f64 * 4.0);
    solid("box", json!({ "size": [width, depth, 2], "position": [width / 2.0, depth / 2.0, 0] }))
}

fn measure(evaluator: &mut Evaluator, recipe: &Value) -> (f64, usize) {
    let shape = evaluator.evaluate(recipe).unwrap().unwrap();
    let volume = crate::mass_properties(&shape).unwrap().volume;
    let faces = crate::queries::topology(&shape).unwrap()["faces"].as_array().unwrap().len();
    (volume, faces)
}

/// The edge list of the shape of `recipe`, as (index, rounded length) pairs: the order a stored `edges: [..]` index reads.
fn edge_order(evaluator: &mut Evaluator, recipe: &Value) -> Vec<String> {
    let shape = evaluator.evaluate(recipe).unwrap().unwrap();
    let topology = crate::queries::topology(&shape).unwrap();
    topology["edges"].as_array().unwrap().iter().map(|edge| edge.to_string()).collect()
}

fn assert_same(many: (f64, usize), tree: (f64, usize)) {
    assert!((many.0 - tree.0).abs() <= 1e-6 * tree.0, "volume {} vs tree {}", many.0, tree.0);
    assert_eq!(many.1, tree.1, "face count");
}

#[test]
fn a_many_fuse_of_overlapping_boxes_equals_the_balanced_tree() {
    let _serial = crate::serial_blends();
    let mut evaluator = Evaluator::new(256);
    let base = solid("box", json!({ "size": [3, 2, 2], "position": [-2, 0, 0] }));
    for count in [2, 5, 24] {
        let tools = boxes(count);
        let tree = measure(&mut evaluator, &node("union", &base, &tools, false));
        let many = node("union", &base, &tools, true);
        assert_same(measure(&mut evaluator, &many), tree);
        let report = evaluator.boolean_report(&many).unwrap();
        assert_eq!(report["mode"], "general-fuse", "{count} tools: {report}");
        assert_eq!(report["tools"], count);
    }
}

#[test]
fn a_many_subtract_of_cylinders_drills_every_hole_like_the_tree() {
    let _serial = crate::serial_blends();
    let mut evaluator = Evaluator::new(256);
    let (base, tools) = (plate(6, 5), drills(6, 5));
    let tree = measure(&mut evaluator, &node("subtract", &base, &tools, false));
    let many = node("subtract", &base, &tools, true);
    let got = measure(&mut evaluator, &many);
    assert_same(got, tree);
    let expected = 24.0 * 20.0 * 2.0 - 30.0 * std::f64::consts::PI * 2.0;
    assert!((got.0 - expected).abs() < 1e-6 * expected, "analytic volume {} vs {expected}", got.0);
    assert_eq!(evaluator.boolean_report(&many).unwrap()["mode"], "general-fuse");
}

#[test]
fn a_refused_general_fuse_runs_the_balanced_tree_and_reports_the_fallback() {
    let _serial = crate::serial_blends();
    let mut evaluator = Evaluator::new(256);
    let (base, tools) = (plate(3, 3), drills(3, 3));
    let tree = measure(&mut evaluator, &node("subtract", &base, &tools, false));
    set_many_fault(true);
    let many = node("subtract", &base, &tools, true);
    let got = measure(&mut evaluator, &many);
    set_many_fault(false);
    assert_same(got, tree);
    let report = evaluator.boolean_report(&many).unwrap();
    assert_eq!(report["mode"], "balanced-tree");
    assert_eq!(report["code"], "KRN_FUSE_FALLBACK");
    assert_eq!(report["fallback"], true);
}

#[test]
fn a_many_node_that_is_not_one_multi_tool_boolean_evaluates_as_written() {
    let _serial = crate::serial_blends();
    let mut evaluator = Evaluator::new(64);
    let (base, tools) = (plate(2, 2), drills(2, 2));
    let tree = measure(&mut evaluator, &node("subtract", &base, &tools, false));
    // `many` over a `b` that is not a union tree (here one solid), and a count below 2: the plain boolean, no report
    let one = json!({ "op": "boolean", "boolean": "subtract", "a": base, "b": tools[0], "many": 2 });
    assert!(evaluator.evaluate(&one).unwrap().is_some());
    assert_eq!(evaluator.boolean_report(&one).unwrap(), Value::Null);
    let mut small = node("subtract", &base, &tools, true);
    small["many"] = json!(1);
    assert_same(measure(&mut evaluator, &small), tree);
    assert_eq!(evaluator.boolean_report(&small).unwrap(), Value::Null);
    let single = json!({ "op": "boolean", "boolean": "intersect", "a": base, "b": tools[0], "many": 2 });
    assert!(evaluator.evaluate(&single).unwrap().is_some());
    assert_eq!(evaluator.boolean_report(&base).unwrap(), Value::Null);
}

#[test]
fn a_deadline_stops_the_boolean_with_krn_timeout_and_the_next_request_still_builds() {
    let _serial = crate::serial_blends();
    let mut evaluator = Evaluator::new(256);
    let (base, tools) = (plate(8, 8), drills(8, 8));
    let many = node("subtract", &base, &tools, true);
    // the plain two-operand boolean honours it too
    let two = json!({ "op": "boolean", "boolean": "subtract", "a": base, "b": tools[0] });
    for recipe in [&many, &two] {
        crate::set_deadline_ms(0.001);
        let error = evaluator.evaluate(recipe).err();
        crate::clear_deadline();
        match error {
            Some(crate::recipe::EvalError::Failure(text)) => {
                assert!(text.starts_with(TIMEOUT) && text.contains("stage=") && text.contains("fraction="), "{text}")
            }
            other => panic!("expected KRN_TIMEOUT, got {other:?}"),
        }
    }
    // not cached as a refusal: the same recipes build once the deadline is gone
    assert!(evaluator.evaluate(&many).unwrap().is_some());
    assert!(evaluator.evaluate(&two).unwrap().is_some());
}

#[test]
fn a_hostile_many_count_evaluates_as_the_plain_tree_without_allocating() {
    let _serial = crate::serial_blends();
    let mut evaluator = Evaluator::new(64);
    let (base, tools) = (plate(2, 2), drills(2, 2));
    let tree = measure(&mut evaluator, &node("subtract", &base, &tools, false));
    for many in [json!(u64::MAX), json!(1_000_000_000_000_000u64), json!(1001), json!(0), json!(-1), json!(1.0e300), json!("4")] {
        let mut hostile = node("subtract", &base, &tools, true);
        hostile["many"] = many.clone();
        assert_same(measure(&mut evaluator, &hostile), tree);
        assert_eq!(evaluator.boolean_report(&hostile).unwrap(), Value::Null, "many {many}");
    }
}

#[test]
fn a_reversed_tool_never_reaches_a_wrong_result_the_inverted_check_catches_it() {
    let _serial = crate::serial_blends();
    let mut evaluator = Evaluator::new(64);
    let base = solid("box", json!({ "size": [3, 2, 2], "position": [0, 0, 0] }));
    let mirrored = |x: f64| {
        let tool = solid("box", json!({ "size": [3, 2, 2], "position": [x, 0, 0] }));
        json!({ "op": "gtransform", "source": tool, "matrix": [-1, 0, 0, 0, 1, 0, 0, 0, 1], "translation": [0, 0, 0] })
    };
    let tools = [mirrored(-2.0), mirrored(-4.0)];
    let tree = measure(&mut evaluator, &node("union", &base, &tools, false));
    let many = node("union", &base, &tools, true);
    let got = measure(&mut evaluator, &many);
    assert_same(got, tree);
    let report = evaluator.boolean_report(&many).unwrap();
    assert!(report["mode"] == "general-fuse" || report["code"] == "KRN_FUSE_FALLBACK", "{report}");
}

#[test]
fn an_index_bearing_node_over_a_many_node_reads_the_tree_edge_order() {
    let _serial = crate::serial_blends();
    let mut evaluator = Evaluator::new(256);
    let rotated: Vec<Value> = (0..12)
        .map(|k| solid("box", json!({ "size": [3, 2, 2], "position": [2.0 * k as f64, 0.0, 0], "rotation": [0, 0, 0.1 * (k % 3) as f64] })))
        .collect();
    let base = solid("box", json!({ "size": [3, 2, 2], "position": [-2, 0, 0] }));
    let (many, tree) = (node("union", &base, &rotated, true), node("union", &base, &rotated, false));
    let many_order = edge_order(&mut evaluator, &many);
    let tree_order = edge_order(&mut evaluator, &tree);
    assert_eq!(many_order.len(), tree_order.len(), "edge count");
    // the General Fuse may order the edges differently (it does on rotated overlapping boxes), which is why indexed nodes bypass it
    let fillet = |source: &Value| json!({ "op": "fillet", "source": source, "edges": [22], "size": 0.05 });
    let rounded = measure(&mut evaluator, &fillet(&many));
    assert_same(rounded, measure(&mut evaluator, &fillet(&tree)));
    assert_eq!(evaluator.boolean_report(&many).unwrap()["mode"], "general-fuse");
    assert_eq!(edge_order(&mut evaluator, &fillet(&many)), edge_order(&mut evaluator, &fillet(&tree)), "edge order after the node");
}

#[test]
fn a_cancel_stops_only_the_request_it_names() {
    let _serial = crate::serial_blends();
    let mut evaluator = Evaluator::new(256);
    let (base, tools) = (plate(8, 8), drills(8, 8));
    let many = node("subtract", &base, &tools, true);
    crate::set_request_id(5);
    crate::request_cancel(6);
    // another request's cancel is ignored: the boolean builds
    let small = node("subtract", &plate(2, 2), &drills(2, 2), true);
    assert!(evaluator.evaluate(&small).unwrap().is_some());
    crate::request_cancel(5);
    let error = evaluator.evaluate(&many).err();
    crate::clear_deadline();
    match error {
        Some(crate::recipe::EvalError::Failure(text)) => assert!(text.starts_with(TIMEOUT), "{text}"),
        other => panic!("expected KRN_TIMEOUT, got {other:?}"),
    }
    // the finished request took its cancel with it
    crate::set_request_id(5);
    assert!(evaluator.evaluate(&many).unwrap().is_some());
    crate::clear_deadline();
}

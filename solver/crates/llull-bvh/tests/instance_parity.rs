//! VC-VIS-60 native side: the instance BVH reproduces the TypeScript tree (`packages/core/src/geometry/instanceBvh.ts`) array for array
//! and every query result, on the seeded sets of `tests/fixtures/instance_bvh.json` (written by `tests/unit/native/nativeReference.test.ts`).

use llull_bvh::instance::{box_inside_planes, box_overlaps_box, ray_hits_box, InstanceBvh, Plane};
use serde_json::Value;

fn fixture() -> Vec<Value> {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/instance_bvh.json")).unwrap();
    serde_json::from_str::<Value>(&text).unwrap().as_array().unwrap().clone()
}

fn floats(value: &Value) -> Vec<f64> {
    value.as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect()
}

fn ints<T: TryFrom<i64>>(value: &Value) -> Vec<T> {
    value.as_array().unwrap().iter().map(|v| T::try_from(v.as_i64().unwrap()).ok().unwrap()).collect()
}

fn vec3(value: &Value) -> [f64; 3] {
    floats(value).try_into().unwrap()
}

fn indices(value: &Value) -> Vec<u32> {
    ints(value)
}

#[test]
fn tree_arrays_equal_the_typescript_build() {
    for case in fixture() {
        let name = case["name"].as_str().unwrap();
        let bvh = InstanceBvh::build(&floats(&case["boxes"]));
        assert_eq!(bvh.order, indices(&case["order"]), "{name}: order");
        assert_eq!(bvh.node_start, indices(&case["nodeStart"]), "{name}: nodeStart");
        assert_eq!(bvh.node_end, indices(&case["nodeEnd"]), "{name}: nodeEnd");
        assert_eq!(bvh.node_child, ints::<i32>(&case["nodeChild"]), "{name}: nodeChild");
        assert_eq!(bvh.node_box, floats(&case["nodeBox"]), "{name}: nodeBox");
    }
}

#[test]
fn query_results_equal_typescript_and_brute_force() {
    for case in fixture() {
        let name = case["name"].as_str().unwrap();
        let boxes = floats(&case["boxes"]);
        let bvh = InstanceBvh::build(&boxes);
        let count = boxes.len() / 6;
        let brute = |hit: &dyn Fn(usize) -> bool| -> Vec<u32> { (0..count).filter(|&i| hit(i * 6)).map(|i| i as u32).collect() };
        for query in case["frustum"].as_array().unwrap() {
            let planes: Vec<Plane> = query["planes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| Plane { normal: vec3(&p["normal"]), offset: p["offset"].as_f64().unwrap() })
                .collect();
            let found = bvh.frustum_query(&planes);
            assert_eq!(found, indices(&query["result"]), "{name}: frustum vs TS");
            assert_eq!(found, brute(&|o| box_inside_planes(&boxes, o, &planes)), "{name}: frustum vs brute force");
        }
        for query in case["rays"].as_array().unwrap() {
            let (origin, direction) = (vec3(&query["origin"]), vec3(&query["direction"]));
            let found = bvh.ray_query(&origin, &direction);
            assert_eq!(found, indices(&query["result"]), "{name}: ray vs TS");
            if direction.iter().any(|&d| d != 0.0) {
                assert_eq!(found, brute(&|o| ray_hits_box(&boxes, o, &origin, &direction)), "{name}: ray vs brute force");
            }
        }
        for query in case["boxQueries"].as_array().unwrap() {
            let (min, max) = (vec3(&query["min"]), vec3(&query["max"]));
            let found = bvh.box_query(&min, &max);
            assert_eq!(found, indices(&query["result"]), "{name}: box vs TS");
            assert_eq!(found, brute(&|o| box_overlaps_box(&boxes, o, &min, &max)), "{name}: box vs brute force");
        }
    }
}

#[test]
fn degenerate_inputs() {
    let empty = InstanceBvh::build(&[]);
    assert_eq!(empty.count, 0);
    assert!(empty.box_query(&[-1.0; 3], &[1.0; 3]).is_empty());
    let one = InstanceBvh::build(&[0.0, 0.0, 0.0, 1.0, 1.0, 1.0]);
    assert_eq!(one.node_child, vec![-1]);
    assert!(one.ray_query(&[0.5; 3], &[0.0; 3]).is_empty(), "zero direction");
    assert!(one.ray_query(&[0.5; 3], &[f64::NAN, 0.0, 0.0]).is_empty(), "non-finite direction");
    assert_eq!(one.ray_query(&[-1.0, 0.5, 0.5], &[1.0, 0.0, 0.0]), vec![0]);
    assert!(one.ray_query(&[2.0, 0.5, 0.5], &[1.0, 0.0, 0.0]).is_empty(), "behind the origin");
}

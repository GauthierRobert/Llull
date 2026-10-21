//! Bit-exact agreement with the TypeScript engine on the cases `tests/unit/native/geomqReference.test.ts` writes (VC-FPR-37 and VC-THM-64 at
//! crate level): placed mesh distances with witness points, ray hits, the obstructed cavity's exchange matrix, and V8 `Math.atan`.
//! Numbers are compared with `==` (exact, except that JSON drops the sign of -0).

use llull_geomq::tree::{min_distance, ray_cast, MeshTree, Placement};
use llull_geomq::{distance_batch, ray_batch, view_factor_batch};
use serde_json::Value;

fn fixture() -> Value {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/geomq.json")).unwrap();
    serde_json::from_str(&text).unwrap()
}

fn numbers(value: &Value) -> Vec<f64> {
    value.as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect()
}

fn vec3(value: &Value) -> [f64; 3] {
    let v = numbers(value);
    [v[0], v[1], v[2]]
}

fn bound(value: &Value) -> f64 {
    value.as_f64().unwrap_or(f64::INFINITY)
}

fn placement(value: &Value) -> Option<Placement> {
    if value.is_null() {
        return None;
    }
    let mut rotation = [0.0; 9];
    rotation.copy_from_slice(&numbers(&value["rotation"]));
    Some(Placement { rotation, translation: vec3(&value["translation"]) })
}

#[test]
fn placed_distances_match_meshbvh_bit_for_bit() {
    let all = fixture();
    let case = &all["distance"];
    let meshes: Vec<Vec<f64>> = case["meshes"].as_array().unwrap().iter().map(numbers).collect();
    let trees: Vec<MeshTree> = meshes.iter().cloned().map(MeshTree::build).collect();
    let queries = case["queries"].as_array().unwrap();
    let results = case["results"].as_array().unwrap();
    assert_eq!(queries.len(), results.len());
    let mut flat = Vec::new();
    for (k, (query, expected)) in queries.iter().zip(results).enumerate() {
        let (a, b) = (query["a"].as_u64().unwrap() as usize, query["b"].as_u64().unwrap() as usize);
        let placed = placement(&query["placement"]);
        let hit = min_distance(&trees[a], &trees[b], bound(&query["maxDistance"]), placed.as_ref());
        match (hit, expected.is_null()) {
            (None, true) => {}
            (Some(hit), false) => {
                assert_eq!(hit.distance, expected["distance"].as_f64().unwrap(), "query {k} distance");
                assert_eq!(hit.point_a, vec3(&expected["pointA"]), "query {k} pointA");
                assert_eq!(hit.point_b, vec3(&expected["pointB"]), "query {k} pointB");
            }
            (hit, _) => panic!("query {k}: native {hit:?}, TS {expected}"),
        }
        let p = placed.unwrap_or(Placement { rotation: [0.0; 9], translation: [0.0; 3] });
        flat.extend([a as f64, b as f64, if placed.is_some() { 1.0 } else { 0.0 }]);
        flat.extend(p.rotation);
        flat.extend(p.translation);
        flat.push(bound(&query["maxDistance"]));
    }
    // the job entry point gives the same rows (7 per query, NaN = none)
    let rows = distance_batch(meshes, &flat).unwrap();
    for (k, expected) in results.iter().enumerate() {
        let distance = rows[k * 7];
        if expected.is_null() {
            assert!(distance.is_nan(), "query {k}");
        } else {
            assert_eq!(distance, expected["distance"].as_f64().unwrap(), "query {k}");
        }
    }
}

#[test]
fn rays_match_meshbvh_bit_for_bit() {
    let all = fixture();
    let case = &all["ray"];
    let tree = MeshTree::build(numbers(&case["mesh"]));
    let rays = case["rays"].as_array().unwrap();
    let results = case["results"].as_array().unwrap();
    let mut flat = Vec::new();
    for (k, (ray, expected)) in rays.iter().zip(results).enumerate() {
        let (origin, direction) = (vec3(&ray["origin"]), vec3(&ray["direction"]));
        let (t_min, max_t) = (ray["tMin"].as_f64().unwrap(), bound(&ray["maxT"]));
        let hit = ray_cast(&tree, &origin, &direction, max_t, t_min);
        match (hit, expected.is_null()) {
            (None, true) => {}
            (Some(hit), false) => {
                assert_eq!(hit.t, expected["t"].as_f64().unwrap(), "ray {k} t");
                assert_eq!(hit.triangle as u64, expected["triangle"].as_u64().unwrap(), "ray {k} triangle");
                assert_eq!(hit.point, vec3(&expected["point"]), "ray {k} point");
            }
            (hit, _) => panic!("ray {k}: native {hit:?}, TS {expected}"),
        }
        flat.extend(origin);
        flat.extend(direction);
        flat.extend([t_min, max_t]);
    }
    let rows = ray_batch(numbers(&case["mesh"]), &flat).unwrap();
    assert_eq!(rows.len(), rays.len() * 5);
    assert_eq!(rows.iter().step_by(5).filter(|t| t.is_nan()).count(), results.iter().filter(|r| r.is_null()).count());
}

#[test]
fn view_factor_exchange_matches_the_reference_bit_for_bit() {
    let all = fixture();
    let case = &all["viewFactor"];
    let surfaces = case["surfaces"].as_u64().unwrap() as usize;
    let facets: Vec<f64> = case["facets"].as_array().unwrap().iter().flat_map(numbers).collect();
    for (key, obstruction) in [("open", false), ("obstructed", true)] {
        let exchange = view_factor_batch(&facets, surfaces, obstruction).unwrap();
        let expected: Vec<f64> = case[key].as_array().unwrap().iter().flat_map(numbers).collect();
        assert_eq!(exchange, expected, "{key}");
    }
}

#[test]
fn atan_matches_v8_bit_for_bit() {
    let all = fixture();
    let rows = all["atan"].as_array().unwrap();
    assert!(rows.len() > 1000);
    for row in rows {
        let [x, y] = [row[0].as_f64().unwrap(), row[1].as_f64().unwrap()];
        assert_eq!(llull_jsmath::atan(x), y, "atan({x})");
    }
}

#[test]
fn bad_inputs_are_named_refusals() {
    assert_eq!(distance_batch(vec![vec![0.0; 9]], &[0.0; 15]).unwrap_err().code, "NATIVE_JOB_INPUT");
    let out_of_range = [[0.0, 3.0, 0.0].as_slice(), &[0.0; 13]].concat();
    assert!(distance_batch(vec![vec![0.0; 9]], &out_of_range).unwrap_err().message.contains("out of range"));
    assert_eq!(ray_batch(vec![], &[0.0; 7]).unwrap_err().code, "NATIVE_JOB_INPUT");
    let blocker_first = [[-1.0].as_slice(), &[0.0; 16], &[0.0], &[0.0; 16]].concat();
    assert!(view_factor_batch(&blocker_first, 1, true).unwrap_err().message.contains("before the blockers"));
    assert!(llull_geomq::parse_meshes(&[2.0, 1.0]).is_err());
    assert!(llull_geomq::parse_meshes(&[1.0, 1e30]).is_err());
    let nan_mesh = [[1.0, 1.0].as_slice(), &[f64::NAN], &[0.0; 8]].concat();
    assert!(llull_geomq::parse_meshes(&nan_mesh).unwrap_err().message.contains("non-finite"));
    assert!(view_factor_batch(&[[0.0].as_slice(), &[f64::INFINITY; 16]].concat(), 1, false).is_err());
}

#[test]
fn atan_saturates_like_v8() {
    let half_pi = std::f64::consts::FRAC_PI_2;
    assert_eq!(llull_jsmath::atan(f64::INFINITY), half_pi);
    assert_eq!(llull_jsmath::atan(f64::NEG_INFINITY), -half_pi);
    assert!(llull_jsmath::atan(f64::NAN).is_nan());
}

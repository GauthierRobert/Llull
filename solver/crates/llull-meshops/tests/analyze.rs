//! Mesh analysis (twin of `analyzeIndexedMesh`): known solids with closed-form answers, the topology of damaged meshes, the job contract, no panic on
//! hostile input and the same answer on any thread count. Bit-identity with the TypeScript engine is proven by `server/tests/meshopsNative.test.ts`
//! and pinned by `ts_pins.rs`.

mod common;

use common::*;
use llull_meshops::analyze::analyze;
use llull_meshops::run;
use serde_json::{json, Value};

fn analysed(mesh: &Mesh, max_listed: usize) -> Value {
    serde_json::to_value(analyze(&mesh.0, &mesh.1, max_listed, None)).unwrap()
}

fn octahedron() -> Mesh {
    (
        vec![1.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, -1.0],
        vec![0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5],
    )
}

#[test]
fn an_octahedron_is_a_closed_sphere_of_volume_four_thirds() {
    let a = analysed(&octahedron(), 20);
    assert_eq!((a["vertices"].clone(), a["edges"].clone(), a["faces"].clone()), (json!(6), json!(12), json!(8)));
    assert_eq!((a["eulerCharacteristic"].clone(), a["genus"].clone()), (json!(2), json!(0)));
    assert_eq!((a["closed"].clone(), a["manifold"].clone(), a["orientationConsistent"].clone()), (json!(true), json!(true), json!(true)));
    assert!((a["volume"].as_f64().unwrap() - 4.0 / 3.0).abs() < 1e-12);
    assert!((a["area"].as_f64().unwrap() - 8.0 * 3f64.sqrt() / 2.0).abs() < 1e-12);
    assert_eq!(a["shellCount"], json!(1));
    assert_eq!(a["selfIntersectionPairs"], Value::Null);
    assert!(a["centroid"].as_array().unwrap().iter().all(|c| c.as_f64().unwrap().abs() < 1e-15));
}

#[test]
fn a_grid_with_holes_has_one_boundary_loop_per_hole_plus_the_rim_and_lists_stay_capped() {
    let surface = grid(12, |_, _| 0.0, &[(3, 3), (8, 8)]);
    let a = analysed(&surface, 2);
    assert_eq!((a["closed"].clone(), a["boundaryLoopCount"].clone()), (json!(false), json!(3)));
    assert_eq!(a["boundaryLoops"].as_array().unwrap().len(), 2);
    assert_eq!(a["volume"], Value::Null);
    assert!((a["area"].as_f64().unwrap() - (100.0 - 2.0 * (10.0f64 / 12.0).powi(2))).abs() < 1e-9);
    let a = analysed(&surface, 0);
    assert_eq!((a["boundaryLoops"].as_array().unwrap().len(), a["shells"].as_array().unwrap().len()), (0, 0));
    assert_eq!(a["boundaryLoopCount"], json!(3));
}

#[test]
fn damaged_meshes_are_counted_not_refused() {
    // a triangle repeated, a degenerate face, a flipped neighbour and a third page on one edge
    let mesh: Mesh = (
        vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 1.0],
        vec![0, 1, 2, 2, 1, 0, 0, 0, 1, 1, 3, 2, 1, 2, 3, 0, 1, 4],
    );
    let a = analysed(&mesh, 20);
    assert_eq!(a["degenerateFaces"], json!(1));
    assert_eq!(a["duplicateFaces"], json!(2));
    assert_eq!(a["manifold"], json!(false));
    assert!(a["nonManifoldEdgeCount"].as_u64().unwrap() >= 1);
    assert_eq!(a["nonManifoldEdges"][0]["uses"], json!(3));
    assert_eq!(a["closed"], json!(false));
    // two faces that run the shared edge the same way
    let flipped = analysed(&(vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, -1.0, 0.0], vec![0, 1, 2, 0, 1, 3]), 20);
    assert_eq!((flipped["orientationConsistent"].clone(), flipped["manifold"].clone()), (json!(false), json!(true)));
    assert_eq!(flipped["shells"][0]["volume"], Value::Null);
}

#[test]
fn separate_shells_are_numbered_by_their_first_face_and_sum_to_the_whole() {
    let mut mesh = octahedron();
    let other = octahedron();
    mesh.0.extend(other.0.chunks_exact(3).flat_map(|p| [p[0] + 5.0, p[1], p[2]]));
    mesh.1.extend(other.1.iter().map(|v| v + 6));
    let a = analysed(&mesh, 20);
    assert_eq!(a["shellCount"], json!(2));
    let shells = a["shells"].as_array().unwrap();
    assert!(shells.iter().all(|s| s["closed"] == json!(true) && s["genus"] == json!(0) && s["faces"] == json!(8)));
    assert!((a["volume"].as_f64().unwrap() - 8.0 / 3.0).abs() < 1e-12);
    assert_eq!(a["genus"], json!(0));
}

#[test]
fn the_same_input_gives_the_same_analysis_on_any_thread_count() {
    let mesh = sphere(5, 0.1, 9);
    let reference = analysed(&mesh, 20);
    for threads in [1, 3, 8] {
        let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).build().unwrap();
        assert_eq!(pool.install(|| analysed(&mesh, 20)), reference, "{threads} threads");
    }
}

#[test]
fn hostile_soups_do_not_panic() {
    let mut next = stream(31);
    for case in 0..80 {
        let vertices = 3 + (next() * 12.0) as usize;
        let positions: Vec<f64> = (0..vertices * 3).map(|_| (next() * 2.0 - 1.0) * [1e-9, 1.0, 1e99][case % 3]).collect();
        let indices: Vec<u32> = (0..(next() * 60.0) as usize * 3).map(|_| (next() * vertices as f64) as u32).collect();
        let a = analysed(&(positions, indices.clone()), 5);
        assert_eq!(a["faces"], json!(indices.len() / 3));
    }
}

#[test]
fn the_job_welds_exact_duplicates_refuses_what_it_does_not_do_and_reports_its_stages() {
    // the octahedron as a soup of 24 vertices
    let (positions, indices) = octahedron();
    let soup: Mesh = (indices.iter().flat_map(|&v| positions[v as usize * 3..v as usize * 3 + 3].to_vec()).collect(), (0..24).collect());
    let dir = folder("analyze-job");
    write_job(&dir, &json!({ "op": "analyze", "params": { "maxListed": 5, "weldTolerance": 0, "selfIntersections": false } }), &soup);
    let mut out = Vec::new();
    run(&dir, &mut out).unwrap();
    let report: Value = serde_json::from_slice(&std::fs::read(dir.join("report.json")).unwrap()).unwrap();
    assert_eq!(report["report"], json!({ "weldTolerance": 0, "mergedVertices": 18 }));
    assert_eq!(report["analysis"]["vertices"], json!(6));
    assert_eq!(report["analysis"]["closed"], json!(true));
    let stages: Vec<String> = String::from_utf8(out)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str::<Value>(l).unwrap()["stage"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(stages, ["read", "analyze", "write"]);

    for (what, params) in [("a weld tolerance", json!({ "maxListed": 5, "weldTolerance": 0.1 })), ("a missing list length", json!({}))] {
        write_job(&dir, &json!({ "op": "analyze", "params": params }), &soup);
        assert_eq!(run(&dir, &mut std::io::sink()).unwrap_err().code, "NATIVE_JOB_INPUT", "{what}");
    }
    let huge: Mesh = (soup.0.iter().map(|v| v * 1e101).collect(), soup.1.clone());
    write_job(&dir, &json!({ "op": "analyze", "params": { "maxListed": 5 } }), &huge);
    assert!(run(&dir, &mut std::io::sink()).unwrap_err().message.contains("overflow"));
}

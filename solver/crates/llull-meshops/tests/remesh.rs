//! Remeshing guarantees (twin of `remesh.ts`): the band of edge lengths and the topology of the result, the same bytes on every run and thread count,
//! the triangle limit, hostile input that must not panic, and the job contract (parameters, stages). Bit-identity with the TypeScript engine is proven by
//! `server/tests/meshopsNative.test.ts` and pinned by `ts_pins.rs`.

mod common;

use common::*;
use llull_meshops::remesh::{remesh, Adaptive, RemeshParams, RemeshReport, Remeshed};
use llull_meshops::run;
use llull_protocol::sha256_hex;
use serde_json::{json, Value};

fn params(target_edge: f64) -> RemeshParams {
    RemeshParams {
        target_edge: Some(target_edge),
        adaptive: None,
        iterations: 3,
        feature_angle: 40f64.to_radians(),
        feature_cos: 40f64.to_radians().cos(),
        preserve_boundary: true,
        project: true,
        region: None,
        max_triangles: 4_000_000,
    }
}

fn remeshed(mesh: &Mesh, params: &RemeshParams) -> (Mesh, RemeshReport) {
    match remesh(&mesh.0, &mesh.1, params, &mut |_| {}) {
        Remeshed::Done(positions, indices, report) => ((positions, indices), report),
        Remeshed::TooLarge(count) => panic!("too large: {count}"),
    }
}

fn digest(mesh: &Mesh) -> String {
    sha256_hex(&bytes(&mesh.0, &mesh.1))
}

fn volume(mesh: &Mesh) -> f64 {
    mesh.1
        .chunks_exact(3)
        .map(|t| {
            let (n, a) = (normal(&mesh.0, t), point(&mesh.0, t[0]));
            (n[0] * a[0] + n[1] * a[1] + n[2] * a[2]) / 6.0
        })
        .sum()
}

#[test]
fn a_remeshed_sphere_is_a_closed_manifold_inside_the_edge_band_with_its_volume_kept() {
    let input = sphere(3, 0.0, 1);
    let (result, report) = remeshed(&input, &params(1.0));
    let topology = topology(&result.1);
    assert_eq!((topology.euler(), topology.boundary_edges.len()), (2, 0));
    assert!(report.splits > 0 && report.triangles_after > 1280);
    assert!(
        report.edge_length.max <= 4.0 / 3.0 * (1.0 + 1e-9),
        "the closing passes split every edge above 4/3 L: {}",
        report.edge_length.max
    );
    assert!(report.fraction_in_band > 0.6);
    assert!((volume(&result) / volume(&input) - 1.0).abs() < 0.01);
    for t in result.1.chunks_exact(3) {
        let (n, c) = (normal(&result.0, t), point(&result.0, t[0]));
        assert!(n[0] * c[0] + n[1] * c[1] + n[2] * c[2] > 0.0, "a triangle was turned over");
    }
}

#[test]
fn coarsening_collapses_and_keeps_a_boundary_loop_where_it_was() {
    let holes = [(3, 3)];
    let surface = grid(16, |x, y| 0.4 * (x / 1.5).sin() * (y / 2.0).cos(), &holes);
    let before = topology(&surface.1);
    let (result, report) = remeshed(&surface, &params(2.5));
    assert!(report.collapses > 0 && report.triangles_after < 506);
    let after = topology(&result.1);
    assert_eq!((after.boundary_loops(), after.boundary_edges.len()), (before.boundary_loops(), before.boundary_edges.len()));
}

#[test]
fn the_same_input_gives_the_same_bytes_on_every_run_and_on_any_thread_count() {
    let input = sphere(4, 0.05, 3);
    let reference = remeshed(&input, &params(0.8));
    let expected = (digest(&reference.0), format!("{:?}", reference.1));
    for threads in [1, 2, 7] {
        let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).build().unwrap();
        let again = pool.install(|| remeshed(&input, &params(0.8)));
        assert_eq!((digest(&again.0), format!("{:?}", again.1)), expected, "{threads} threads");
    }
}

#[test]
fn the_triangle_limit_stops_the_splitting_and_reports_the_size_it_reached() {
    let input = sphere(2, 0.0, 1);
    let limited = RemeshParams { max_triangles: 3000, ..params(0.3) };
    match remesh(&input.0, &input.1, &limited, &mut |_| {}) {
        Remeshed::TooLarge(count) => assert!(count > 3000 && count < 40_000, "{count}"),
        Remeshed::Done(..) => panic!("a 0.3 edge on a radius-10 sphere passes 3000 triangles"),
    }
}

#[test]
fn hostile_meshes_do_not_panic_and_never_return_an_index_past_the_vertices() {
    let mut next = stream(77);
    for case in 0..60 {
        let vertices = 4 + (next() * 20.0) as usize;
        let spread = [1e-9, 1.0, 1e3, 1e150][case % 4];
        let positions: Vec<f64> = (0..vertices * 3).map(|_| (next() * 2.0 - 1.0) * spread * if next() < 0.1 { 0.0 } else { 1.0 }).collect();
        let faces = 1 + (next() * 40.0) as usize;
        // repeated corners, duplicate faces and edges shared by many faces
        let indices: Vec<u32> = (0..faces * 3).map(|_| (next() * vertices as f64) as u32).collect();
        let adaptive = case % 3 == 0;
        let hostile = RemeshParams {
            target_edge: (!adaptive).then_some(spread * 0.3),
            adaptive: adaptive.then_some(Adaptive { min_edge: spread * 0.1, max_edge: spread, approx_error: spread * 0.01 }),
            max_triangles: 5000,
            preserve_boundary: case % 2 == 0,
            project: case % 5 != 0,
            ..params(1.0)
        };
        if let Remeshed::Done(out_positions, out_indices, _) = remesh(&positions, &indices, &hostile, &mut |_| {}) {
            assert!(out_indices.iter().all(|&v| (v as usize) < out_positions.len() / 3), "case {case}");
            assert_eq!(out_indices.len() % 3, 0);
        }
    }
    let nothing = remesh(&[0.0, 0.0, 0.0], &[], &params(1.0), &mut |_| {});
    assert!(matches!(nothing, Remeshed::Done(_, ref indices, _) if indices.is_empty()));
}

fn job(extra: Value) -> Value {
    let mut params = json!({ "iterations": 2, "featureAngleRad": 0.7, "preserveBoundary": true, "project": true });
    params.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    json!({ "op": "remesh", "params": params })
}

#[test]
fn the_job_refuses_bad_parameters_with_stable_codes_and_reports_its_stages() {
    let input = sphere(2, 0.0, 1);
    let dir = folder("remesh-bad");
    for (what, extra) in [
        ("no length", json!({})),
        ("an incomplete adaptive triple", json!({ "minEdge": 0.5, "maxEdge": 2.0 })),
        ("a zero edge", json!({ "targetEdge": 0.0 })),
        ("a negative edge", json!({ "targetEdge": -1.0 })),
        ("a feature angle past pi", json!({ "targetEdge": 1.0, "featureAngleRad": 4.0 })),
        ("too many iterations", json!({ "targetEdge": 1.0, "iterations": 1_000_000 })),
        ("a region of the wrong shape", json!({ "targetEdge": 1.0, "region": { "center": [0.0, 0.0], "radius": 1.0 } })),
    ] {
        write_job(&dir, &job(extra), &input);
        let error = run(&dir, &mut std::io::sink()).unwrap_err();
        assert_eq!(error.code, "NATIVE_JOB_INPUT", "{what}: {}", error.message);
    }
    write_job(&dir, &job(json!({ "targetEdge": 0.3, "maxTriangles": 2000 })), &input);
    let error = run(&dir, &mut std::io::sink()).unwrap_err();
    assert_eq!(error.code, "REMESH_TOO_LARGE");
    assert!(error.message.contains("limit 2000"), "{}", error.message);

    write_job(&dir, &job(json!({ "targetEdge": 1.5 })), &input);
    let mut out = Vec::new();
    run(&dir, &mut out).unwrap();
    let events: Vec<Value> = String::from_utf8(out).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    let stages: Vec<&str> = events.iter().filter_map(|e| e["stage"].as_str()).collect();
    assert_eq!((stages.first(), stages.last()), (Some(&"read"), Some(&"write")));
    assert!(stages.contains(&"remesh"), "{stages:?}");
    let fractions: Vec<f64> = events.iter().map(|e| e["fraction"].as_f64().unwrap()).collect();
    assert!(fractions.windows(2).all(|pair| pair[0] <= pair[1]), "{fractions:?}");
    let (result, report) = read_result(&dir);
    assert_eq!(report["report"]["trianglesAfter"], json!(result.1.len() / 3));
    assert_eq!(report["report"]["mode"], json!("isotropic"));
}

#[test]
fn a_job_that_asks_for_the_deviation_measures_it_in_the_same_run() {
    let input = sphere(3, 0.0, 1);
    let dir = folder("remesh-deviation");
    let mut with = job(json!({ "targetEdge": 1.2 }));
    with["deviationSamples"] = json!(2000);
    write_job(&dir, &with, &input);
    let mut out = Vec::new();
    run(&dir, &mut out).unwrap();
    let (_, report) = read_result(&dir);
    assert!(report["deviation"]["hausdorff"].as_f64().unwrap() > 0.0);
    assert!(String::from_utf8(out).unwrap().contains("\"stage\":\"deviation\""));
    write_job(&dir, &job(json!({ "targetEdge": 1.2 })), &input);
    run(&dir, &mut std::io::sink()).unwrap();
    assert!(read_result(&dir).1.get("deviation").is_none());
}

//! Repair and hole filling (twins of `repair.ts` and `holeFill.ts`, DES-7c step 7 slice 2): closed-form results of each mode, the same bytes on every run and thread
//! count, hostile input that must not panic, and the job contract (parameters, refusal codes, stages, the deviation measured in the same job). Bit-identity with the
//! TypeScript engine is proven by `server/tests/meshopsNativeRepair.test.ts` and pinned by `ts_pins.rs`.

mod common;

use common::*;
use llull_meshops::run;
use serde_json::{json, Value};

fn repair_job(mode: &str, extra: Value) -> Value {
    let mut params = json!({ "mode": mode, "weldTolerance": 1e-9, "maxGap": 1e-6, "maxBoundaryEdges": 1000 });
    params.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    json!({ "op": "repair", "params": params })
}

fn fill_job(extra: Value) -> Value {
    let mut params = json!({ "select": "all", "maxBoundaryEdges": 1000, "fairing": "curvature", "refine": true });
    params.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    json!({ "op": "fill_holes", "params": params })
}

/// Run `job` on `mesh` in a fresh folder: the result mesh and the `report` of the job.
fn run_job(name: &str, job: &Value, mesh: &Mesh) -> (Mesh, Value) {
    let dir = folder(name);
    write_job(&dir, job, mesh);
    run(&dir, &mut std::io::sink()).unwrap_or_else(|error| panic!("{name}: {} {}", error.code, error.message));
    let (result, summary) = read_result(&dir);
    (result, summary["report"].clone())
}

fn refusal(name: &str, job: &Value, mesh: &Mesh) -> (String, String) {
    let dir = folder(name);
    write_job(&dir, job, mesh);
    let error = run(&dir, &mut std::io::sink()).unwrap_err();
    (error.code.to_string(), error.message)
}

/// `mesh` without the faces listed.
fn without(mesh: &Mesh, faces: &[usize]) -> Mesh {
    let indices = mesh.1.chunks_exact(3).enumerate().filter(|(f, _)| !faces.contains(f)).flat_map(|(_, t)| t.to_vec()).collect();
    (mesh.0.clone(), indices)
}

/// `meshes` side by side along x, 40 apart.
fn apart(meshes: &[Mesh]) -> Mesh {
    let (mut positions, mut indices) = (Vec::new(), Vec::new());
    for (k, part) in meshes.iter().enumerate() {
        let offset = (positions.len() / 3) as u32;
        positions.extend(part.0.chunks_exact(3).flat_map(|p| [p[0] + 40.0 * k as f64, p[1], p[2]]));
        indices.extend(part.1.iter().map(|v| v + offset));
    }
    (positions, indices)
}

/// A mesh as a soup of three private vertices per face, each moved by up to `jitter`.
fn soup(mesh: &Mesh, jitter: f64, seed: u64) -> Mesh {
    let mut next = stream(seed);
    let positions = mesh.1.iter().flat_map(|&v| point(&mesh.0, v).map(|x| x + (next() * 2.0 - 1.0) * jitter)).collect();
    (positions, (0..mesh.1.len() as u32).collect())
}

fn signed_volume(mesh: &Mesh) -> f64 {
    mesh.1
        .chunks_exact(3)
        .map(|t| {
            let (n, a) = (normal(&mesh.0, t), point(&mesh.0, t[0]));
            (n[0] * a[0] + n[1] * a[1] + n[2] * a[2]) / 6.0
        })
        .sum()
}

#[test]
fn weld_merges_a_soup_within_the_tolerance_and_drops_faces_with_a_repeated_corner() {
    let sphere_mesh = sphere(2, 0.0, 1);
    let mut mesh = soup(&sphere_mesh, 1e-4, 5);
    mesh.1.extend([0, 0, 4]);
    let (result, report) = run_job("weld-soup", &repair_job("weld", json!({ "weldTolerance": 1e-3 })), &mesh);
    assert_eq!((result.0.len() / 3, result.1.len() / 3), (sphere_mesh.0.len() / 3, sphere_mesh.1.len() / 3));
    assert_eq!(report["changes"]["welded"], json!(mesh.0.len() / 3 - sphere_mesh.0.len() / 3));
    assert_eq!(report["changes"]["degenerateRemoved"], json!(1));
    assert_eq!(topology(&result.1).euler(), 2);
    // tolerance 0 merges bit-identical coordinates only
    let exact = soup(&sphere_mesh, 0.0, 5);
    let (result, report) = run_job("weld-exact", &repair_job("weld", json!({ "weldTolerance": 0.0 })), &exact);
    assert_eq!(
        (result.0.len() / 3, report["changes"]["welded"].clone()),
        (sphere_mesh.0.len() / 3, json!(exact.0.len() / 3 - sphere_mesh.0.len() / 3))
    );
}

#[test]
fn clean_removes_degenerate_and_duplicate_faces_in_both_windings_and_keeps_the_first() {
    let base = sphere(2, 0.0, 1);
    let mut mesh = base.clone();
    mesh.1.extend_from_slice(&base.1[30..33]);
    mesh.1.extend(base.1[60..63].iter().rev());
    mesh.1.extend([2, 2, 5]);
    let (result, report) = run_job("clean", &repair_job("clean", json!({})), &mesh);
    assert_eq!(report["changes"]["duplicatesRemoved"], json!(2));
    assert_eq!(report["changes"]["degenerateRemoved"], json!(1));
    assert_eq!(result.1.len(), base.1.len());
}

#[test]
fn orient_turns_an_inside_out_shell_outward_and_a_flipped_patch_back() {
    let base = sphere(3, 0.0, 1);
    let mut inside = base.clone();
    inside.1.chunks_exact_mut(3).for_each(|t| t.swap(1, 2));
    let (result, report) = run_job("orient-inside", &repair_job("orient", json!({})), &inside);
    assert_eq!(report["changes"]["flipped"], json!(base.1.len() / 3));
    assert!(signed_volume(&result) > 0.0);
    let mut patch = base.clone();
    for f in [5, 6, 7, 100] {
        patch.1.swap(f * 3 + 1, f * 3 + 2);
    }
    let (result, report) = run_job("orient-patch", &repair_job("orient", json!({})), &patch);
    assert_eq!(report["changes"]["flipped"], json!(4));
    assert_eq!(topology(&result.1).boundary_edges.len(), 0);
}

#[test]
fn stitch_closes_a_crack_and_close_holes_fills_what_is_left() {
    let patch = grid(8, |_, y| 0.3 * y.cos(), &[]);
    let mut cracked = apart(&[patch.clone(), patch]);
    cracked.0.chunks_exact_mut(3).skip(81).for_each(|p| p[0] -= 40.0 - 10.001);
    let (result, report) = run_job("stitch", &repair_job("stitch", json!({ "maxGap": 0.002 })), &cracked);
    assert_eq!(report["changes"]["stitched"], json!(9));
    assert_eq!(topology(&result.1).boundary_loops(), 1);
    // a gap narrower than the crack merges nothing
    let (_, report) = run_job("stitch-narrow", &repair_job("stitch", json!({ "maxGap": 0.0005 })), &cracked);
    assert_eq!(report["changes"]["stitched"], json!(0));
    // close_holes fills the rim of an open patch and the holes left in it
    let holed = grid(12, |_, _| 0.0, &[(3, 3), (8, 8)]);
    let (result, report) = run_job("close-holes", &repair_job("close_holes", json!({})), &holed);
    assert_eq!(report["changes"]["holesFilled"], json!(3));
    assert_eq!(topology(&result.1).boundary_edges.len(), 0);
    let (_, report) = run_job("close-holes-capped", &repair_job("close_holes", json!({ "maxBoundaryEdges": 3 })), &holed);
    assert_eq!((report["changes"]["holesFilled"].clone(), report["skippedHoles"].clone()), (json!(0), json!(3)));
}

/// Two triangles whose corners p0 and q0 are 0.001 apart in the grid cells 2^31 - 1 and 2^31 (cells of the size of the gap): a cell index narrowed to 32 bits wraps
/// there and the pair is never compared.
fn across_the_cell_wrap() -> Mesh {
    let (x1, x2) = (4_294_967.295_5, 4_294_967.296_5);
    (
        vec![x1, 0.0, 0.0, x1 - 5.0, 0.0, 0.0, x1 - 5.0, 5.0, 0.0, x2, 0.0, 0.0, x2 + 5.0, 0.0, 0.0, x2 + 5.0, 5.0, 0.0],
        vec![0, 1, 2, 3, 4, 5],
    )
}

/// The corner 2 is 0.001 from the corner 1: merging them would put a third face on the edge 0-1.
fn pinch() -> Mesh {
    (vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.001, 0.0, 0.5, 1.0, 0.0, 0.5, -1.0, 0.0, 0.5, 0.5, 1.0], vec![0, 1, 3, 1, 0, 4, 0, 2, 5])
}

#[test]
fn a_stitch_that_would_make_the_surface_worse_is_reverted_and_says_so() {
    let (result, report) = run_job("stitch-pinch", &repair_job("stitch", json!({ "maxGap": 0.01, "weldTolerance": 0.0 })), &pinch());
    assert_eq!(report["changes"]["stitched"], json!(0));
    assert_eq!(report["notes"].as_array().unwrap().len(), 1);
    assert!(report["notes"][0].as_str().unwrap().starts_with("stitch reverted"));
    assert_eq!((result.0.len() / 3, result.1.len() / 3), (6, 3));
}

#[test]
fn stitch_compares_corners_in_grid_cells_whose_index_does_not_fit_32_bits() {
    let (result, report) =
        run_job("stitch-wrap", &repair_job("stitch", json!({ "maxGap": 0.002, "weldTolerance": 0.0 })), &across_the_cell_wrap());
    assert_eq!(report["changes"]["stitched"], json!(1));
    assert_eq!(result.0.len() / 3, 5);
    // a gap of 1e-300 puts the corners in cells of index about 1e306 (a double: no wrap, no overflow); no pair is within it
    let (_, report) =
        run_job("stitch-huge-cells", &repair_job("stitch", json!({ "maxGap": 1e-300, "weldTolerance": 0.0 })), &across_the_cell_wrap());
    assert_eq!(report["changes"]["stitched"], json!(0));
}

#[test]
fn small_shells_go_by_face_count_or_volume_and_the_largest_always_stays() {
    let tiny = sphere(1, 0.0, 1);
    let tiny: Mesh = (tiny.0.iter().map(|v| v * 0.1).collect(), tiny.1);
    let shells = apart(&[sphere(3, 0.0, 1), tiny, grid(3, |_, _| 0.0, &[])]);
    let (_, report) = run_job("small-faces", &repair_job("clean", json!({ "smallComponents": { "maxFaces": 100 } })), &shells);
    assert_eq!(
        (report["changes"]["componentsRemoved"].clone(), report["changes"]["facesRemovedWithComponents"].clone()),
        (json!(2), json!(98))
    );
    // by volume: the open grid has none, so only the closed shell of radius 1 (volume about 3.5) goes
    let (_, report) = run_job("small-volume", &repair_job("clean", json!({ "smallComponents": { "maxVolume": 100.0 } })), &shells);
    assert_eq!(report["changes"]["componentsRemoved"], json!(1));
    // every shell small: the largest is kept
    let (result, report) = run_job("small-all", &repair_job("clean", json!({ "smallComponents": { "maxFaces": 100000 } })), &shells);
    assert_eq!(report["changes"]["componentsRemoved"], json!(2));
    assert_eq!(result.1.len() / 3, 1280);
}

#[test]
fn every_mode_and_fill_give_the_same_bytes_on_every_run_and_any_thread_count() {
    let holey = without(&sphere(4, 0.02, 3), &[10, 11, 12, 13, 14, 15, 400, 401, 402, 900, 901]);
    let jobs = [
        repair_job("weld", json!({ "weldTolerance": 1e-5 })),
        repair_job("clean", json!({})),
        repair_job("orient", json!({})),
        repair_job("stitch", json!({ "maxGap": 0.01 })),
        repair_job("close_holes", json!({ "smallComponents": { "maxFaces": 3 } })),
        fill_job(json!({ "alpha": 2.0 })),
        fill_job(json!({ "fairing": "tangent", "select": { "near": [[0.0, 0.0, 10.0]] } })),
    ];
    for (k, job) in jobs.iter().enumerate() {
        let reference = run_job(&format!("det-{k}"), job, &holey);
        let expected = (bytes(&reference.0 .0, &reference.0 .1), reference.1.to_string());
        for threads in [1, 2, 7] {
            let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).build().unwrap();
            let again = pool.install(|| run_job(&format!("det-{k}-{threads}"), job, &holey));
            assert_eq!((bytes(&again.0 .0, &again.0 .1), again.1.to_string()), expected, "job {k}, {threads} threads");
        }
    }
}

#[test]
fn fill_closes_the_selected_loops_with_the_patch_the_report_describes() {
    let holey = without(&sphere(3, 0.0, 1), &[10, 11, 12, 13, 14, 15, 400, 401, 402, 403]);
    let (result, report) = run_job("fill-all", &fill_job(json!({})), &holey);
    assert_eq!(report["totalLoops"], json!(2));
    let filled = report["filled"].as_array().unwrap();
    assert_eq!(filled.len(), 2);
    let patch: u64 = filled.iter().map(|h| h["triangles"].as_u64().unwrap()).sum();
    assert_eq!(result.1.len() as u64 / 3, holey.1.len() as u64 / 3 + patch);
    assert_eq!((topology(&result.1).boundary_edges.len(), topology(&result.1).euler()), (0, 2));
    assert!(filled.iter().all(|h| h["triangulation"] == "dp" && h["fairing"] == "curvature" && h["area"].as_f64().unwrap() > 0.0));
    // the patch only appends: the input's faces come first, over the same vertices (the vertices are renumbered by first use, so compare the points)
    let corners = |mesh: &Mesh, face: usize| (0..3).map(|k| point(&mesh.0, mesh.1[face * 3 + k])).collect::<Vec<_>>();
    assert!((0..holey.1.len() / 3).all(|f| corners(&result, f) == corners(&holey, f)));
    // chosen loops: only loop 1, listed twice
    let (_, report) = run_job("fill-one", &fill_job(json!({ "select": [1, 1] })), &holey);
    assert_eq!(report["filled"].as_array().unwrap().len(), 1);
    assert_eq!(report["filled"][0]["loop"], json!(1));
    // a point near the second hole, and the plain triangulation
    let (_, report) =
        run_job("fill-near", &fill_job(json!({ "fairing": "none", "select": { "near": [point(&holey.0, holey.1[400 * 3])] } })), &holey);
    assert_eq!((report["filled"].as_array().unwrap().len(), report["filled"][0]["fairing"].clone()), (1, json!("none")));
}

#[test]
fn a_loop_above_the_dynamic_program_limit_is_clipped_greedily_and_fairing_inserts_vertices_for_a_big_hole() {
    let holes: Vec<(usize, usize)> = (30..70).flat_map(|i| (30..70).map(move |j| (i, j))).collect();
    let mesh = grid(100, |x, y| 0.1 * x.sin() * y.cos(), &holes);
    let (_, report) = run_job("fill-greedy", &fill_job(json!({ "select": [1] })), &mesh);
    assert_eq!((report["filled"][0]["edges"].clone(), report["filled"][0]["triangulation"].clone()), (json!(160), json!("greedy")));
    let wide = grid(30, |x, y| 0.2 * (x * y).sin(), &(8..22).flat_map(|i| (8..22).map(move |j| (i, j))).collect::<Vec<_>>());
    let (result, report) = run_job("fill-wide", &fill_job(json!({ "select": [1], "alpha": 2.0 })), &wide);
    assert!(report["filled"][0]["addedVertices"].as_u64().unwrap() > 0);
    assert_eq!(report["filled"][0]["triangulation"], json!("dp"));
    assert!(result.0.len() > wide.0.len());
}

#[test]
fn loops_that_cannot_be_filled_are_skipped_for_all_and_refused_by_name_when_chosen() {
    let wide = grid(30, |_, _| 0.0, &(5..25).flat_map(|i| (5..25).map(move |j| (i, j))).collect::<Vec<_>>());
    let (_, report) = run_job("skip-large", &fill_job(json!({ "maxBoundaryEdges": 10 })), &wide);
    assert_eq!(report["skipped"].as_array().unwrap().len(), 2);
    assert_eq!(report["skipped"][0]["code"], json!("MESH_HOLE_TOO_LARGE"));
    let (code, message) = refusal("refuse-large", &fill_job(json!({ "maxBoundaryEdges": 10, "select": [0, 1] })), &wide);
    assert_eq!(
        (code.as_str(), message.as_str()),
        ("MESH_HOLE_TOO_LARGE", "boundary loop 0 (120 edges) cannot be filled: MESH_HOLE_TOO_LARGE")
    );
    // two squares touching at the corner 0: the boundary chain runs through it twice, one loop of 8 edges
    let touching: Mesh = (
        vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, -1.0, 0.0, -1.0, -1.0, 0.0, -1.0, 0.0, 0.0],
        vec![0, 1, 2, 0, 2, 3, 0, 5, 4, 0, 6, 5],
    );
    let (_, report) = run_job("skip-simple", &fill_job(json!({})), &touching);
    assert_eq!(report["skipped"], json!([{ "loop": 0, "edges": 8, "code": "MESH_HOLE_NON_SIMPLE" }]));
    assert_eq!(refusal("refuse-simple", &fill_job(json!({ "select": [0] })), &touching).0, "MESH_HOLE_NON_SIMPLE");
    // numbers and points that name no loop
    assert_eq!(
        refusal("refuse-number", &fill_job(json!({ "select": [7] })), &wide),
        ("MESH_HOLE_NOT_FOUND".to_string(), "boundary loop 7 does not exist (the mesh has 2)".to_string())
    );
    let closed = sphere(1, 0.0, 1);
    assert_eq!(
        refusal("refuse-near", &fill_job(json!({ "select": { "near": [[0.0, 0.0, 0.0], [1.0, 2.0, 3.0]] } })), &closed).0,
        "HOLE_NEAR_NOT_FOUND"
    );
    assert_eq!(refusal("refuse-near", &fill_job(json!({ "select": { "near": [[0.0, 0.0, 0.0], [1.0, 2.0, 3.0]] } })), &closed).1, "0");
    // a closed mesh with all loops: nothing to do
    let (result, report) = run_job("fill-closed", &fill_job(json!({})), &closed);
    assert_eq!((report["totalLoops"].clone(), result.1.len()), (json!(0), closed.1.len()));
}

#[test]
fn the_jobs_refuse_bad_parameters_with_stable_codes() {
    let mesh = sphere(1, 0.0, 1);
    for (what, job) in [
        ("an unknown mode", repair_job("wrap", json!({}))),
        ("a negative tolerance", repair_job("weld", json!({ "weldTolerance": -1.0 }))),
        ("a negative gap", repair_job("stitch", json!({ "maxGap": -1.0 }))),
        ("a missing mode", json!({ "op": "repair", "params": { "weldTolerance": 0.0, "maxGap": 0.0, "maxBoundaryEdges": 10 } })),
        ("a fractional loop number", fill_job(json!({ "select": [1.5] }))),
        ("a negative loop number", fill_job(json!({ "select": [-1] }))),
        ("an unknown selection word", fill_job(json!({ "select": "some" }))),
        ("a point of two coordinates", fill_job(json!({ "select": { "near": [[1.0, 2.0]] } }))),
        ("an unknown fairing", fill_job(json!({ "fairing": "smooth" }))),
    ] {
        assert_eq!(refusal("bad", &job, &mesh).0, "NATIVE_JOB_INPUT", "{what}");
    }
    // far coordinates are answered while the patch areas stay finite; through the overflow band every answer stays finite (loops the
    // triangulation cannot weigh are skipped by code) or the job refuses by name: an infinite area never reaches the report
    let holey = without(&sphere(2, 0.0, 1), &[3, 4, 5]);
    let scaled = |factor: f64| -> Mesh { (holey.0.iter().map(|v| v * factor).collect(), holey.1.clone()) };
    let (_, report) = run_job("far", &fill_job(json!({})), &scaled(1e101));
    assert!(!report["filled"].as_array().unwrap().is_empty());
    for (k, factor) in [1e150, 1e152, 1e153, 1e154, 1e155, 1e160].into_iter().enumerate() {
        let dir = folder(&format!("huge-{k}"));
        write_job(&dir, &fill_job(json!({})), &scaled(factor));
        match run(&dir, &mut std::io::sink()) {
            Ok(_) => {
                let (_, summary) = read_result(&dir);
                let patches = summary["report"]["filled"].as_array().unwrap().clone();
                assert!(patches.iter().all(|patch| patch["area"].as_f64().is_some_and(f64::is_finite)), "{factor:e}");
            }
            Err(error) => assert!(error.code == "NATIVE_JOB_INPUT" && error.message.contains("overflows"), "{factor:e}: {}", error.message),
        }
    }
}

#[test]
fn repair_and_fill_report_their_stage_with_rising_fractions_and_measure_their_own_deviation() {
    let holey = without(&sphere(3, 0.0, 1), &[10, 11, 12, 13, 14, 15]);
    for (name, job, stage) in [("repair", repair_job("close_holes", json!({})), "repair"), ("fill", fill_job(json!({})), "fill_holes")] {
        let dir = folder(&format!("stages-{name}"));
        let mut with = job.clone();
        with["deviationSamples"] = json!(1000);
        write_job(&dir, &with, &holey);
        let mut out = Vec::new();
        run(&dir, &mut out).unwrap();
        let events: Vec<Value> = String::from_utf8(out).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        let mut stages: Vec<&str> = events.iter().filter_map(|e| e["stage"].as_str()).collect();
        stages.dedup();
        assert_eq!(stages, ["read", stage, "deviation", "write"], "{name}");
        let fractions: Vec<f64> = events.iter().map(|e| e["fraction"].as_f64().unwrap()).collect();
        assert!(fractions.windows(2).all(|pair| pair[0] <= pair[1]), "{name}: {fractions:?}");
        let (result, summary) = read_result(&dir);
        assert!(summary["deviation"]["hausdorff"].as_f64().unwrap() >= 0.0, "{name}");
        assert!(result.1.len() > holey.1.len(), "{name}");
        // without the request there is no deviation
        write_job(&dir, &job, &holey);
        run(&dir, &mut std::io::sink()).unwrap();
        assert!(read_result(&dir).1.get("deviation").is_none());
    }
}

#[test]
fn hostile_meshes_do_not_panic_and_never_return_an_index_past_the_vertices() {
    let mut next = stream(91);
    let modes = ["weld", "clean", "orient", "stitch", "close_holes"];
    let fairings = ["none", "tangent", "curvature"];
    for case in 0..80 {
        let vertices = 3 + (next() * 24.0) as usize;
        let spread = [1e-9, 1.0, 1e3, 1e50][case % 4];
        let positions: Vec<f64> =
            (0..vertices * 3).map(|_| (next() * 2.0 - 1.0) * spread * if next() < 0.15 { 0.0 } else { 1.0 }).collect();
        // repeated corners, duplicate faces, edges shared by many faces, vertices no face uses
        let indices: Vec<u32> = (0..(1 + (next() * 50.0) as usize) * 3).map(|_| (next() * vertices as f64) as u32).collect();
        let mesh: Mesh = (positions, indices);
        let tolerance = [0.0, spread * 0.01, spread, 1e-300][case % 4];
        let alpha = [1.0, 1.4, 4.0][case % 3];
        let jobs = [
            repair_job(modes[case % 5], json!({ "weldTolerance": tolerance, "maxGap": spread * 0.5, "maxBoundaryEdges": 3 + case % 40 })),
            repair_job(
                modes[(case + 2) % 5],
                json!({ "weldTolerance": tolerance, "maxGap": spread, "smallComponents": { "maxFaces": 2, "maxVolume": spread } }),
            ),
            fill_job(json!({ "fairing": fairings[case % 3], "refine": case % 2 == 0, "alpha": alpha, "maxBoundaryEdges": 3 + case % 30 })),
            fill_job(json!({ "select": [case % 4, 1], "fairing": fairings[(case + 1) % 3] })),
            fill_job(json!({ "select": { "near": [[spread, 0.0, 0.0]] } })),
        ];
        for (k, job) in jobs.iter().enumerate() {
            let dir = folder(&format!("hostile-{k}"));
            write_job(&dir, job, &mesh);
            match run(&dir, &mut std::io::sink()) {
                Ok(_) => {
                    let (result, _) = read_result(&dir);
                    assert!(result.1.iter().all(|&v| (v as usize) < result.0.len() / 3), "case {case} job {k}");
                    assert_eq!((result.0.len() % 3, result.1.len() % 3), (0, 0));
                }
                Err(error) => assert!(
                    error.code.starts_with("MESH_HOLE_") || error.code == "HOLE_NEAR_NOT_FOUND" || error.code == "NATIVE_JOB_INPUT",
                    "case {case} job {k}: {} {}",
                    error.code,
                    error.message
                ),
            }
        }
    }
    let nothing: Mesh = (vec![], vec![]);
    for job in [repair_job("close_holes", json!({})), repair_job("orient", json!({})), fill_job(json!({}))] {
        let (result, _) = run_job("nothing", &job, &nothing);
        assert!(result.1.is_empty());
    }
}

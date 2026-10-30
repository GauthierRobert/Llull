//! `sculpt` (twin of `sculpt.ts`, DES-7c step 7 slice 3): the closed-form result of each brush on a plane or a sphere, falloffs, symmetry, mask and refinement, the same
//! bytes on every run and thread count, hostile input that must not panic, and the job contract (refusal codes, stages). Bit-identity with the TypeScript engine is proven
//! by `server/tests/meshopsNativeSculpt.test.ts` and pinned by `ts_pins.rs`.

mod common;

use common::*;
use llull_meshops::run;
use serde_json::{json, Value};

fn job(brush: &str, extra: Value) -> Value {
    let mut params = json!({
        "brush": brush, "stamps": [[5.0, 5.0, 0.0]], "radius": 2.0, "strength": 0.5, "falloff": "constant", "direction": "area_normal", "taubin": false
    });
    params.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    json!({ "op": "sculpt", "params": params })
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

/// The flat grid of 20 x 20 cells on [0, 10]^2 (edges of 0.5), at height `z`. Vertex `row * 21 + column` is at (column / 2, row / 2).
fn plane(z: f64) -> Mesh {
    grid(20, |_, _| z, &[])
}

/// The vertex of `plane` at (x, y).
fn vertex_at(x: f64, y: f64) -> usize {
    (y * 2.0) as usize * 21 + (x * 2.0) as usize
}

/// The same grid centred on the origin (x and y from -5 to 5).
fn centred() -> Mesh {
    let (positions, indices) = plane(0.0);
    (positions.chunks_exact(3).flat_map(|p| [p[0] - 5.0, p[1] - 5.0, p[2]]).collect(), indices)
}

fn at(mesh: &Mesh, v: usize) -> [f64; 3] {
    point(&mesh.0, v as u32)
}

fn planar_distance(p: [f64; 3], x: f64, y: f64) -> f64 {
    ((p[0] - x) * (p[0] - x) + (p[1] - y) * (p[1] - y)).sqrt()
}

fn radius_of(p: [f64; 3]) -> f64 {
    (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt()
}

#[test]
fn draw_lifts_the_vertices_inside_the_radius_along_the_normal_and_reports_the_height_field_volume() {
    let flat = plane(0.0);
    let (result, report) = run_job("draw", &job("draw", json!({})), &flat);
    let mut inside = 0;
    for v in 0..flat.0.len() / 3 {
        let (before, after) = (at(&flat, v), at(&result, v));
        let in_brush = planar_distance(before, 5.0, 5.0) < 2.0;
        inside += usize::from(in_brush);
        assert_eq!((after[0], after[1], after[2]), (before[0], before[1], if in_brush { 0.5 } else { 0.0 }), "vertex {v}");
    }
    assert_eq!(result.1, flat.1);
    assert_eq!(report["movedVertices"], inside);
    assert_eq!((report["maxDisplacement"].as_f64(), report["stampsApplied"].as_u64()), (Some(0.5), Some(1)));
    assert_eq!(
        (report["volumeBasis"].as_str(), report["symmetryError"].is_null(), report["refinedEdges"].as_u64()),
        (Some("height-field-sum"), true, Some(0))
    );
    let volume = report["displacedVolume"].as_f64().unwrap();
    let disc = 0.5 * std::f64::consts::PI * 4.0;
    assert!((volume - disc).abs() < 0.25 * disc, "volume {volume} against the disc {disc}");
}

#[test]
fn every_falloff_weights_the_stamp_by_its_curve() {
    let flat = plane(0.0);
    // vertex (6, 5) is at t = 0.5 for the radius 2
    let vertex = vertex_at(6.0, 5.0);
    assert_eq!(at(&flat, vertex), [6.0, 5.0, 0.0]);
    for (falloff, weight) in [("constant", 1.0), ("linear", 0.5), ("smooth", 0.75 * 0.75), ("sphere", 0.75f64.sqrt())] {
        let (result, _) = run_job(&format!("falloff-{falloff}"), &job("draw", json!({ "falloff": falloff, "strength": 1.0 })), &flat);
        assert_eq!(at(&result, vertex)[2], weight, "{falloff}");
        assert_eq!(at(&result, vertex_at(5.0, 5.0))[2], 1.0, "the centre, {falloff}");
        assert_eq!(at(&result, vertex_at(7.0, 5.0))[2], 0.0, "t = 1 is outside, {falloff}");
    }
}

#[test]
fn inflate_moves_a_closed_sphere_outwards_and_reports_the_volume_difference() {
    let ball = sphere(3, 0.0, 1);
    let (result, report) =
        run_job("inflate", &job("inflate", json!({ "stamps": [[0.0, 0.0, 10.0]], "radius": 3.0, "strength": 0.2 })), &ball);
    let mut moved = 0;
    for v in 0..ball.0.len() / 3 {
        let (r0, r1) = (radius_of(at(&ball, v)), radius_of(at(&result, v)));
        if r1 != r0 {
            moved += 1;
            assert!(r1 > r0 && r1 - r0 <= 0.2 + 1e-12, "vertex {v}: {r0} -> {r1}");
        }
    }
    assert_eq!(report["movedVertices"], moved);
    assert!(moved > 5);
    assert_eq!(report["volumeBasis"], "closed-volume-difference");
    assert!(report["displacedVolume"].as_f64().unwrap() > 0.0);
}

#[test]
fn draw_with_the_vertex_normals_and_with_a_fixed_vector() {
    let ball = sphere(3, 0.0, 1);
    let normal =
        run_job("draw-normal", &job("draw", json!({ "stamps": [[0.0, 0.0, 10.0]], "radius": 3.0, "direction": "normal" })), &ball).0;
    let inflate = run_job("draw-inflate", &job("inflate", json!({ "stamps": [[0.0, 0.0, 10.0]], "radius": 3.0 })), &ball).0;
    assert_eq!(bytes(&normal.0, &normal.1), bytes(&inflate.0, &inflate.1), "draw along the vertex normals is inflate");
    let flat = plane(0.0);
    let (result, _) = run_job("draw-vector", &job("draw", json!({ "direction": [0.0, 0.0, 2.0] })), &flat);
    assert_eq!(at(&result, vertex_at(5.0, 5.0)), [5.0, 5.0, 0.5], "the vector is normalised");
}

#[test]
fn grab_moves_by_the_vector_times_the_falloff_whatever_the_strength() {
    let flat = plane(0.0);
    for strength in [0.0, 0.5, -3.0] {
        let (result, _) =
            run_job("grab", &job("grab", json!({ "falloff": "linear", "direction": [0.0, 0.0, 1.0], "strength": strength })), &flat);
        assert_eq!(at(&result, vertex_at(5.0, 5.0)), [5.0, 5.0, 1.0]);
        assert_eq!(at(&result, vertex_at(6.0, 5.0)), [6.0, 5.0, 0.5]);
    }
    // a grab without a vector moves nothing (the command refuses it before the engine)
    let (result, report) = run_job("grab-none", &job("grab", json!({})), &flat);
    assert_eq!((result.0.clone(), report["movedVertices"].as_u64()), (flat.0.clone(), Some(0)));
}

#[test]
fn smooth_moves_a_bump_to_its_neighbour_mean_and_taubin_adds_the_second_step() {
    let bump = grid(20, |x, y| if x == 5.0 && y == 5.0 { 1.0 } else { 0.0 }, &[]);
    let extra = json!({ "radius": 1.0, "strength": 0.5 });
    let (plain, _) = run_job("smooth", &job("smooth", extra.clone()), &bump);
    assert_eq!(at(&plain, vertex_at(5.0, 5.0)), [5.0, 5.0, 0.5], "halfway to the mean of its six neighbours");
    assert!((at(&plain, vertex_at(5.5, 5.0))[2] - 1.0 / 12.0).abs() < 1e-15, "a neighbour moves toward the old bump");
    let mut taubin = extra.clone();
    taubin["taubin"] = json!(true);
    let (inflated, report) = run_job("taubin", &job("smooth", taubin), &bump);
    assert_ne!(bytes(&inflated.0, &inflated.1), bytes(&plain.0, &plain.1));
    assert!(at(&inflated, vertex_at(5.0, 5.0))[2] != 0.0);
    assert_eq!(report["volumeBasis"], "height-field-sum");
    // a strength of 0 moves nothing (no division by lambda = 0 in the Taubin step)
    let (still, report) = run_job("smooth-0", &job("smooth", json!({ "radius": 1.0, "strength": 0.0, "taubin": true })), &bump);
    assert_eq!((still.0, report["movedVertices"].as_u64()), (bump.0, Some(0)));
}

#[test]
fn flatten_pulls_the_vertices_to_the_plane() {
    let high = plane(1.0);
    let stamp = json!([[5.0, 5.0, 1.0]]);
    let plane_point = json!([0.0, 0.0, 0.0]);
    let (to_origin, _) = run_job("flatten", &job("flatten", json!({ "stamps": stamp, "strength": 1.0, "planePoint": plane_point })), &high);
    assert_eq!(at(&to_origin, vertex_at(5.0, 5.0))[2], 0.0);
    let (part, _) =
        run_job("flatten-part", &job("flatten", json!({ "stamps": stamp, "strength": 0.25, "planePoint": plane_point })), &high);
    assert_eq!(at(&part, vertex_at(5.0, 5.0))[2], 0.75);
    // the default plane is the area-weighted centroid of the brush, already the surface here
    let (kept, _) = run_job("flatten-default", &job("flatten", json!({ "stamps": stamp, "strength": 1.0 })), &high);
    assert!((at(&kept, vertex_at(5.0, 5.0))[2] - 1.0).abs() < 1e-12);
}

#[test]
fn pinch_pulls_toward_the_centre_and_crease_digs_as_well() {
    let flat = plane(0.0);
    let (pinched, _) = run_job("pinch", &job("pinch", json!({})), &flat);
    assert_eq!(at(&pinched, vertex_at(6.0, 5.0)), [5.5, 5.0, 0.0]);
    assert_eq!(at(&pinched, vertex_at(5.0, 5.0)), [5.0, 5.0, 0.0]);
    let (creased, _) = run_job("crease", &job("crease", json!({})), &flat);
    assert_eq!(at(&creased, vertex_at(6.0, 5.0)), [5.75, 5.0, -0.5]);
}

#[test]
fn layer_stops_at_the_maximum_height_and_never_accumulates() {
    let flat = plane(0.0);
    let two = json!([[5.0, 5.0, 0.0], [5.0, 5.0, 0.0]]);
    let (once, _) = run_job("layer-1", &job("layer", json!({ "strength": 0.4, "maxHeight": 0.3 })), &flat);
    assert_eq!(at(&once, vertex_at(5.0, 5.0))[2], 0.3);
    let (twice, report) = run_job("layer-2", &job("layer", json!({ "strength": 0.4, "maxHeight": 0.3, "stamps": two })), &flat);
    assert_eq!(bytes(&twice.0, &twice.1), bytes(&once.0, &once.1));
    assert_eq!(report["stampsApplied"], 2);
    let (drawn, _) = run_job("draw-2", &job("draw", json!({ "strength": 0.4, "stamps": two })), &flat);
    assert_eq!(at(&drawn, vertex_at(5.0, 5.0))[2], 0.8, "draw accumulates");
    let (free, _) = run_job("layer-free", &job("layer", json!({ "strength": 0.4 })), &flat);
    assert_eq!(at(&free, vertex_at(5.0, 5.0))[2], 0.4);
}

#[test]
fn symmetry_stamps_the_mirror_image_and_a_stamp_on_the_plane_once() {
    let flat = centred();
    let single = run_job("single", &job("draw", json!({ "stamps": [[2.0, 1.0, 0.0]], "radius": 1.0 })), &flat).1;
    let (mirrored, report) =
        run_job("mirrored", &job("draw", json!({ "stamps": [[2.0, 1.0, 0.0]], "radius": 1.0, "symmetry": "yz" })), &flat);
    assert_eq!(report["stampsApplied"], 2);
    assert_eq!(report["movedVertices"].as_u64().unwrap(), 2 * single["movedVertices"].as_u64().unwrap());
    assert_eq!(report["symmetryError"].as_f64(), Some(0.0));
    for v in 0..flat.0.len() / 3 {
        let p = at(&mirrored, v);
        let twin = (0..flat.0.len() / 3).map(|w| at(&mirrored, w)).find(|q| q[0] == -p[0] && q[1] == p[1]).unwrap();
        assert_eq!(twin[2], p[2], "vertex {v}");
    }
    let (_, on_plane) = run_job("on-plane", &job("draw", json!({ "stamps": [[0.0, 1.0, 0.0]], "radius": 1.0, "symmetry": "yz" })), &flat);
    assert_eq!(on_plane["stampsApplied"], 1);
    for (plane_name, applied) in [("xz", 2), ("xy", 1)] {
        let (_, other) =
            run_job("planes", &job("draw", json!({ "stamps": [[2.0, 1.0, 0.0]], "radius": 1.0, "symmetry": plane_name })), &flat);
        assert_eq!(other["stampsApplied"], applied, "{plane_name}");
        assert!(other["symmetryError"].as_f64().is_some(), "{plane_name}");
    }
    // a vector direction is mirrored with the second stamp
    let (grabbed, _) = run_job(
        "grab-sym",
        &job("grab", json!({ "stamps": [[2.0, 1.0, 0.0]], "radius": 1.0, "symmetry": "yz", "direction": [1.0, 0.0, 1.0] })),
        &flat,
    );
    let find = |x: f64, y: f64| (0..flat.0.len() / 3).find(|&v| at(&flat, v) == [x, y, 0.0]).unwrap();
    assert_eq!((at(&grabbed, find(2.0, 1.0)), at(&grabbed, find(-2.0, 1.0))), ([3.0, 1.0, 1.0], [-3.0, 1.0, 1.0]));
}

#[test]
fn the_mask_keeps_the_vertices_outside_it_in_place() {
    let flat = plane(0.0);
    let (masked, report) = run_job("mask", &job("draw", json!({ "mask": { "center": [5.0, 5.0, 0.0], "radius": 1.0 } })), &flat);
    for v in 0..flat.0.len() / 3 {
        let expected = if planar_distance(at(&flat, v), 5.0, 5.0) <= 1.0 { 0.5 } else { 0.0 };
        assert_eq!(at(&masked, v)[2], expected, "vertex {v}");
    }
    assert_eq!(report["movedVertices"], 13);
}

#[test]
fn refinement_splits_the_long_edges_inside_the_brush_and_compacts_the_mesh() {
    let coarse = grid(10, |_, _| 0.0, &[]);
    let (plain, plain_report) = run_job("coarse", &job("draw", json!({})), &coarse);
    let (refined, report) = run_job("refined", &job("draw", json!({ "refineEdge": 0.6 })), &coarse);
    assert_eq!(plain_report["refinedEdges"], 0);
    assert!(report["refinedEdges"].as_u64().unwrap() > 0);
    assert_eq!(plain.1.len(), coarse.1.len());
    assert!(refined.1.len() > coarse.1.len() && refined.0.len() > coarse.0.len());
    topology(&refined.1);
    assert!(refined.0.chunks_exact(3).all(|p| p[2] == 0.0 || p[2] == 0.5));
    // an edge outside the brush is not split
    assert!(report["refinedEdges"].as_u64().unwrap() < (coarse.1.len() / 3) as u64);
    // vertices no face uses stay when nothing is refined, and go with the refinement
    let loose: Mesh = ([coarse.0.clone(), vec![99.0, 99.0, 99.0]].concat(), coarse.1.clone());
    assert_eq!(run_job("loose", &job("draw", json!({})), &loose).0 .0.len(), loose.0.len());
    assert_eq!(run_job("loose-refined", &job("draw", json!({ "refineEdge": 100.0 })), &loose).0 .0.len(), coarse.0.len());
}

#[test]
fn a_refinement_past_the_triangle_limit_is_refused_with_the_size_reached() {
    let coarse = grid(10, |_, _| 0.0, &[]);
    let (code, message) = refusal("too-large", &job("draw", json!({ "refineEdge": 0.01, "radius": 4.0, "maxTriangles": 500 })), &coarse);
    assert_eq!(code, "SCULPT_TOO_LARGE");
    assert!(message.contains("limit 500") && message.contains("use a longer refineEdge"), "{message}");
}

#[test]
fn stamps_farther_than_the_radius_from_the_surface_name_the_first_one() {
    let flat = plane(0.0);
    for (stamps, index) in [(json!([[5.0, 5.0, 10.0]]), "0"), (json!([[5.0, 5.0, 1.0], [5.0, 5.0, 2.5]]), "1")] {
        let (code, message) = refusal("off", &job("draw", json!({ "stamps": stamps })), &flat);
        assert_eq!((code.as_str(), message.as_str()), ("SCULPT_OFF_SURFACE", index));
    }
    // a stamp exactly at the radius is on the surface
    run_job("at-radius", &job("draw", json!({ "stamps": [[5.0, 5.0, 2.0]] })), &flat);
    let nothing: Mesh = (vec![], vec![]);
    assert_eq!(refusal("nothing", &job("draw", json!({})), &nothing).0, "SCULPT_OFF_SURFACE");
    // no stamp: the mesh comes back as it is
    let (same, report) = run_job("no-stamps", &job("draw", json!({ "stamps": [] })), &flat);
    assert_eq!((same, report["stampsApplied"].as_u64()), (flat, Some(0)));
}

#[test]
fn parameters_the_job_cannot_take_are_refused_with_the_input_code() {
    let flat = plane(0.0);
    let cases = [
        ("radius 0", json!({ "radius": 0.0 })),
        ("negative radius", json!({ "radius": -1.0 })),
        ("huge radius", json!({ "radius": 1e101 })),
        ("a null strength", json!({ "strength": null })),
        ("unknown brush", json!({ "brush": "carve" })),
        ("unknown falloff", json!({ "falloff": "cubic" })),
        ("unknown direction", json!({ "direction": "diagonal" })),
        ("a short direction vector", json!({ "direction": [1.0, 0.0] })),
        ("a huge direction vector", json!({ "direction": [1e101, 0.0, 0.0] })),
        ("unknown symmetry", json!({ "symmetry": "zz" })),
        ("maxHeight 0", json!({ "maxHeight": 0.0 })),
        ("refineEdge -1", json!({ "refineEdge": -1.0 })),
        ("a mask of radius 0", json!({ "mask": { "center": [0.0, 0.0, 0.0], "radius": 0.0 } })),
        ("a stamp too far out", json!({ "stamps": [[1e101, 0.0, 0.0]] })),
        ("a plane point too far out", json!({ "planePoint": [0.0, 1e101, 0.0] })),
        ("a fractional triangle limit", json!({ "maxTriangles": 1.5 })),
        ("stamps that are no list", json!({ "stamps": "all" })),
    ];
    for (name, extra) in cases {
        assert_eq!(refusal(name, &job("draw", extra), &flat).0, "NATIVE_JOB_INPUT", "{name}");
    }
    // a coordinate of the mesh above 1e100
    let far: Mesh = (vec![0.0, 0.0, 0.0, 1e101, 0.0, 0.0, 0.0, 1.0, 0.0], vec![0, 1, 2]);
    assert_eq!(refusal("far", &job("draw", json!({})), &far).0, "NATIVE_JOB_INPUT");
    // a result that overflows (the volume sums) is not finite: the TypeScript engine answers it
    assert_eq!(refusal("overflow", &job("draw", json!({ "strength": 1e308 })), &flat).0, "NATIVE_JOB_INPUT");
}

#[test]
fn every_brush_gives_the_same_bytes_on_every_run_and_any_thread_count() {
    let ball = sphere(4, 0.02, 7);
    let jobs: Vec<Value> = ["draw", "inflate", "grab", "smooth", "flatten", "pinch", "crease", "layer"]
        .iter()
        .enumerate()
        .map(|(k, brush)| {
            job(
                brush,
                json!({
                    "stamps": [[0.0, 0.0, 10.0], [1.5, 0.5, 10.0], [4.0, 4.0, 8.0], [-3.0, 2.0, 9.0]], "radius": 3.5, "strength": 0.3,
                    "falloff": (["smooth", "linear", "sphere", "constant"][k % 4]), "symmetry": (["yz", "xz", "xy"][k % 3]), "taubin": k % 2 == 0,
                    "direction": if k % 3 == 0 { json!("normal") } else if k % 3 == 1 { json!("area_normal") } else { json!([0.3, 0.2, 1.0]) },
                    "maxHeight": 0.2, "refineEdge": if k % 2 == 1 { json!(0.4) } else { json!(null) },
                    "mask": { "center": [0.0, 0.0, 9.0], "radius": 8.0 },
                }),
            )
        })
        .collect();
    for (k, job) in jobs.iter().enumerate() {
        let (first, report) = run_job(&format!("det-{k}"), job, &ball);
        assert!(report["movedVertices"].as_u64().unwrap() > 0, "job {k} moves something");
        let expected = (bytes(&first.0, &first.1), report.to_string());
        for threads in [1, 2, 7] {
            let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).build().unwrap();
            let again = pool.install(|| run_job(&format!("det-{k}-{threads}"), job, &ball));
            assert_eq!((bytes(&again.0 .0, &again.0 .1), again.1.to_string()), expected, "job {k}, {threads} threads");
        }
    }
}

#[test]
fn hostile_meshes_do_not_panic_and_never_return_an_index_past_the_vertices() {
    let mut next = stream(53);
    let brushes = ["draw", "inflate", "grab", "smooth", "flatten", "pinch", "crease", "layer"];
    for case in 0..120 {
        let vertices = 3 + (next() * 20.0) as usize;
        let spread = [1e-9, 1.0, 1e3, 1e50, 1e99][case % 5];
        let positions: Vec<f64> =
            (0..vertices * 3).map(|_| (next() * 2.0 - 1.0) * spread * if next() < 0.15 { 0.0 } else { 1.0 }).collect();
        // repeated corners, duplicate faces, edges shared by many faces, vertices no face uses
        let indices: Vec<u32> = (0..(1 + (next() * 40.0) as usize) * 3).map(|_| (next() * vertices as f64) as u32).collect();
        let stamp = [(next() - 0.5) * spread, (next() - 0.5) * spread, (next() - 0.5) * spread];
        let direction = if case % 3 == 0 {
            json!("normal")
        } else if case % 3 == 1 {
            json!("area_normal")
        } else {
            json!([1.0, 2.0, 3.0])
        };
        let job = job(
            brushes[case % 8],
            json!({
                "stamps": [stamp, [stamp[0], -stamp[1], stamp[2]]], "radius": spread * 2.0, "strength": spread * 0.1, "direction": direction,
                "falloff": (["constant", "linear", "smooth", "sphere"][case % 4]), "symmetry": (["yz", "xz", "xy"][case % 3]), "taubin": case % 2 == 0,
                "refineEdge": if case % 4 == 0 { json!(spread * 0.2) } else { json!(null) }, "maxTriangles": 3000,
                "mask": if case % 5 == 0 { json!({ "center": [0.0, 0.0, 0.0], "radius": spread }) } else { json!(null) },
            }),
        );
        let dir = folder("hostile");
        write_job(&dir, &job, &(positions, indices));
        match run(&dir, &mut std::io::sink()) {
            Ok(_) => {
                let (result, _) = read_result(&dir);
                assert!(result.1.iter().all(|&v| (v as usize) < result.0.len() / 3), "case {case}");
                assert!(result.0.iter().all(|v| v.is_finite()), "case {case}");
                assert_eq!((result.0.len() % 3, result.1.len() % 3), (0, 0));
            }
            Err(error) => assert!(
                ["NATIVE_JOB_INPUT", "SCULPT_OFF_SURFACE", "SCULPT_TOO_LARGE"].contains(&error.code),
                "case {case}: {} {}",
                error.code,
                error.message
            ),
        }
    }
}

#[test]
fn the_job_reports_its_stage_with_rising_fractions() {
    let ball = sphere(3, 0.0, 1);
    let dir = folder("stages");
    let stamps = json!([[0.0, 0.0, 10.0], [1.0, 0.0, 10.0], [2.0, 0.0, 10.0]]);
    write_job(&dir, &job("draw", json!({ "stamps": stamps, "radius": 3.0, "refineEdge": 0.5 })), &ball);
    let mut out = Vec::new();
    run(&dir, &mut out).unwrap();
    let events: Vec<Value> = String::from_utf8(out).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    let mut stages: Vec<&str> = events.iter().filter_map(|e| e["stage"].as_str()).collect();
    stages.dedup();
    assert_eq!(stages, ["read", "sculpt", "write"]);
    let fractions: Vec<f64> = events.iter().map(|e| e["fraction"].as_f64().unwrap()).collect();
    assert!(fractions.windows(2).all(|pair| pair[0] <= pair[1]) && fractions.first() == Some(&0.0), "{fractions:?}");
    assert!(read_result(&dir).1.get("deviation").is_none());
}

#[test]
fn refinement_splits_the_boundary_edges_of_an_open_mesh_whichever_way_a_face_runs_them() {
    // a +Z grid: its top and left sides are run from the higher to the lower vertex index
    let open = grid(4, |_, _| 0.0, &[]);
    let (refined, report) = run_job(
        "open-boundary",
        &job("draw", json!({ "stamps": [[5.0, 5.0, 0.0]], "radius": 100.0, "strength": 0.0, "refineEdge": 0.4 })),
        &open,
    );
    assert!(report["refinedEdges"].as_u64().unwrap() > 0);
    let (positions, indices) = (&refined.0, &refined.1);
    let mut uses = std::collections::BTreeMap::new();
    for t in indices.chunks_exact(3) {
        for k in 0..3 {
            let (a, b) = (t[k], t[(k + 1) % 3]);
            *uses.entry((a.min(b), a.max(b))).or_insert(0) += 1;
        }
    }
    let length = |a: u32, b: u32| {
        let (p, q) = (point(positions, a), point(positions, b));
        ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2)).sqrt()
    };
    let boundary: Vec<_> = uses.iter().filter(|(_, &n)| n == 1).map(|(&(a, b), _)| length(a, b)).collect();
    assert!(boundary.len() > 40);
    assert!(boundary.iter().all(|&l| l <= 0.4), "{boundary:?}");
}

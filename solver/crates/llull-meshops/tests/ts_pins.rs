//! Results of the TypeScript mesh engine (the oracle of VC-MSH-32), pinned for the ops ported in DES-7c step 7 (remesh, analyze, repair, fill_holes, sculpt): the SHA-256 of the result positions
//! (`result_positions.f64`) followed by the indices (`result_indices.u32`), the whole `report` of `report.json` and, for `analyze`, its `analysis`, from `data/ts_pins.json`.
//! `native:check` runs cargo only, so these pins keep the bit-identity of the Rust code testable where the server suite does not run;
//! `server/tests/meshopsNative.test.ts` is the live comparison.
//!
//! How to regenerate `data/ts_pins.json` (after a deliberate change of a TypeScript op, or to add a case below):
//!   1. `LLULL_PIN_DIR=<empty dir> cargo test --release -p llull-meshops --test ts_pins -- --ignored write_pin_inputs` writes one folder per pin
//!      (`job.json`, `positions.f64`, `indices.u32`);
//!   2. `LLULL_PIN_DIR=<that dir> LLULL_PIN_WRITE=<repo>/solver/crates/llull-meshops/tests/data/ts_pins.json npx vitest run tests/meshopsPinsRegen.test.ts`
//!      (in `server/`) runs the TypeScript engine on those folders and writes the file.
//!
//! A mismatch is either a bug of the Rust twin or a change of the TypeScript op that the twin must follow: never edit the file by hand.

mod common;

use common::*;
use llull_meshops::run;
use llull_protocol::sha256_hex;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

struct Pin {
    name: &'static str,
    mesh: Mesh,
    job: Value,
}

fn wavy(x: f64, y: f64) -> f64 {
    0.4 * (x / 1.5).sin() * (y / 2.0).cos()
}

/// A ridge along x = 5: the two halves meet at about 77 degrees.
fn ridge(x: f64, _y: f64) -> f64 {
    0.8 * (x - 5.0).abs()
}

fn remesh(extra: Value) -> Value {
    let mut params = json!({ "iterations": 3, "featureAngleRad": 40f64.to_radians(), "preserveBoundary": true, "project": true });
    params.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    json!({ "op": "remesh", "params": params })
}

fn analyze(extra: Value) -> Value {
    let mut params = json!({ "maxListed": 20, "weldTolerance": 0, "selfIntersections": false });
    params.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    json!({ "op": "analyze", "params": params })
}

fn repair(mode: &str, extra: Value) -> Value {
    let mut params = json!({ "mode": mode, "weldTolerance": 1e-9, "maxGap": 1e-6, "maxBoundaryEdges": 1000 });
    params.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    json!({ "op": "repair", "params": params })
}

fn fill(extra: Value) -> Value {
    let mut params =
        json!({ "select": "all", "maxBoundaryEdges": 1000, "fairing": "curvature", "refine": true, "alpha": std::f64::consts::SQRT_2 });
    params.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    json!({ "op": "fill_holes", "params": params })
}

fn sculpt(brush: &str, extra: Value) -> Value {
    let mut params = json!({
        "brush": brush, "stamps": [[0.0, 0.0, 10.0]], "radius": 3.0, "strength": 0.4, "falloff": "smooth", "direction": "area_normal", "taubin": false
    });
    params.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    json!({ "op": "sculpt", "params": params })
}

/// A stroke on the noisy sphere: three stamps along a meridian.
fn stroke() -> Value {
    json!([[0.0, 0.0, 10.0], [2.0, 1.0, 9.7], [4.0, 2.0, 9.0]])
}

/// `mesh` without the faces listed.
fn without(mesh: &Mesh, faces: &[usize]) -> Mesh {
    let indices = mesh.1.chunks_exact(3).enumerate().filter(|(f, _)| !faces.contains(f)).flat_map(|(_, t)| t.to_vec()).collect();
    (mesh.0.clone(), indices)
}

/// A mesh as a soup of three private vertices per face, each moved by up to `jitter`.
fn soup(mesh: &Mesh, jitter: f64, seed: u64) -> Mesh {
    let mut next = stream(seed);
    let positions = mesh.1.iter().flat_map(|&v| point(&mesh.0, v).map(|x| x + (next() * 2.0 - 1.0) * jitter)).collect();
    (positions, (0..mesh.1.len() as u32).collect())
}

/// `mesh` with the winding of the faces listed reversed.
fn flipped(mesh: &Mesh, faces: &[usize]) -> Mesh {
    let mut out = mesh.clone();
    faces.iter().for_each(|&f| out.1.swap(f * 3 + 1, f * 3 + 2));
    out
}

/// Holes of 6 to 10 edges in a noisy sphere.
fn holey_sphere() -> Mesh {
    without(&sphere(4, 0.03, 9), &[10, 11, 12, 13, 14, 15, 400, 401, 402, 403, 900, 901, 902, 903, 904, 905, 906])
}

/// The corner 2 is 0.001 from the corner 1: merging them would put a third face on the edge 0-1, so the stitch is reverted.
fn pinch() -> Mesh {
    (vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.001, 0.0, 0.5, 1.0, 0.0, 0.5, -1.0, 0.0, 0.5, 0.5, 1.0], vec![0, 1, 3, 1, 0, 4, 0, 2, 5])
}

/// Two wavy patches 0.001 apart: the vertices along the crack exist twice.
fn cracked() -> Mesh {
    let patch = grid(8, |_, y| 0.3 * y.cos(), &[]);
    side_by_side(&[patch.clone(), patch], 10.001)
}

/// A square grid of 100 cells a side with a 40 x 40 block of cells left out: a hole of 160 edges, above the limit of the dynamic program.
fn greedy_hole() -> Mesh {
    let holes: Vec<(usize, usize)> = (30..70).flat_map(|i| (30..70).map(move |j| (i, j))).collect();
    grid(100, |x, y| 0.1 * x.sin() * y.cos(), &holes)
}

/// `parts` meshes side by side (one shell each, shifted along x by `gap`).
fn side_by_side(parts: &[Mesh], gap: f64) -> Mesh {
    let (mut positions, mut indices) = (Vec::new(), Vec::new());
    for (k, part) in parts.iter().enumerate() {
        let offset = (positions.len() / 3) as u32;
        positions.extend(part.0.chunks_exact(3).flat_map(|p| [p[0] + gap * k as f64, p[1], p[2]]));
        indices.extend(part.1.iter().map(|v| v + offset));
    }
    (positions, indices)
}

/// A sphere as an unwelded soup (three vertices per face), a flipped face, a dropped face and a repeated face.
fn damaged_sphere() -> Mesh {
    let (positions, indices) = sphere(3, 0.05, 21);
    let mut faces: Vec<[u32; 3]> = indices.chunks_exact(3).map(|t| [t[0], t[1], t[2]]).collect();
    faces[10].swap(1, 2);
    faces.remove(40);
    faces.push(faces[100]);
    faces.push([faces[7][0], faces[7][0], faces[7][1]]);
    let soup_positions = faces
        .iter()
        .flatten()
        .flat_map(|&v| [positions[v as usize * 3], positions[v as usize * 3 + 1], positions[v as usize * 3 + 2]])
        .collect();
    (soup_positions, (0..faces.len() as u32 * 3).collect())
}

/// `mesh` with a face that repeats a corner.
fn with_degenerate(mut mesh: Mesh) -> Mesh {
    mesh.1.extend([0, 0, 4]);
    mesh
}

/// The vertex 0 of the sphere that `with_degenerate` gives a face with a repeated corner (0, 0, 4).
fn corner_stamp() -> Value {
    let mesh = sphere(3, 0.03, 5);
    json!(point(&mesh.0, 0))
}

/// One big triangle in z = 0 (a large triangle for the grid) pierced by 60 small stakes, and a few stakes that only touch it.
fn stakes() -> Mesh {
    let mut positions = vec![-500.0, -500.0, 0.0, 500.0, -500.0, 0.0, 0.0, 500.0, 0.0];
    let mut indices = vec![0u32, 1, 2];
    for k in 0..66 {
        let (x, y) = ((k % 11) as f64 * 2.5 - 12.0, (k / 11) as f64 * 2.5 - 8.0);
        let top = if k % 11 == 10 { 0.0 } else { 1.0 };
        let base = (positions.len() / 3) as u32;
        positions.extend([x, y, -1.0, x + 0.2, y, -1.0, x, y, top]);
        indices.extend([base, base + 1, base + 2]);
    }
    (positions, indices)
}

/// 200 tiny disjoint triangles at the origin, then a tiny pair at 1e11 and a crossing pair at 1e17: grid cell indices past 2^53 (the oracle looped forever on them).
fn far_cells() -> Mesh {
    let mut positions = Vec::new();
    for k in 0..200 {
        let x = k as f64 * 1e-3;
        positions.extend([x, 0.0, 0.0, x + 1e-6, 0.0, 0.0, x, 1e-6, 0.0]);
    }
    let (x, s) = (1e17, 100.0);
    positions.extend([x, 0.0, 0.0, x + 2.0 * s, 0.0, 0.0, x + s, 0.0, 2.0 * s]);
    positions.extend([x + s, -s, s / 2.0, x + s, s, s / 2.0, x + s, 0.0, 3.0 * s]);
    positions.extend([1e11, 0.0, 0.0, 1e11 + 1e-3, 0.0, 0.0, 1e11, 1e-3, 0.0]);
    let faces = positions.len() as u32 / 9;
    (positions, (0..faces * 3).collect())
}

fn pins() -> Vec<Pin> {
    vec![
        Pin { name: "remesh_sphere_split", mesh: sphere(3, 0.05, 7), job: remesh(json!({ "targetEdge": 0.9 })) },
        Pin { name: "remesh_sphere_merge", mesh: sphere(4, 0.05, 11), job: remesh(json!({ "targetEdge": 2.5, "iterations": 4 })) },
        Pin {
            name: "remesh_adaptive",
            mesh: sphere(3, 0.02, 5),
            job: remesh(json!({ "minEdge": 0.5, "maxEdge": 3.0, "approxError": 0.02 })),
        },
        Pin {
            name: "remesh_region",
            mesh: sphere(3, 0.0, 1),
            job: remesh(json!({ "targetEdge": 0.6, "region": { "center": [0.0, 0.0, 10.0], "radius": 3.0 } })),
        },
        Pin { name: "remesh_ridge", mesh: grid(10, ridge, &[]), job: remesh(json!({ "targetEdge": 0.7 })) },
        Pin { name: "analyze_sphere", mesh: sphere(4, 0.1, 3), job: analyze(json!({})) },
        Pin { name: "analyze_open_with_holes", mesh: grid(16, wavy, &[(3, 3), (4, 3), (10, 12)]), job: analyze(json!({ "maxListed": 2 })) },
        Pin {
            name: "analyze_two_shells",
            mesh: side_by_side(&[sphere(2, 0.0, 1), sphere(3, 0.2, 2)], 30.0),
            job: analyze(json!({ "maxListed": 1 })),
        },
        Pin { name: "analyze_damaged_soup", mesh: damaged_sphere(), job: analyze(json!({})) },
        Pin {
            name: "repair_weld_soup",
            mesh: with_degenerate(soup(&sphere(2, 0.0, 1), 2e-5, 3)),
            job: repair("weld", json!({ "weldTolerance": 1e-4 })),
        },
        Pin { name: "repair_clean_damaged", mesh: damaged_sphere(), job: repair("clean", json!({})) },
        Pin {
            name: "repair_orient_flipped",
            mesh: side_by_side(
                &[flipped(&sphere(3, 0.05, 4), &[3, 4, 5, 90, 200]), flipped(&sphere(2, 0.0, 6), &(0..320).collect::<Vec<_>>())],
                30.0,
            ),
            job: repair("orient", json!({})),
        },
        Pin { name: "repair_stitch_cracked", mesh: cracked(), job: repair("stitch", json!({ "maxGap": 0.002 })) },
        Pin { name: "repair_stitch_reverted", mesh: pinch(), job: repair("stitch", json!({ "maxGap": 0.01, "weldTolerance": 0.0 })) },
        Pin { name: "repair_close_holes", mesh: holey_sphere(), job: repair("close_holes", json!({})) },
        Pin { name: "repair_close_holes_greedy", mesh: greedy_hole(), job: repair("close_holes", json!({})) },
        Pin {
            name: "repair_small_shells",
            mesh: side_by_side(&[sphere(3, 0.0, 1), sphere(1, 0.0, 1), grid(3, |_, _| 0.0, &[])], 40.0),
            job: repair("clean", json!({ "smallComponents": { "maxFaces": 100, "maxVolume": 5000.0 } })),
        },
        Pin { name: "fill_curvature_alpha_2", mesh: holey_sphere(), job: fill(json!({ "alpha": 2.0 })) },
        Pin {
            name: "fill_tangent_near",
            mesh: grid(30, |x, y| 0.2 * (x * y).sin(), &(8..22).flat_map(|i| (8..22).map(move |j| (i, j))).collect::<Vec<_>>()),
            job: fill(json!({ "fairing": "tangent", "alpha": 2.0, "select": { "near": [[5.0, 5.0, 0.0]] } })),
        },
        Pin { name: "fill_plain_loops", mesh: holey_sphere(), job: fill(json!({ "fairing": "none", "refine": false, "select": [1, 0] })) },
        Pin { name: "sculpt_draw_stroke", mesh: sphere(4, 0.03, 3), job: sculpt("draw", json!({ "stamps": stroke() })) },
        Pin {
            name: "sculpt_draw_normal_mirror",
            mesh: sphere(4, 0.03, 5),
            job: sculpt("draw", json!({ "stamps": stroke(), "direction": "normal", "falloff": "sphere", "symmetry": "yz" })),
        },
        Pin {
            name: "sculpt_inflate_masked",
            mesh: sphere(4, 0.03, 6),
            job: sculpt(
                "inflate",
                json!({ "stamps": stroke(), "falloff": "linear", "mask": { "center": [1.0, 0.0, 10.0], "radius": 2.5 } }),
            ),
        },
        Pin {
            name: "sculpt_grab_vector_mirror",
            mesh: sphere(4, 0.03, 7),
            job: sculpt("grab", json!({ "stamps": stroke(), "direction": [0.3, 0.2, 1.0], "symmetry": "xz", "falloff": "constant" })),
        },
        Pin {
            name: "sculpt_smooth_taubin",
            mesh: sphere(4, 0.05, 8),
            job: sculpt("smooth", json!({ "stamps": stroke(), "strength": 0.6, "taubin": true, "radius": 3.5 })),
        },
        Pin {
            name: "sculpt_flatten_open",
            mesh: grid(30, wavy, &[(8, 8), (20, 3)]),
            job: sculpt("flatten", json!({ "stamps": [[5.0, 5.0, 0.0], [6.0, 4.0, 0.1]], "strength": 0.7, "radius": 2.0 })),
        },
        Pin {
            name: "sculpt_flatten_plane_point",
            mesh: grid(30, wavy, &[]),
            job: sculpt("flatten", json!({ "stamps": [[5.0, 5.0, 0.0]], "strength": 0.5, "radius": 2.5, "planePoint": [5.0, 5.0, 0.1] })),
        },
        Pin {
            name: "sculpt_pinch_crease",
            mesh: grid(30, ridge, &[]),
            job: sculpt(
                "crease",
                json!({ "stamps": [[5.0, 5.0, 0.0], [5.0, 6.0, 0.0]], "strength": 0.3, "radius": 1.5, "symmetry": "xy" }),
            ),
        },
        Pin {
            name: "sculpt_pinch",
            mesh: grid(30, wavy, &[]),
            job: sculpt("pinch", json!({ "stamps": [[5.0, 5.0, 0.0]], "strength": 0.5, "radius": 2.0, "direction": "normal" })),
        },
        Pin {
            name: "sculpt_layer_height",
            mesh: grid(30, wavy, &[]),
            job: sculpt(
                "layer",
                json!({ "stamps": [[4.0, 5.0, 0.0], [5.0, 5.0, 0.0], [6.0, 5.0, 0.0]], "strength": 0.5, "maxHeight": 0.3, "radius": 1.5 }),
            ),
        },
        Pin {
            name: "sculpt_refine_mask",
            mesh: sphere(3, 0.0, 1),
            job: sculpt(
                "draw",
                json!({ "stamps": [[0.0, 0.0, 10.0]], "refineEdge": 0.5, "radius": 2.5, "mask": { "center": [0.0, 0.0, 10.0], "radius": 2.0 } }),
            ),
        },
        Pin {
            name: "sculpt_damaged_soup",
            mesh: damaged_sphere(),
            job: sculpt(
                "smooth",
                json!({ "stamps": [[0.0, 0.0, 10.0], [10.0, 0.0, 0.0]], "radius": 6.0, "strength": 0.5, "direction": "normal" }),
            ),
        },
        Pin {
            name: "sculpt_damaged_inflate",
            mesh: damaged_sphere(),
            job: sculpt("inflate", json!({ "stamps": [[0.0, 0.0, 10.0], [10.0, 0.0, 0.0]], "radius": 6.0, "strength": 0.5 })),
        },
        Pin {
            name: "sculpt_soup_mirror",
            mesh: soup(&sphere(2, 0.0, 1), 0.0, 3),
            job: sculpt(
                "draw",
                json!({ "stamps": [[0.0, 0.0, 10.0], [3.0, 2.0, 9.5]], "radius": 4.0, "direction": "normal", "symmetry": "yz" }),
            ),
        },
        Pin {
            name: "sculpt_repeated_corner_inflate",
            mesh: with_degenerate(sphere(3, 0.03, 5)),
            job: sculpt("inflate", json!({ "stamps": [corner_stamp()], "radius": 3.0, "strength": 0.5 })),
        },
        Pin {
            name: "sculpt_repeated_corner_smooth",
            mesh: with_degenerate(sphere(3, 0.03, 5)),
            job: sculpt("smooth", json!({ "stamps": [corner_stamp()], "radius": 3.0, "strength": 0.5, "taubin": true })),
        },
        Pin {
            name: "sculpt_refine_open_boundary",
            mesh: grid(6, wavy, &[(2, 2)]),
            job: sculpt(
                "draw",
                json!({ "stamps": [[5.0, 5.0, 0.0], [1.0, 9.0, 0.0]], "radius": 6.0, "refineEdge": 0.5, "symmetry": "xz" }),
            ),
        },
        Pin {
            name: "analyze_pairs_overlapping_spheres",
            mesh: side_by_side(&[sphere(3, 0.02, 4), sphere(3, 0.0, 1), sphere(2, 0.1, 8)], 6.0),
            job: analyze(json!({ "selfIntersections": true, "maxListed": 7 })),
        },
        Pin {
            name: "analyze_pairs_damaged_soups",
            mesh: side_by_side(&[damaged_sphere(), damaged_sphere()], 5.0),
            job: analyze(json!({ "selfIntersections": true, "maxListed": 4 })),
        },
        Pin { name: "analyze_pairs_far_cells", mesh: far_cells(), job: analyze(json!({ "selfIntersections": true })) },
        Pin { name: "analyze_pairs_clean_sphere", mesh: sphere(4, 0.0, 1), job: analyze(json!({ "selfIntersections": true })) },
        Pin {
            name: "analyze_pairs_stakes_through_a_large_triangle",
            mesh: stakes(),
            job: analyze(json!({ "selfIntersections": true, "maxListed": 12 })),
        },
        Pin {
            name: "remesh_free_boundary",
            mesh: grid(16, wavy, &[(3, 3), (10, 12)]),
            job: remesh(json!({ "targetEdge": 1.2, "preserveBoundary": false, "project": false })),
        },
    ]
}

/// JSON equality with numbers compared as numbers (JavaScript writes 1 where Rust writes 1.0).
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(key, p)| y.get(key).is_some_and(|q| same(p, q))),
        _ => a == b,
    }
}

fn write_inputs(dir: &Path, pin: &Pin) {
    fs::create_dir_all(dir).unwrap();
    write_job(dir, &pin.job, &pin.mesh);
}

#[test]
fn the_results_are_the_ones_of_the_typescript_engine() {
    let expected: Value = serde_json::from_str(include_str!("data/ts_pins.json")).unwrap();
    for pin in pins() {
        let dir = folder(&format!("pin-{}", pin.name));
        write_inputs(&dir, &pin);
        run(&dir, &mut std::io::sink()).unwrap();
        let mut stream = fs::read(dir.join("result_positions.f64")).unwrap_or_default();
        stream.extend(fs::read(dir.join("result_indices.u32")).unwrap_or_default());
        let report: Value = serde_json::from_slice(&fs::read(dir.join("report.json")).unwrap()).unwrap();
        let pinned = &expected[pin.name];
        let digest = if stream.is_empty() { Value::Null } else { json!(sha256_hex(&stream)) };
        assert_eq!(pinned["digest"], digest, "{}: result bytes", pin.name);
        if pin.job["op"] == "analyze" {
            assert!(
                same(&pinned["analysis"], &report["analysis"]),
                "{}: analysis {} against {}",
                pin.name,
                pinned["analysis"],
                report["analysis"]
            );
        }
        assert!(same(&pinned["report"], &report["report"]), "{}: report {} against {}", pin.name, pinned["report"], report["report"]);
    }
}

#[test]
#[ignore = "writes the pin inputs to $LLULL_PIN_DIR for the TypeScript engine (see the module doc)"]
fn write_pin_inputs() {
    let dir = std::env::var("LLULL_PIN_DIR").expect("set LLULL_PIN_DIR to an empty folder");
    for pin in pins() {
        write_inputs(&Path::new(&dir).join(pin.name), &pin);
    }
}

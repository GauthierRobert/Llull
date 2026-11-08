//! The `tets` op on analytic fields (FLL-M1): volume against the exact solid, dihedral bounds, validity (no folds, a closed boundary),
//! determinism across runs and thread counts, targets and the named refusals.

use crate::eval::Evaluator;
use crate::tape::Op;
use crate::testkit::Tape;
use crate::tet_quality::analyse;
use crate::tets_job::tets_job;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::f64::consts::PI;

fn sphere(r: f64) -> Evaluator {
    let mut t = Tape::new();
    let out = t.ball([0.0; 3], r);
    t.finish(out)
}

/// max(|x| - a, |y| - b, |z| - c): exact inside, the box of half sizes (a, b, c).
fn cuboid(half: [f64; 3]) -> Evaluator {
    let mut t = Tape::new();
    let axes = [t.x(), t.y(), t.z()];
    let mut parts = Vec::new();
    for (axis, &p) in axes.iter().enumerate() {
        let a = t.un(Op::Abs, p);
        let h = t.c(half[axis]);
        parts.push(t.bin(Op::Sub, a, h));
    }
    let m = t.bin(Op::Max, parts[0], parts[1]);
    let out = t.bin(Op::Max, m, parts[2]);
    t.finish(out)
}

/// A gyroid sheet (cell 2 pi / k, half thickness w) clipped to a ball of radius r: thin walls, saddles, many sign changes.
fn gyroid_ball(k: f64, w: f64, r: f64) -> Evaluator {
    let mut t = Tape::new();
    let ball = t.ball([0.0; 3], r);
    let kc = t.c(k);
    let (x, y, z) = (t.x(), t.y(), t.z());
    let scaled = [x, y, z].map(|p| t.bin(Op::Mul, p, kc));
    let trig = |t: &mut Tape, a: i64, b: i64| {
        let s = t.un(Op::Sin, a);
        let c = t.un(Op::Cos, b);
        t.bin(Op::Mul, s, c)
    };
    let g1 = trig(&mut t, scaled[0], scaled[1]);
    let g2 = trig(&mut t, scaled[1], scaled[2]);
    let g3 = trig(&mut t, scaled[2], scaled[0]);
    let s12 = t.bin(Op::Add, g1, g2);
    let sum = t.bin(Op::Add, s12, g3);
    let a = t.un(Op::Abs, sum);
    let wc = t.c(w);
    let sheet = t.bin(Op::Sub, a, wc);
    let out = t.bin(Op::Max, sheet, ball);
    t.finish(out)
}

struct Run {
    report: Value,
    nodes: Vec<f64>,
    elements: Vec<u32>,
}

fn run(name: &str, evaluator: &Evaluator, half: f64, voxel: f64, order: u8, targets: Value) -> Run {
    run_job(
        name,
        evaluator,
        json!({ "min": [-half, -half, -half], "max": [half, half, half], "voxel": voxel }),
        order,
        targets,
        1 << 26,
        5_000_000,
    )
}

fn run_job(name: &str, evaluator: &Evaluator, grid: Value, order: u8, targets: Value, lattice: u64, tets: u64) -> Run {
    let dir = std::env::temp_dir().join(format!("llull-field-tets-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let text = json!({ "op": "tets", "grid": grid, "order": order, "maxLatticeVertices": lattice, "maxTets": tets, "lengthScale": 1.0, "targets": targets })
        .to_string();
    let (mut out, mut outputs) = (Vec::new(), Vec::new());
    let report = tets_job(&dir, &text, evaluator, &mut out, &mut outputs).unwrap();
    let read = |file: &str| std::fs::read(dir.join(file)).unwrap_or_default();
    let nodes = read("nodes.f64").chunks_exact(8).map(|b| f64::from_le_bytes(b.try_into().unwrap())).collect();
    let elements = read("elements.u32").chunks_exact(4).map(|b| u32::from_le_bytes(b.try_into().unwrap())).collect();
    let _ = std::fs::remove_dir_all(&dir);
    Run { report, nodes, elements }
}

/// The job's own checks are clean (no open boundary face: conforming; no inverted, degenerate, folded or non-manifold element, no clipped
/// corner), and, recounted from the output files, every boundary edge is shared by exactly two boundary faces and no face is folded.
fn assert_valid(run: &Run, per_element: usize) {
    let q = &run.report["quality"];
    for key in ["open", "inverted", "degenerate", "folded", "nonManifold"] {
        assert_eq!(q[key], 0, "{key}: {q}");
    }
    assert_eq!(run.report["clippedCorners"], 0);
    let positions: Vec<[f64; 3]> = run.nodes.chunks_exact(3).map(|p| [p[0], p[1], p[2]]).collect();
    let tets: Vec<[u32; 4]> = run.elements.chunks_exact(per_element).map(|e| [e[0], e[1], e[2], e[3]]).collect();
    let (quality, boundary) = analyse(&positions, &tets, &vec![true; positions.len()], &mut |_, _| {});
    assert_eq!((quality.folded, quality.non_manifold, quality.inverted, quality.degenerate), (0, 0, 0, 0));
    let mut edges: HashMap<(u32, u32), u32> = HashMap::new();
    for face in &boundary {
        let c = face.corners;
        for (a, b) in [(c[0], c[1]), (c[1], c[2]), (c[2], c[0])] {
            *edges.entry((a.min(b), a.max(b))).or_default() += 1;
        }
    }
    assert!(edges.values().all(|&n| n == 2), "the boundary is a closed surface");
}

fn number(v: &Value, key: &str) -> f64 {
    v[key].as_f64().unwrap_or(f64::NAN)
}

#[test]
fn a_sphere_meshes_to_its_exact_volume_with_bounded_dihedrals() {
    let exact = 4.0 / 3.0 * PI * 1000.0;
    let linear = run("sphere1", &sphere(10.0), 14.0, 2.0, 1, json!([]));
    let quadratic = run("sphere2", &sphere(10.0), 14.0, 2.0, 2, json!([]));
    assert_valid(&linear, 4);
    assert_valid(&quadratic, 10);
    let (v1, v2) = (number(&linear.report, "volume"), number(&quadratic.report, "volume"));
    eprintln!(
        "sphere: linear {v1} ({:.4} %), quadratic {v2} ({:.4} %), exact {exact}",
        100.0 * (v1 / exact - 1.0),
        100.0 * (v2 / exact - 1.0)
    );
    eprintln!("sphere report: {}", quadratic.report);
    assert!(v1 < exact && (v1 / exact - 1.0).abs() < 0.0125, "straight tets inscribe the sphere (chord error ~ h^2): {v1} vs {exact}");
    assert!((v2 / exact - 1.0).abs() < 1e-3, "curved C3D10 follow it: {v2} vs {exact}");
    let q = &quadratic.report["quality"];
    assert!(number(q, "minDihedralDeg") > 9.0, "{q}");
    assert!(number(q, "maxDihedralDeg") < 165.0, "{q}");
    assert_eq!(quadratic.report["elements"], linear.report["elements"]);
    assert!(quadratic.report["curvedMidNodes"].as_u64().unwrap() > 0);
    // every corner on the boundary is on the sphere (within the root tolerance)
    let r_max = linear.nodes.chunks_exact(3).map(|p| (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt()).fold(0.0, f64::max);
    assert!(r_max <= 10.0 + 1e-9, "no node outside the sphere: {r_max}");
}

#[test]
fn a_box_meshes_exactly_and_its_end_face_resolves_without_its_neighbours() {
    let half = [10.0, 4.0, 3.0];
    let targets = json!([{ "key": "C_end", "facesNear": [[-10.0, 0.0, 0.0]] }, { "key": "P_tip", "pointsNear": [[10.0, 0.0, 0.0]] }]);
    let run = run("box", &cuboid(half), 13.0, 1.0, 2, targets);
    assert_valid(&run, 10);
    let exact = 8.0 * half[0] * half[1] * half[2];
    let v = number(&run.report, "volume");
    eprintln!("box: {v} vs {exact}; report {}", run.report["quality"]);
    assert!((v / exact - 1.0).abs() < 1e-9, "flat faces are cut exactly: {v}");
    let set = &run.report["sets"]["C_end"];
    let nodes: Vec<usize> = set["nodes"].as_array().unwrap().iter().map(|n| n.as_u64().unwrap() as usize).collect();
    assert!(!nodes.is_empty());
    for n in &nodes {
        assert!((run.nodes[3 * n] + 10.0).abs() < 1e-9, "node {n} of the end face is at x = -10, not on a side face");
    }
    let faces = set["faces"].as_array().unwrap();
    let area: f64 = faces
        .iter()
        .map(|f| {
            let (e, label) = (f[0].as_u64().unwrap() as usize, f[1].as_i64().unwrap());
            let corners = crate::tet_quality::CCX_FACES[(label - 1) as usize].1.map(|c| run.elements[10 * e + c] as usize);
            let p = corners.map(|v| [run.nodes[3 * v], run.nodes[3 * v + 1], run.nodes[3 * v + 2]]);
            let n = crate::tet_quality::cross(&[0, 1, 2].map(|i| p[1][i] - p[0][i]), &[0, 1, 2].map(|i| p[2][i] - p[0][i]));
            0.5 * (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt()
        })
        .sum();
    assert!((area - 4.0 * half[1] * half[2]).abs() < 1e-9, "the face set covers the end face exactly: {area}");
    let tip = run.report["sets"]["P_tip"]["nodes"][0].as_u64().unwrap() as usize;
    assert!((run.nodes[3 * tip] - 10.0).abs() < 1e-9);
}

#[test]
fn a_gyroid_sheet_stays_valid() {
    let run = run("gyroid", &gyroid_ball(1.0, 0.35, 6.0), 8.0, 0.4, 2, json!([]));
    assert_valid(&run, 10);
    eprintln!("gyroid report: {}", run.report);
    let q = &run.report["quality"];
    assert!(number(q, "minDihedralDeg") > 5.0, "{q}");
}

#[test]
fn the_mesh_is_bit_identical_across_runs_and_thread_counts() {
    let field = gyroid_ball(1.0, 0.35, 4.0);
    let job = |threads: usize, name: &str| {
        let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).build().unwrap();
        pool.install(|| {
            run(
                name,
                &field,
                6.0,
                0.5,
                2,
                json!([{ "key": "F", "facesNear": [[PI - 0.35f64.asin(), 0.0, 0.0]] }, { "key": "P", "pointsNear": [[1.0, 1.0, 1.0]] }]),
            )
        })
    };
    let (one, many, again) = (job(1, "det1"), job(4, "det4"), job(4, "det4b"));
    assert!(!one.elements.is_empty(), "{}", one.report);
    assert_eq!(one.nodes.iter().map(|v| v.to_bits()).collect::<Vec<_>>(), many.nodes.iter().map(|v| v.to_bits()).collect::<Vec<_>>());
    assert_eq!(one.elements, many.elements);
    assert_eq!(many.elements, again.elements);
    assert_eq!(one.report["sets"], many.report["sets"]);
    assert_eq!(number(&one.report, "volume").to_bits(), number(&many.report, "volume").to_bits());
}

#[test]
fn budgets_and_bad_targets_are_refused_by_name() {
    let field = sphere(5.0);
    let grid = json!({ "min": [-8.0, -8.0, -8.0], "max": [8.0, 8.0, 8.0], "voxel": 1.0 });
    let lattice = run_job("lattice", &field, grid.clone(), 1, json!([]), 100, 5_000_000);
    assert_eq!(lattice.report["refusal"]["code"], "FLL_IMPLICIT_MESH_TOO_LARGE");
    assert_eq!(lattice.report["refusal"]["samples"], 17 * 17 * 17 + 16 * 16 * 16);
    assert!(lattice.nodes.is_empty(), "nothing is written");
    let tets = run_job("tets", &field, grid.clone(), 1, json!([]), 1 << 26, 50);
    assert_eq!(tets.report["refusal"]["code"], "FLL_IMPLICIT_MESH_TOO_LARGE");
    assert_eq!(tets.report["refusal"]["limit"], 50);
    let edges = run_job("edges", &field, grid.clone(), 1, json!([{ "key": "E", "edgesNear": [[5.0, 0.0, 0.0]] }]), 1 << 26, 5_000_000);
    assert_eq!(edges.report["refusal"]["code"], "FEA_TARGET_UNRESOLVED");
    let far = run_job("far", &field, grid.clone(), 1, json!([{ "key": "F", "facesNear": [[0.0, 0.0, 7.5]] }]), 1 << 26, 5_000_000);
    assert_eq!(far.report["refusal"]["code"], "FEA_TARGET_UNRESOLVED");
    let empty = run_job("empty", &sphere(-1.0), grid, 1, json!([]), 1 << 26, 5_000_000);
    assert_eq!(empty.report["refusal"]["code"], "IMP_BODY_EMPTY");
}

#[test]
fn a_global_target_reports_the_nearest_node_and_its_distance() {
    let run =
        run("global", &sphere(5.0), 8.0, 1.0, 1, json!([{ "key": "P", "global": true, "pointsNear": [[0.0, 0.0, 0.0], [9.0, 0.0, 0.0]] }]));
    let near = &run.report["nearest"]["P"];
    let node = near["node"].as_u64().unwrap() as usize;
    let p = [run.nodes[3 * node], run.nodes[3 * node + 1], run.nodes[3 * node + 2]];
    let d = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt();
    assert!((number(near, "distance") - d).abs() < 1e-12, "the origin is the nearer point");
    assert!(run.report["sets"].as_object().unwrap().is_empty());
}

/// `field` rotated: the field evaluated at R^T p, R = rotation about z by `about_z` then about x by `about_x` (radians).
fn rotated_cuboid(half: [f64; 3], about_z: f64, about_x: f64) -> (Evaluator, [[f64; 3]; 3]) {
    let (cz, sz, cx, sx) = (about_z.cos(), about_z.sin(), about_x.cos(), about_x.sin());
    // rows of R^T: the body axes in world coordinates
    let axes = [[cz, sz, 0.0], [-sz * cx, cz * cx, sx], [sz * sx, -cz * sx, cx]];
    let mut t = Tape::new();
    let world = [t.x(), t.y(), t.z()];
    let mut parts = Vec::new();
    for (axis, row) in axes.iter().enumerate() {
        let mut sum = None;
        for (k, &w) in world.iter().enumerate() {
            let c = t.c(row[k]);
            let term = t.bin(Op::Mul, w, c);
            sum = Some(match sum {
                None => term,
                Some(acc) => t.bin(Op::Add, acc, term),
            });
        }
        let a = t.un(Op::Abs, sum.unwrap_or(0));
        let h = t.c(half[axis]);
        parts.push(t.bin(Op::Sub, a, h));
    }
    let m = t.bin(Op::Max, parts[0], parts[1]);
    let out = t.bin(Op::Max, m, parts[2]);
    (t.finish(out), axes)
}

#[test]
fn a_rotated_box_keeps_its_faces_apart_with_edges_off_the_lattice() {
    let half = [8.0, 4.0, 3.0];
    let (field, axes) = rotated_cuboid(half, 0.5, 0.35);
    let centre = axes[0].map(|c| c * half[0]);
    let run = run("rotated", &field, 12.0, 0.75, 2, json!([{ "key": "F", "facesNear": [centre] }]));
    assert_valid(&run, 10);
    let exact = 8.0 * half[0] * half[1] * half[2];
    let v = number(&run.report, "volume");
    eprintln!("rotated box: {v} vs {exact} ({:.3} %), {}", 100.0 * (v / exact - 1.0), run.report["quality"]);
    assert!(v < exact && (v / exact - 1.0).abs() < 0.02, "edges and corners off the lattice are cut, by less than 2 %: {v}");
    // the face set stays at the +x face: every node within one spacing of its plane (the cut strip along its edges), most on it
    let nodes = run.report["sets"]["F"]["nodes"].as_array().unwrap();
    assert!(nodes.len() > 20);
    let along = |n: &Value| {
        let n = n.as_u64().unwrap() as usize;
        (0..3).map(|k| run.nodes[3 * n + k] * axes[0][k]).sum::<f64>()
    };
    assert!(nodes.iter().all(|n| (along(n) - half[0]).abs() <= 0.75), "every node within one spacing of the +x face");
    let on_plane = nodes.iter().filter(|n| (along(n) - half[0]).abs() < 1e-6).count();
    assert!(on_plane * 10 >= nodes.len() * 8, "{on_plane} of {} nodes on the plane", nodes.len());
}

#[test]
fn a_field_clipped_by_a_box_meshes_to_the_clipped_volume_without_clipped_corners() {
    let g = gyroid_ball(1.0, 0.35, 100.0);
    // the same sheet, unclipped, fills its lattice to the border: corners there are held outside and counted
    let bare = run("bare", &g, 4.0, 0.4, 1, json!([]));
    assert!(bare.report["clippedCorners"].as_u64().unwrap() > 0, "{}", bare.report["clippedCorners"]);
    // clipped by the box [-3, 3]^3 (what implicitBodyField builds for explicit bounds), meshed on the bounds padded by 2 spacings
    let mut t = Tape::new();
    let sheet = {
        let kc = t.c(1.0);
        let (x, y, z) = (t.x(), t.y(), t.z());
        let p = [x, y, z].map(|q| t.bin(Op::Mul, q, kc));
        let trig = |t: &mut Tape, a: i64, b: i64| {
            let s = t.un(Op::Sin, a);
            let c = t.un(Op::Cos, b);
            t.bin(Op::Mul, s, c)
        };
        let (g1, g2, g3) = (trig(&mut t, p[0], p[1]), trig(&mut t, p[1], p[2]), trig(&mut t, p[2], p[0]));
        let s12 = t.bin(Op::Add, g1, g2);
        let sum = t.bin(Op::Add, s12, g3);
        let a = t.un(Op::Abs, sum);
        let w = t.c(0.35);
        t.bin(Op::Sub, a, w)
    };
    let (x, y, z) = (t.x(), t.y(), t.z());
    let three = t.c(3.0);
    let faces = [x, y, z].map(|q| {
        let a = t.un(Op::Abs, q);
        t.bin(Op::Sub, a, three)
    });
    let b01 = t.bin(Op::Max, faces[0], faces[1]);
    let boxed = t.bin(Op::Max, b01, faces[2]);
    let out = t.bin(Op::Max, sheet, boxed);
    let clipped = t.finish(out);
    let run = run("clipped", &clipped, 3.5, 0.1, 2, json!([]));
    assert_valid(&run, 10);
    // reference: midpoint quadrature of the clipped field on a 0.02 grid; the mesh error is second order in the spacing (the sharp creases
    // where the sheet meets the box are cut by a chord): -1.04 % at 0.2, -0.25 % at 0.1
    let mut registers = vec![0.0; clipped.instrs.len()];
    let (n, h) = (300usize, 0.02);
    let mut inside = 0u64;
    for k in 0..n {
        for j in 0..n {
            for i in 0..n {
                let p = [i, j, k].map(|c| -3.0 + (c as f64 + 0.5) * h);
                if clipped.value_at(&mut registers, p[0], p[1], p[2]) < 0.0 {
                    inside += 1;
                }
            }
        }
    }
    let reference = inside as f64 * h * h * h;
    let v = number(&run.report, "volume");
    eprintln!("clipped gyroid: {v} vs quadrature {reference} ({:.3} %)", 100.0 * (v / reference - 1.0));
    assert!((v / reference - 1.0).abs() < 0.005, "{v} vs {reference}");
}

#[test]
fn a_neighbour_that_splits_a_shared_quadrilateral_the_other_way_leaves_open_faces() {
    crate::stuffing::test_flip::arm();
    let cracked = run("crack", &sphere(10.0), 14.0, 2.0, 1, json!([]));
    assert!(!crate::stuffing::test_flip::armed(), "a pyramid base was flipped");
    assert!(cracked.report["quality"]["open"].as_u64().unwrap() > 0, "{}", cracked.report["quality"]);
    // the open count is what sees it: the faces of the crack are boundary faces with a corner inside the body
    let positions: Vec<[f64; 3]> = cracked.nodes.chunks_exact(3).map(|p| [p[0], p[1], p[2]]).collect();
    let tets: Vec<[u32; 4]> = cracked.elements.chunks_exact(4).map(|e| [e[0], e[1], e[2], e[3]]).collect();
    let (_, boundary) = analyse(&positions, &tets, &vec![true; positions.len()], &mut |_, _| {});
    let mut edges: HashMap<(u32, u32), u32> = HashMap::new();
    for face in &boundary {
        let c = face.corners;
        for (a, b) in [(c[0], c[1]), (c[1], c[2]), (c[2], c[0])] {
            *edges.entry((a.min(b), a.max(b))).or_default() += 1;
        }
    }
    let doubled = edges.values().filter(|&&n| n == 2).count();
    eprintln!(
        "cracked sphere: {} open faces, {doubled} of {} boundary edges shared by two faces",
        cracked.report["quality"]["open"],
        edges.len()
    );
    let whole = run("whole", &sphere(10.0), 14.0, 2.0, 1, json!([]));
    assert_eq!(whole.report["quality"]["open"], 0);
}

#[test]
fn the_quality_scan_and_the_second_order_pass_report_progress() {
    let run = run("progress", &gyroid_ball(1.0, 0.35, 6.0), 8.0, 0.4, 1, json!([]));
    let positions: Vec<[f64; 3]> = run.nodes.chunks_exact(3).map(|p| [p[0], p[1], p[2]]).collect();
    let tets: Vec<[u32; 4]> = run.elements.chunks_exact(4).map(|e| [e[0], e[1], e[2], e[3]]).collect();
    assert!(tets.len() * 4 > 2 * (1 << 16), "enough faces for scan reports: {}", tets.len());
    let mut quality_reports = Vec::new();
    let (_, boundary) = analyse(&positions, &tets, &vec![true; positions.len()], &mut |d, n| quality_reports.push((d, n)));
    assert!(quality_reports.len() >= 5, "stages and scan chunks: {quality_reports:?}");
    let mut order2_reports = 0;
    let field = gyroid_ball(1.0, 0.35, 6.0);
    let _ = crate::tet_order2::order2(&field, &positions, &tets, &boundary, &mut |_, _| order2_reports += 1);
    assert!(order2_reports >= 5, "stages, projection chunks and undo passes: {order2_reports}");
}

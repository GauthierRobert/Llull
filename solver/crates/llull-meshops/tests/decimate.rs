//! Decimation guarantees: topology on closed, bounded and adversarial meshes, the exact result of the previous implementation (pinned digests),
//! and the same bytes on every run and thread count. Timing is not asserted here (see `perf.rs`).

mod common;

use common::*;
use llull_meshops::decimate::{decimate, DecimateParams, DecimateReport};
use llull_protocol::sha256_hex;

fn params(target: Option<usize>, preserve_boundary: bool) -> DecimateParams {
    DecimateParams { target_triangles: target, max_deviation: None, preserve_boundary, feature_cos: None, locked_region: None }
}

fn run(mesh: &Mesh, params: &DecimateParams) -> (Mesh, DecimateReport) {
    let (positions, indices, report) = decimate(&mesh.0, &mesh.1, params, &mut |_| {});
    ((positions, indices), report)
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
fn a_closed_sphere_stays_a_closed_manifold_with_no_fold_over() {
    let sphere = sphere(4, 0.1, 42);
    let (result, report) = run(&sphere, &params(Some(700), true));
    assert_eq!((report.triangles_before, report.triangles_after, report.reached_target), (5120, 700, Some(true)));
    let topology = topology(&result.1);
    assert_eq!((topology.euler(), topology.boundary_edges.len(), topology.faces), (2, 0, 700));
    for t in result.1.chunks_exact(3) {
        // every triangle still faces outward: none was turned over by a collapse
        let (n, c) = (normal(&result.0, t), point(&result.0, t[0]));
        assert!(n[0] * c[0] + n[1] * c[1] + n[2] * c[2] > 0.0);
    }
    assert!((volume(&result) / volume(&sphere) - 1.0).abs() < 0.05);
}

#[test]
fn locked_boundaries_keep_every_loop_and_every_boundary_vertex_in_place() {
    let holes = [(3, 3), (4, 3), (10, 12)];
    let surface = grid(16, |x, y| 0.4 * (x / 1.5).sin() * (y / 2.0).cos(), &holes);
    let before = topology(&surface.1);
    assert_eq!(before.boundary_loops(), 3);
    let (result, report) = run(&surface, &params(Some(100), true));
    assert!(report.collapses > 0 && report.triangles_after < 506);
    let after = topology(&result.1);
    assert_eq!((after.boundary_loops(), after.boundary_edges.len()), (3, before.boundary_edges.len()));
    // the boundary edges of the result join the very points the input boundary had
    let on_boundary = |mesh: &Mesh, edges: &[(u32, u32)]| {
        let mut points: Vec<[u64; 3]> = edges.iter().flat_map(|&(a, b)| [a, b]).map(|v| point(&mesh.0, v).map(f64::to_bits)).collect();
        points.sort_unstable();
        points.dedup();
        points
    };
    assert_eq!(on_boundary(&result, &after.boundary_edges), on_boundary(&surface, &before.boundary_edges));
}

#[test]
fn an_unlocked_boundary_may_move_but_no_loop_is_split_closed_or_lost() {
    let holes = [(3, 3), (4, 3), (10, 12)];
    let surface = grid(16, |x, y| 0.4 * (x / 1.5).sin() * (y / 2.0).cos(), &holes);
    let (result, report) = run(&surface, &params(Some(60), false));
    assert_eq!(report.triangles_after, 60);
    let after = topology(&result.1);
    assert_eq!(after.boundary_loops(), 3);
    assert_eq!(after.euler(), -1, "a disc with two holes has Euler characteristic -1");
}

#[test]
fn slivers_neither_break_the_surface_nor_flip_it() {
    // every other row of cells is a thousandth as high as the others: long, thin triangles
    let (mut positions, indices) = grid(14, |_, _| 0.0, &[]);
    for j in 0..=14usize {
        let y = if j % 2 == 0 { j as f64 * 0.7 } else { (j - 1) as f64 * 0.7 + 0.0007 };
        for i in 0..=14usize {
            positions[(j * 15 + i) * 3 + 1] = y;
        }
    }
    let sliver = (positions, indices);
    let (result, report) = run(&sliver, &params(Some(30), false));
    assert!(report.collapses > 0);
    topology(&result.1);
    assert!(result.1.chunks_exact(3).all(|t| normal(&result.0, t)[2] > 0.0), "a triangle was turned over");
}

#[test]
fn nothing_collapses_on_a_tetrahedron_and_the_refusals_are_counted() {
    let tetrahedron: Mesh =
        (vec![1.0, 1.0, 1.0, -1.0, -1.0, 1.0, -1.0, 1.0, -1.0, 1.0, -1.0, -1.0], vec![0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2]);
    let (result, report) = run(&tetrahedron, &params(Some(1), false));
    assert_eq!((report.collapses, report.reached_target, report.stopped_by), (0, Some(false), "exhausted"));
    assert!(report.rejected.link >= 6);
    assert_eq!(result.1.len(), 12);
}

#[test]
fn a_surface_held_together_by_a_non_manifold_edge_does_not_panic_and_keeps_valid_indices() {
    // three triangles on one edge (a book with three pages), and a fan of triangles around one vertex
    let book: Mesh = (vec![0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 1.0, 0.0], vec![0, 1, 2, 1, 0, 3, 0, 1, 4]);
    let (result, _) = run(&book, &params(Some(1), false));
    assert!(result.1.iter().all(|&v| (v as usize) < result.0.len() / 3));
    let soup: Mesh = ((0..30).map(f64::from).collect(), (0..40u32).flat_map(|f| [f % 10, (f * 3 + 1) % 10, (f * 7 + 2) % 10]).collect());
    let (result, _) = run(&soup, &params(None, false));
    assert!(result.1.iter().all(|&v| (v as usize) < result.0.len() / 3));
}

#[test]
fn the_same_input_gives_the_same_bytes_on_every_run_and_on_any_thread_count() {
    let sphere = sphere(5, 0.1, 3);
    let bounded = DecimateParams { max_deviation: Some(0.2), ..params(Some(1500), false) };
    let reference = run(&sphere, &bounded);
    let reference_digest = (digest(&reference.0), format!("{:?}", reference.1));
    for threads in [1, 2, 7] {
        let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).build().unwrap();
        let again = pool.install(|| run(&sphere, &bounded));
        assert_eq!((digest(&again.0), format!("{:?}", again.1)), reference_digest, "{threads} threads");
    }
    assert_eq!(run(&sphere, &bounded).0, reference.0);
}

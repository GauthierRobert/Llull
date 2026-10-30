//! The self-intersection search of `analyze` (twin of `findSelfIntersections`, DES-7c step 7 slice 4): closed-form counts (a plus, contacts that do not count, a large
//! triangle pierced by many small ones), interpenetrating spheres, the same answer on any thread count, hostile input, and the job contract (stages, the cost limit).
//! Bit-identity with the TypeScript engine is proven by `server/tests/meshopsNativeSelfIntersect.test.ts` and pinned by `ts_pins.rs`.

mod common;

use common::*;
use llull_meshops::run;
use llull_meshops::self_intersect::{find_self_intersections, Costly, Found, CANDIDATE_LIMIT};
use serde_json::{json, Value};

fn search(mesh: &Mesh, max_listed: usize) -> Found {
    find_self_intersections(&mesh.0, &mesh.1, max_listed, CANDIDATE_LIMIT).unwrap()
}

/// `meshes` merged into one (vertices not shared).
fn merged(meshes: &[Mesh]) -> Mesh {
    let (mut positions, mut indices) = (Vec::new(), Vec::new());
    for part in meshes {
        let offset = (positions.len() / 3) as u32;
        positions.extend_from_slice(&part.0);
        indices.extend(part.1.iter().map(|v| v + offset));
    }
    (positions, indices)
}

fn moved(mesh: &Mesh, by: [f64; 3]) -> Mesh {
    (mesh.0.chunks_exact(3).flat_map(|p| [p[0] + by[0], p[1] + by[1], p[2] + by[2]]).collect(), mesh.1.clone())
}

/// The `report.json` of a finished analysis job (it writes no result mesh).
fn report_of(dir: &std::path::Path) -> Value {
    serde_json::from_slice(&std::fs::read(dir.join("report.json")).unwrap()).unwrap()
}

fn analyze_job(extra: Value) -> Value {
    let mut params = json!({ "maxListed": 5, "weldTolerance": 0, "selfIntersections": true });
    params.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    json!({ "op": "analyze", "params": params })
}

#[test]
fn two_triangles_through_each_other_are_one_pair_and_contacts_are_none() {
    let plus: Mesh = (
        vec![
            0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 1.0, 0.0, 2.0, 1.0, -1.0, 0.5, 1.0, 1.0, 0.5, 1.0, 0.0, 3.0, 50.0, 0.0, 0.0, 51.0, 0.0, 0.0,
            50.0, 1.0, 0.0,
        ],
        vec![0, 1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert_eq!(search(&plus, 5), Found { count: 1, pairs: vec![[0, 1]] });
    // a shared edge, a corner touching the interior of the other face, a coplanar overlap: none cross transversally
    let shared: Mesh = (vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 1.0], vec![0, 1, 2, 1, 3, 2]);
    let touching: Mesh =
        (vec![0.0, 0.0, 0.0, 4.0, 0.0, 0.0, 0.0, 4.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 2.0, 2.0, 1.0, 2.0], vec![0, 1, 2, 3, 4, 5]);
    let coplanar: Mesh =
        (vec![0.0, 0.0, 0.0, 4.0, 0.0, 0.0, 0.0, 4.0, 0.0, 1.0, 1.0, 0.0, 5.0, 1.0, 0.0, 1.0, 5.0, 0.0], vec![0, 1, 2, 3, 4, 5]);
    for (name, mesh) in [("shared edge", &shared), ("touching corner", &touching), ("coplanar overlap", &coplanar)] {
        assert_eq!(search(mesh, 5), Found { count: 0, pairs: vec![] }, "{name}");
    }
    // a repeated corner (no area) and an empty mesh
    assert_eq!(search(&(vec![0.0; 9], vec![0, 0, 1]), 5).count, 0);
    assert_eq!(search(&(vec![], vec![]), 5), Found { count: 0, pairs: vec![] });
}

#[test]
fn a_large_triangle_pierced_by_many_small_ones_counts_each() {
    // one big triangle in z = 0 (over 64 cells of the small ones), then 100 small stakes through its interior
    let mut positions = vec![-1000.0, -1000.0, 0.0, 1000.0, -1000.0, 0.0, 0.0, 1000.0, 0.0];
    let mut indices = vec![0u32, 1, 2];
    for k in 0..100 {
        let (x, y) = ((k % 10) as f64 * 3.0 - 15.0, (k / 10) as f64 * 3.0 - 15.0);
        let base = (positions.len() / 3) as u32;
        positions.extend([x, y, -1.0, x + 0.1, y, -1.0, x, y, 1.0]);
        indices.extend([base, base + 1, base + 2]);
    }
    let found = search(&(positions, indices), 3);
    assert_eq!(found, Found { count: 100, pairs: vec![[0, 1], [0, 2], [0, 3]] });
}

#[test]
fn interpenetrating_spheres_count_the_same_pairs_whatever_is_listed_or_how_many_threads_run() {
    let ball = sphere(4, 0.0, 1);
    assert_eq!(search(&ball, 5).count, 0, "a clean sphere does not cross itself");
    let both = merged(&[ball.clone(), moved(&ball, [6.0, 0.0, 0.0]), moved(&ball, [0.0, 3.0, 4.0])]);
    let all = search(&both, usize::MAX >> 1);
    assert!(all.count > 100, "{}", all.count);
    assert_eq!(all.pairs.len(), all.count);
    assert!(all.pairs.windows(2).all(|w| w[0] < w[1]) && all.pairs.iter().all(|p| p[0] < p[1]));
    let listed = search(&both, 7);
    assert_eq!((listed.count, listed.pairs.as_slice()), (all.count, &all.pairs[..7]));
    assert_eq!(search(&both, 0).pairs, Vec::<[usize; 2]>::new());
    for threads in [1, 2, 7] {
        let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).build().unwrap();
        assert_eq!(pool.install(|| search(&both, 7)), listed, "{threads} threads");
    }
}

#[test]
fn a_search_past_the_candidate_limit_is_costly_and_a_generous_one_is_not() {
    let ball = sphere(3, 0.0, 1);
    let both = merged(&[ball.clone(), moved(&ball, [4.0, 0.0, 0.0])]);
    assert_eq!(find_self_intersections(&both.0, &both.1, 5, 100).unwrap_err(), Costly);
    assert!(find_self_intersections(&both.0, &both.1, 5, 1_000_000).is_ok());
}

#[test]
fn the_job_searches_after_the_weld_reports_the_pairs_and_the_stage() {
    let ball = sphere(3, 0.0, 1);
    let both = merged(&[ball.clone(), moved(&ball, [5.0, 0.0, 0.0])]);
    // as a soup: the weld brings the vertices back, so the pairs are those of the welded mesh
    let soup: Mesh = (both.1.iter().flat_map(|&v| point(&both.0, v)).collect(), (0..both.1.len() as u32).collect());
    let dir = folder("pairs-job");
    write_job(&dir, &analyze_job(json!({})), &soup);
    let mut out = Vec::new();
    run(&dir, &mut out).unwrap();
    let summary = report_of(&dir);
    let direct = search(&both, 5);
    assert_eq!(summary["analysis"]["selfIntersectionPairs"], json!(direct.count));
    assert_eq!(summary["analysis"]["selfIntersections"], json!(direct.pairs));
    let events: Vec<Value> = String::from_utf8(out).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    let mut stages: Vec<&str> = events.iter().filter_map(|e| e["stage"].as_str()).collect();
    stages.dedup();
    assert_eq!(stages, ["read", "analyze", "self_intersections", "write"]);
    let fractions: Vec<f64> = events.iter().map(|e| e["fraction"].as_f64().unwrap()).collect();
    assert!(fractions.windows(2).all(|p| p[0] <= p[1]), "{fractions:?}");
    // not asked: null and no stage
    write_job(&dir, &analyze_job(json!({ "selfIntersections": false })), &soup);
    let mut out = Vec::new();
    run(&dir, &mut out).unwrap();
    assert_eq!(report_of(&dir)["analysis"]["selfIntersectionPairs"], Value::Null);
    assert!(!String::from_utf8(out).unwrap().contains("self_intersections"));
}

#[test]
fn the_job_refuses_a_search_past_its_candidate_limit_with_a_stable_code() {
    let ball = sphere(3, 0.0, 1);
    let both = merged(&[ball.clone(), moved(&ball, [4.0, 0.0, 0.0])]);
    let dir = folder("costly-job");
    write_job(&dir, &analyze_job(json!({ "maxCandidates": 50 })), &both);
    let error = run(&dir, &mut std::io::sink()).unwrap_err();
    assert_eq!(error.code, "SELF_INTERSECTION_TOO_COSTLY");
    assert!(error.message.contains("more than 50 candidate pairs"), "{}", error.message);
}

#[test]
fn hostile_meshes_do_not_panic_whether_or_not_they_cross() {
    let mut next = stream(77);
    for case in 0..150 {
        let vertices = 3 + (next() * 20.0) as usize;
        let spread = [1e-9, 1.0, 1e3, 1e50, 1e99][case % 5];
        let positions: Vec<f64> = (0..vertices * 3).map(|_| (next() * 2.0 - 1.0) * spread * if next() < 0.2 { 0.0 } else { 1.0 }).collect();
        let indices: Vec<u32> = (0..(1 + (next() * 40.0) as usize) * 3).map(|_| (next() * vertices as f64) as u32).collect();
        let dir = folder("hostile-pairs");
        write_job(&dir, &analyze_job(json!({ "maxListed": case % 4 })), &(positions, indices.clone()));
        match run(&dir, &mut std::io::sink()) {
            Ok(_) => {
                let analysis = report_of(&dir)["analysis"].clone();
                let faces = indices.len() / 3;
                let count = analysis["selfIntersectionPairs"].as_u64().unwrap() as usize;
                let pairs = analysis["selfIntersections"].as_array().unwrap();
                assert_eq!(pairs.len(), count.min(case % 4), "case {case}");
                assert!(pairs.iter().all(|p| p[0].as_u64() < p[1].as_u64() && (p[1].as_u64().unwrap() as usize) < faces), "case {case}");
            }
            Err(error) => assert_eq!(error.code, "NATIVE_JOB_INPUT", "case {case}: {}", error.message),
        }
    }
}

#[test]
fn a_pair_sharing_a_vertex_is_never_a_crossing_even_when_an_edge_pierces_the_other() {
    // B shares the corner (0, 0, 0) with A and its far edge passes through the interior of A
    let mesh: Mesh = (vec![0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 1.0, 0.0, 2.0, 1.0, -1.0, 1.0, 1.0, 1.0, 1.0], vec![0, 1, 2, 0, 3, 4]);
    assert_eq!(search(&mesh, 5).count, 0);
    // the same B with its own corner instead of the shared one crosses
    let apart: Mesh = (mesh.0.iter().copied().chain([0.0, 0.0, -0.5]).collect(), vec![0, 1, 2, 5, 3, 4]);
    assert_eq!(search(&apart, 5), Found { count: 1, pairs: vec![[0, 1]] });
}

#[test]
fn the_lowest_pairs_are_listed_even_when_a_later_face_pairs_with_an_early_large_one() {
    // face 3 is a big triangle (large), faces 5 and 6 cross like a plus, and 100 stakes (faces 700 on) pierce the big one: the lowest pairs are [3, 700 ..]
    let mut positions = Vec::new();
    let mut indices = Vec::new();
    let mut add = |tri: [f64; 9]| {
        let base = (positions.len() / 3) as u32;
        positions.extend(tri);
        indices.extend([base, base + 1, base + 2]);
    };
    let far = |k: usize| {
        let x = 5000.0 + k as f64 * 10.0;
        [x, 5000.0, 5000.0, x + 1.0, 5000.0, 5000.0, x, 5001.0, 5000.0]
    };
    for k in 0..3 {
        add(far(k));
    }
    add([-1000.0, -1000.0, 0.0, 1000.0, -1000.0, 0.0, 0.0, 1000.0, 0.0]);
    add(far(3));
    add([20000.0, 0.0, 0.0, 20002.0, 0.0, 0.0, 20001.0, 0.0, 2.0]);
    add([20001.0, -1.0, 0.5, 20001.0, 1.0, 0.5, 20001.0, 0.0, 3.0]);
    for k in 7..700 {
        add(far(k));
    }
    for k in 0..100 {
        let (x, y) = ((k % 10) as f64 * 3.0 - 15.0, (k / 10) as f64 * 3.0 - 15.0);
        add([x, y, -1.0, x + 0.1, y, -1.0, x, y, 1.0]);
    }
    let found = search(&(positions, indices), 3);
    assert_eq!(found, Found { count: 101, pairs: vec![[3, 700], [3, 701], [3, 702]] });
}

#[test]
fn a_search_whose_candidates_pass_the_limit_is_costly_even_without_large_faces() {
    let ball = sphere(3, 0.0, 1);
    let both = merged(&[ball.clone(), moved(&ball, [4.0, 0.0, 0.0])]);
    assert!(!both.1.is_empty());
    // no large face here: only the count of candidates examined can end it
    assert!(find_self_intersections(&both.0, &both.1, 5, 10).is_err());
}

/// `piled` faces of size `size` at the origin (each spans 27 to 64 grid cells) among four times as many tiny ones far apart, which fix the cell size.
fn piled(piles: usize, size: f64) -> Mesh {
    let (mut positions, mut indices) = (Vec::new(), Vec::new());
    let mut add = |tri: [f64; 9]| {
        let base = (positions.len() / 3) as u32;
        positions.extend(tri);
        indices.extend([base, base + 1, base + 2]);
    };
    for k in 0..piles {
        let e = k as f64 * size * 1e-9;
        add([e, 0.0, 0.0, size + e, 0.0, 0.0, 0.0, size + e, size]);
    }
    for k in 0..4 * piles {
        let x = 100.0 * size + k as f64 * 10.0 * size;
        add([x, 0.0, 0.0, x + 1e-9 * size, 0.0, 0.0, x, 1e-9 * size, 0.0]);
    }
    (positions, indices)
}

#[test]
fn the_limit_counts_the_grid_entries_scanned_not_only_the_pairs_tested() {
    // 100 piled faces: 4,950 pairs once deduplicated, but each face scans the whole pile in each of its 27 or more cells
    let pile = piled(100, 1.0);
    assert!(find_self_intersections(&pile.0, &pile.1, 5, 20_000).is_err(), "the scan of the cells passes 20,000 entries");
    let found = find_self_intersections(&pile.0, &pile.1, 5, 100_000_000).unwrap();
    assert_eq!(found.pairs.len().min(5), found.pairs.len());
    // the job says so with the stable code
    let dir = folder("scan-limit");
    write_job(&dir, &analyze_job(json!({ "maxCandidates": 20_000 })), &pile);
    assert_eq!(run(&dir, &mut std::io::sink()).unwrap_err().code, "SELF_INTERSECTION_TOO_COSTLY");
}

#[test]
fn a_tiny_triangle_far_from_the_rest_ends_and_is_counted_like_any_other() {
    // cell indices past 2^53 (the oracle looped forever on them): 200 tiny faces at the origin and a crossing pair at 1e17
    let size = 100.0;
    let mut mesh: Mesh = (Vec::new(), Vec::new());
    for k in 0..200 {
        let x = k as f64 * 1e-3;
        mesh.0.extend([x, 0.0, 0.0, x + 1e-6, 0.0, 0.0, x, 1e-6, 0.0]);
    }
    let x = 1e17;
    mesh.0.extend([x, 0.0, 0.0, x + 2.0 * size, 0.0, 0.0, x + size, 0.0, 2.0 * size]);
    mesh.0.extend([x + size, -size, size / 2.0, x + size, size, size / 2.0, x + size, 0.0, 3.0 * size]);
    mesh.1 = (0..606).collect();
    assert_eq!(search(&mesh, 5), Found { count: 1, pairs: vec![[200, 201]] });
    let three: Mesh = (
        [
            0.0,
            0.0,
            0.0,
            1e-6,
            0.0,
            0.0,
            0.0,
            1e-6,
            0.0,
            1.0,
            0.0,
            0.0,
            1.0,
            1e-6,
            0.0,
            1.0 + 1e-6,
            0.0,
            0.0,
            1e11,
            0.0,
            0.0,
            1e11 + 1e-3,
            0.0,
            0.0,
            1e11,
            1e-3,
            0.0,
        ]
        .to_vec(),
        (0..9).collect(),
    );
    assert_eq!(search(&three, 5).count, 0);
}

#[test]
fn meshes_that_mix_tiny_faces_with_far_ones_end_and_agree_with_a_search_made_in_pieces() {
    // tiny faces near the origin beside tiny faces at 1e11 to 1e30: cells past 2^53 must neither hang nor change the count
    let mut next = stream(5);
    for case in 0..40 {
        let far = [1e11, 1e15, 1e17, 1e20, 1e30][case % 5];
        let mut positions = Vec::new();
        for _ in 0..60 {
            let (x, y, z) = (next(), next(), next());
            positions.extend([x, y, z, x + 1e-3, y, z, x, y + 1e-3, z + 1e-3 * next()]);
        }
        // far faces large enough to be resolved at that magnitude (the spacing of doubles there is far * 2.2e-16)
        let size = far * 1e-14;
        for _ in 0..6 {
            let (x, y, z) = (far * (1.0 + next()), far * next(), far * next());
            positions.extend([x, y, z, x + size, y, z, x, y + size, z + size * next()]);
        }
        let faces = positions.len() / 9;
        let mesh: Mesh = (positions, (0..faces as u32 * 3).collect());
        let whole = search(&mesh, 10);
        // the near faces and the far faces searched alone give their own pairs, and the mix adds none (they never touch)
        let near_only: Mesh = (mesh.0[..60 * 9].to_vec(), (0..180).collect());
        let far_only: Mesh = (mesh.0[60 * 9..].to_vec(), (0..18).collect());
        assert_eq!(whole.count, search(&near_only, 10).count + search(&far_only, 10).count, "case {case}");
    }
}

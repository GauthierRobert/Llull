//! Speed gate of the native decimation (07 MSH, TECHNICAL_SPEC 13.5 and 13.10): 1 310 720 triangles to 100 000 and their deviation, in 10 s.
//! Ignored in the normal run (a timing assertion depends on the machine and on a release build); run it with
//! `cargo test --release -p llull-meshops --test perf -- --ignored --nocapture` and read the per-stage times it prints.

mod common;

use common::sphere;
use llull_meshops::decimate::{decimate, DecimateParams};
use llull_meshops::deviation::deviation;
use std::time::Instant;

/// The budget of the spec for `decimate_mesh` on 1.3 M triangles. The measured time is about half of it on the reference machine (13.10).
const BUDGET_SECONDS: f64 = 10.0;

#[test]
#[ignore = "timing gate: needs a release build (see the module doc)"]
fn decimating_1_3_million_triangles_to_100_000_with_its_deviation_fits_the_budget() {
    let (positions, indices) = sphere(8, 0.1, 42);
    assert_eq!(indices.len() / 3, 1_310_720);
    let params = DecimateParams {
        target_triangles: Some(100_000),
        max_deviation: None,
        preserve_boundary: true,
        feature_cos: None,
        locked_region: None,
    };
    let started = Instant::now();
    let (out_positions, out_indices, report) = decimate(&positions, &indices, &params, &mut |_| {});
    let decimated = started.elapsed().as_secs_f64();
    let measured = deviation((&positions, &indices), (&out_positions, &out_indices), 20_000).expect("both meshes have triangles");
    let total = started.elapsed().as_secs_f64();
    eprintln!(
        "decimate {decimated:.2} s, deviation {:.2} s, total {total:.2} s; {} collapses, {} triangles, forward max {:.4}, mean {:.4}",
        total - decimated,
        report.collapses,
        report.triangles_after,
        measured.forward_max,
        measured.mean
    );
    assert_eq!(report.triangles_after, 100_000);
    assert!(total < BUDGET_SECONDS, "{total:.2} s against a budget of {BUDGET_SECONDS} s");
}

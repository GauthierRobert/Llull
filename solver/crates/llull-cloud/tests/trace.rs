//! VC-SCN-22 (ELB-A: 2 straights + 1 bend, r ±1 mm, R ±10 mm, angle ±1°, PI ±5 mm) and seeded synthetic pipes of known geometry: noisy
//! straights and bends, a one-sided scan, an S bend, a reducer, clutter, failure codes, the op job and determinism.

mod common;

use common::{csv, json, temp_dir, vec3};
use llull_cloud::asset;
use llull_cloud::fit::trace::{trace, TraceSettings};
use llull_cloud::fit::FitSettings;
use llull_cloud::kdtree::Rng;
use llull_cloud::linalg::{add, cross, dot, norm, scale, sub, unit};
use llull_cloud::read::{read, ImportOptions};

type V = [f64; 3];

fn gauss(rng: &mut Rng) -> f64 {
    let (a, b) = (rng.unit().max(1e-12), rng.unit());
    (-2.0 * a.ln()).sqrt() * (std::f64::consts::TAU * b).cos()
}

/// Surface points of a tube of radius `r` around a centreline sampler `centre(s) -> (point, tangent)`, `s` in [0, 1]; `arc` limits the
/// angle around the axis (a one-sided scan), `sigma` is the radial noise.
fn tube(rng: &mut Rng, n: usize, r: f64, sigma: f64, arc: (f64, f64), centre: impl Fn(f64) -> (V, V)) -> Vec<V> {
    (0..n)
        .map(|_| {
            let (c, t) = centre(rng.unit());
            let helper = if t[0].abs() < 0.9 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
            let u = unit(&cross(&t, &helper)).unwrap();
            let w = cross(&t, &u);
            let theta = arc.0 + (arc.1 - arc.0) * rng.unit();
            let rad = r + sigma * gauss(rng);
            add(&c, &add(&scale(&u, rad * theta.cos()), &scale(&w, rad * theta.sin())))
        })
        .collect()
}

fn straight(p: V, d: V, length: f64) -> impl Fn(f64) -> (V, V) {
    move |s| (add(&p, &scale(&d, length * s)), d)
}

/// Arc from `p` leaving along `d1`, turning towards `m` (unit, ⟂ d1) about the centre `p + m R`, through `angle`.
fn arc(p: V, d1: V, m: V, radius: f64, angle: f64) -> impl Fn(f64) -> (V, V) {
    move |s| {
        let phi = angle * s;
        let c = add(&p, &scale(&m, radius));
        let pos = add(&c, &add(&scale(&m, -radius * phi.cos()), &scale(&d1, radius * phi.sin())));
        (pos, add(&scale(&d1, phi.cos()), &scale(&m, phi.sin())))
    }
}

fn settings(sigma: f64) -> TraceSettings {
    TraceSettings { fit: FitSettings { noise_sigma: Some(sigma), ..FitSettings::default() }, ..TraceSettings::default() }
}

fn messages(result: &llull_cloud::fit::trace::TraceResult) -> Vec<&String> {
    result.warnings.iter().map(|w| &w.message).collect()
}

#[test]
fn vc_scn_22_elb_a_finds_two_straights_and_a_bend_within_the_pack_tolerances() {
    let truth = json("synthetic_truth.json");
    let case = &truth["cases"]["ELB-A"];
    let points = csv(case["file"].as_str().unwrap());
    let result = trace(&points, &[0.5, 0.0, 1.0], &settings(0.001)).unwrap();
    let tol = &case["tolerance"];
    assert_eq!(result.straights.len(), 2, "{:?}", messages(&result));
    assert_eq!(result.bends.len(), 1);
    let bend = &result.bends[0];
    assert!((bend.radius - case["bendRadius_m"].as_f64().unwrap()).abs() <= tol["bendRadius_m"].as_f64().unwrap(), "R {}", bend.radius);
    assert!((bend.angle_deg - 90.0).abs() <= tol["bendAngle_deg"].as_f64().unwrap(), "angle {}", bend.angle_deg);
    let pi = vec3(&case["intersectionPoint_m"]);
    assert!(norm(&sub(&bend.intersection_point, &pi)) <= tol["intersectionPoint_m"].as_f64().unwrap(), "PI {:?}", bend.intersection_point);
    assert!(bend.radius_measured && bend.arc_inliers > 500);
    let r = case["radius_m"].as_f64().unwrap();
    for s in &result.straights {
        assert!((s.radius - r).abs() <= tol["radius_m"].as_f64().unwrap(), "radius {}", s.radius);
    }
    assert!((result.diameter.value - 2.0 * r).abs() < 2e-3 && result.diameter.std < 1e-3);
    assert!(dot(&result.straights[0].direction, &[1.0, 0.0, 0.0]) > 0.9999);
    assert!(dot(&result.straights[1].direction, &[0.0, 1.0, 0.0]) > 0.9999);
    assert!((result.straights[0].length - 1.5).abs() < 0.02 && (result.straights[1].length - 1.0).abs() < 0.02);
    assert_eq!(result.centreline.len(), 3);
    assert!(norm(&sub(&result.centreline[0], &[0.0, 0.0, 1.0])) < 0.02 && norm(&sub(&result.centreline[2], &[1.6524, 1.1524, 1.0])) < 0.02);
    assert!(result.rms < 0.002 && result.warnings.is_empty());
}

#[test]
fn a_one_sided_scan_of_an_s_bend_is_traced() {
    // DN200 (r 109.55 mm): +x, a 60 degree bend (R 0.4 m) towards +y, a straight, then the same turn back to +x. Seen over 200 degrees.
    let mut rng = Rng::new(11);
    let (r, big_r, angle) = (0.10955, 0.4, 60f64.to_radians());
    let visible = (-1.75, 1.75);
    let d2 = [angle.cos(), angle.sin(), 0.0];
    let t1 = [2.0, 0.0, 0.0];
    let end1 = add(&t1, &[big_r * angle.sin(), big_r * (1.0 - angle.cos()), 0.0]);
    let mid_end = add(&end1, &scale(&d2, 1.5));
    let m2 = [angle.sin(), -angle.cos(), 0.0];
    let mut points = tube(&mut rng, 9000, r, 0.001, visible, straight([0.0, 0.0, 0.0], [1.0, 0.0, 0.0], 2.0));
    points.extend(tube(&mut rng, 3000, r, 0.001, visible, arc(t1, [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], big_r, angle)));
    points.extend(tube(&mut rng, 6000, r, 0.001, visible, straight(end1, d2, 1.5)));
    points.extend(tube(&mut rng, 3000, r, 0.001, visible, arc(mid_end, d2, m2, big_r, angle)));
    let (end2, d3) = arc(mid_end, d2, m2, big_r, angle)(1.0);
    points.extend(tube(&mut rng, 6000, r, 0.001, visible, straight(end2, d3, 1.5)));
    let result = trace(&points, &[1.0, 0.0, 0.0], &settings(0.001)).unwrap();
    assert_eq!(result.bends.len(), 2, "{:?}", messages(&result));
    assert_eq!(result.straights.len(), 3);
    for bend in &result.bends {
        assert!((bend.angle_deg - 60.0).abs() < 1.0, "angle {}", bend.angle_deg);
        assert!((bend.radius - big_r).abs() < 0.04, "R {}", bend.radius);
    }
    let pi1 = [2.0 + big_r * (angle / 2.0).tan(), 0.0, 0.0];
    assert!(norm(&sub(&result.bends[0].intersection_point, &pi1)) < 0.006, "PI {:?}", result.bends[0].intersection_point);
    assert!((result.diameter.value - 2.0 * r).abs() < 0.002);
    assert!(result.centreline[0][0] < 0.05);
}

#[test]
fn a_seed_in_the_middle_traces_both_directions() {
    let mut rng = Rng::new(3);
    let r = 0.0381;
    let full = (-std::f64::consts::PI, std::f64::consts::PI);
    let mut points = tube(&mut rng, 6000, r, 0.0005, full, straight([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 3.0));
    points.extend(tube(
        &mut rng,
        650,
        r,
        0.0005,
        full,
        arc([0.0, 0.0, 3.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0], 0.2, std::f64::consts::FRAC_PI_2),
    ));
    points.extend(tube(&mut rng, 4000, r, 0.0005, full, straight([0.2, 0.0, 3.2], [1.0, 0.0, 0.0], 2.0)));
    let result = trace(&points, &[0.0, 0.0, 1.5], &settings(0.0005)).unwrap();
    assert_eq!(result.straights.len(), 2);
    assert_eq!(result.bends.len(), 1);
    assert!(norm(&sub(&result.centreline[0], &[0.0, 0.0, 0.0])) < 0.02, "{:?}", result.centreline);
    assert!(
        norm(&sub(&result.centreline[2], &[2.2, 0.0, 3.2])) < 0.02,
        "{:?} {:?} {:?} {:?}",
        result.centreline,
        result.ends,
        result.straights,
        result.bends
    );
    assert!(norm(&sub(&result.centreline[1], &[0.0, 0.0, 3.2])) < 0.005);
    assert!((result.bends[0].radius - 0.2).abs() < 0.02);
    assert_eq!(result.ends.start, "no_points");
}

#[test]
fn a_reducer_stops_the_trace_and_is_reported() {
    let mut rng = Rng::new(5);
    let full = (-std::f64::consts::PI, std::f64::consts::PI);
    let mut points = tube(&mut rng, 6000, 0.05, 0.0005, full, straight([0.0, 0.0, 0.0], [1.0, 0.0, 0.0], 2.0));
    points.extend(tube(&mut rng, 6000, 0.075, 0.0005, full, straight([2.0, 0.0, 0.0], [1.0, 0.0, 0.0], 2.0)));
    let result = trace(&points, &[0.5, 0.0, 0.0], &settings(0.0005)).unwrap();
    assert_eq!(result.reducers.len(), 1, "{:?}", result.ends);
    let reducer = &result.reducers[0];
    assert!((reducer.position[0] - 2.0).abs() < 0.3 && (reducer.radius_before - 0.05).abs() < 0.002);
    assert!(reducer.radius_after > 0.055 && result.bends.is_empty());
    assert_eq!(result.ends.end, "radius_change");
}

#[test]
fn clutter_and_a_parallel_pipe_do_not_derail_the_trace() {
    let mut rng = Rng::new(21);
    let (r, full) = (0.05, (-std::f64::consts::PI, std::f64::consts::PI));
    let mut points = tube(&mut rng, 5000, r, 0.0005, full, straight([0.0, 0.0, 0.0], [1.0, 0.0, 0.0], 3.0));
    points.extend(tube(&mut rng, 5000, r, 0.0005, full, straight([0.0, 0.4, 0.0], [1.0, 0.0, 0.0], 3.0)));
    points.extend((0..3000).map(|_| [rng.unit() * 3.0, rng.unit() - 0.3, rng.unit() * 0.6 - 0.3]));
    let result = trace(&points, &[1.5, 0.0, 0.0], &settings(0.0005)).unwrap();
    assert_eq!(result.straights.len(), 1);
    assert!((result.diameter.value - 2.0 * r).abs() < 0.002);
    assert!(result.straights[0].start[1].abs() < 0.01 && result.straights[0].end[1].abs() < 0.01);
}

#[test]
fn legs_whose_axes_miss_each_other_warn_skew() {
    // A +x leg, a planar quarter bend (R 0.2 m), then a leg tilted 8 degrees out of the bend plane: its axis passes 2.8 cm from the first.
    let mut rng = Rng::new(8);
    let (r, full) = (0.05, (-std::f64::consts::PI, std::f64::consts::PI));
    let tilt = 8f64.to_radians();
    let mut points = tube(&mut rng, 6000, r, 0.0005, full, straight([0.0, 0.0, 0.0], [1.0, 0.0, 0.0], 2.0));
    points.extend(tube(
        &mut rng,
        900,
        r,
        0.0005,
        full,
        arc([2.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], 0.2, std::f64::consts::FRAC_PI_2),
    ));
    points.extend(tube(&mut rng, 4000, r, 0.0005, full, straight([2.2, 0.2, 0.0], [0.0, tilt.cos(), tilt.sin()], 1.5)));
    let result = trace(&points, &[1.0, 0.0, 0.0], &settings(0.0005)).unwrap();
    assert!(result.warnings.iter().any(|w| w.code == "SCN_TRACE_SKEW"), "{:?}", result.warnings);
    assert!(result.bends.is_empty() && result.straights.len() == 1);
    assert_eq!(result.ends.end, "bend_not_continued");
}

#[test]
fn failures_have_stable_codes() {
    let mut rng = Rng::new(2);
    let points =
        tube(&mut rng, 3000, 0.05, 0.0005, (-std::f64::consts::PI, std::f64::consts::PI), straight([0.0, 0.0, 0.0], [1.0, 0.0, 0.0], 2.0));
    let far = trace(&points, &[1.0, 2.0, 0.0], &settings(0.0005)).unwrap_err();
    assert_eq!(far.code, "SCN_FIT_TOO_FEW_POINTS");
    let beside = trace(&points, &[1.0, 0.3, 0.0], &settings(0.0005)).unwrap_err();
    assert_eq!(beside.code, "SCN_FIT_NO_MODEL", "{beside}");
    let noise: Vec<V> = (0..800).map(|_| [rng.unit(), rng.unit(), rng.unit()]).collect();
    let none = trace(&noise, &[0.5, 0.5, 0.5], &TraceSettings { seed_radius: 1.0, ..settings(0.0005) }).unwrap_err();
    assert_eq!(none.code, "SCN_FIT_NO_MODEL");
}

#[test]
fn the_trace_is_bit_identical_for_a_seed_and_any_thread_count() {
    let points = csv("synthetic/elb-a.csv");
    let a = trace(&points, &[0.5, 0.0, 1.0], &settings(0.001)).unwrap();
    let pool = rayon::ThreadPoolBuilder::new().num_threads(1).build().unwrap();
    let b = pool.install(|| trace(&points, &[0.5, 0.0, 1.0], &settings(0.001)).unwrap());
    assert_eq!(serde_json::to_string(&a).unwrap(), serde_json::to_string(&b).unwrap());
}

#[test]
fn the_trace_op_job_runs_over_an_imported_asset_and_bounds_its_region() {
    let dir = temp_dir("trace-op");
    let cloud = read(&common::data("synthetic/elb-a.csv"), &ImportOptions::default()).unwrap();
    let key = "a".repeat(64);
    let built = asset::build(&cloud, &key, &"b".repeat(64), "elb-a.csv", &ImportOptions::default()).unwrap();
    let asset_dir = dir.join(&key);
    asset::write(&built, &asset_dir).unwrap();
    let identity = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
    let write_job = |folder: &std::path::Path, params: serde_json::Value| {
        std::fs::create_dir_all(folder).unwrap();
        let job = serde_json::json!({ "version": 1, "kind": "trace", "clouds": [{ "assetKey": key, "dir": asset_dir, "toDocument": identity }], "params": params });
        std::fs::write(folder.join("job.json"), job.to_string()).unwrap();
    };
    let ok = dir.join("ok");
    write_job(&ok, serde_json::json!({ "seedPoint": [0.5, 0.0, 1.0], "noiseSigma": 0.001 }));
    llull_cloud::job::run("op", &ok, &mut Vec::new()).unwrap();
    let result: serde_json::Value = serde_json::from_slice(&std::fs::read(ok.join("result.json")).unwrap()).unwrap();
    assert_eq!(result["bends"].as_array().unwrap().len(), 1);
    assert_eq!(result["deterministic"], true);
    let big = dir.join("big");
    write_job(&big, serde_json::json!({ "seedPoint": [0.5, 0.0, 1.0], "maxLoadPoints": 100 }));
    assert_eq!(llull_cloud::job::run("op", &big, &mut Vec::new()).unwrap_err().code, "SCN_QUERY_LIMIT");
    let bad = dir.join("bad");
    write_job(&bad, serde_json::json!({ "seedPoint": [0.5, 0.0] }));
    assert_eq!(llull_cloud::job::run("op", &bad, &mut Vec::new()).unwrap_err().code, "NATIVE_JOB_INPUT");
    let _ = std::fs::remove_dir_all(&dir);
}

//! VC-SCN-20a–c (CYL-A / B / C cylinder fits within the CRLB-derived tolerances), VC-SCN-24 (circle in a 20 mm slice of CYL-B), plane and
//! sphere fits, determinism (TR-SCN-08), and the `fit` / `extract_pipes` / `slice` op jobs over an imported asset.

mod common;

use common::{csv, json, temp_dir, vec3};
use llull_cloud::asset;
use llull_cloud::fit::{cylinder, plane, sphere, FitSettings};
use llull_cloud::linalg::{dot, norm, scale, sub};
use llull_cloud::read::{read, ImportOptions};
use llull_cloud::slice::{slice, SliceFit, SliceParams};

fn errors(fit: &cylinder::CylinderFit, case: &serde_json::Value) -> (f64, f64, f64) {
    let at = vec3(&case["axisDirection"]);
    let pt = vec3(&case["axisPoint_m"]);
    let angle = libm::acos(dot(&fit.axis_direction, &at).abs().min(1.0)).to_degrees();
    let v = sub(&fit.axis_point, &pt);
    let position = norm(&sub(&v, &scale(&at, dot(&v, &at))));
    (fit.radius - case["radius_m"].as_f64().unwrap(), angle, position)
}

#[test]
fn vc_scn_20_cylinders_are_within_the_crlb_tolerances() {
    let truth = json("synthetic_truth.json");
    for id in ["CYL-A", "CYL-B", "CYL-C"] {
        let case = &truth["cases"][id];
        let points = csv(case["file"].as_str().unwrap());
        let settings = FitSettings { noise_sigma: case["noiseSigma_m"].as_f64(), ..FitSettings::default() };
        let fit = cylinder::fit(&points, &settings).unwrap_or_else(|e| panic!("{id}: {e}"));
        let (dr, angle, position) = errors(&fit, case);
        let tol = &case["tolerance"];
        assert!(dr.abs() <= tol["radius_m"].as_f64().unwrap(), "{id}: radius error {dr}");
        assert!(angle <= tol["axisAngle_deg"].as_f64().unwrap(), "{id}: axis angle error {angle}°");
        assert!(position <= tol["axisPosition_m"].as_f64().unwrap(), "{id}: axis position error {position}");
        let inliers = case["inliers"].as_u64().unwrap() as usize;
        assert!(fit.inliers as f64 > 0.95 * inliers as f64 && fit.inliers as f64 <= 1.05 * inliers as f64, "{id}: {} inliers", fit.inliers);
        // The CRLB at the given sigma matches the pack's (same Jacobian, same parameterisation) to 20 %.
        let crlb = fit.crlb.unwrap();
        let expected = case["crlb"]["radiusStd_m"].as_f64().unwrap();
        assert!((crlb.radius / expected - 1.0).abs() < 0.2, "{id}: CRLB radius {} vs {expected}", crlb.radius);
        assert!(fit.std.is_some() && fit.covariance.is_some());
        let span = case["arcCoverage_deg"].as_array().unwrap();
        let arc = span[1].as_f64().unwrap() - span[0].as_f64().unwrap();
        assert!((fit.coverage_deg - arc.min(360.0)).abs() < 15.0, "{id}: coverage {}", fit.coverage_deg);
        assert!(fit.warnings.iter().all(|w| w.code != "SCN_FIT_LOW_COVERAGE"), "{id}");
        let length = case["length_m"].as_f64().unwrap();
        assert!((fit.length - length).abs() < 0.05 * length, "{id}: length {}", fit.length);
    }
}

#[test]
fn fits_are_deterministic_for_a_seed_and_any_thread_count() {
    let points = csv("synthetic/cyl-c.csv");
    let settings = FitSettings { noise_sigma: Some(0.001), ..FitSettings::default() };
    let a = cylinder::fit(&points, &settings).unwrap();
    let b = rayon::ThreadPoolBuilder::new().num_threads(1).build().unwrap().install(|| cylinder::fit(&points, &settings).unwrap());
    assert_eq!(a.radius.to_bits(), b.radius.to_bits());
    assert_eq!(a.axis_direction.map(f64::to_bits), b.axis_direction.map(f64::to_bits));
    let other_seed = cylinder::fit(&points, &FitSettings { seed: 7, ..settings }).unwrap();
    assert!((other_seed.radius - a.radius).abs() < 1e-4, "a different seed still converges to the same cylinder");
}

#[test]
fn fit_failures_have_stable_codes_and_low_coverage_warns() {
    let points = csv("synthetic/cyl-a.csv");
    assert_eq!(cylinder::fit(&points[..20], &FitSettings::default()).unwrap_err().code, "SCN_FIT_TOO_FEW_POINTS");
    let mut rng = llull_cloud::kdtree::Rng::new(5);
    let noise: Vec<[f64; 3]> = (0..400).map(|_| [rng.unit(), rng.unit(), rng.unit()]).collect();
    let settings = FitSettings { distance_threshold: Some(0.0005), ..FitSettings::default() };
    assert_eq!(cylinder::fit(&noise, &settings).unwrap_err().code, "SCN_FIT_NO_MODEL");
    // A 40 degree strip of CYL-A: coverage below 60 degrees.
    let case = &json("synthetic_truth.json")["cases"]["CYL-A"];
    let (pt, axis) = (vec3(&case["axisPoint_m"]), vec3(&case["axisDirection"]));
    let strip: Vec<[f64; 3]> = points
        .iter()
        .filter(|p| {
            let v = sub(p, &pt);
            let radial = sub(&v, &scale(&axis, dot(&v, &axis)));
            radial[2] / norm(&radial) > libm::cos(20f64.to_radians())
        })
        .copied()
        .collect();
    let narrow = cylinder::fit(&strip, &FitSettings { noise_sigma: Some(0.001), ..FitSettings::default() }).unwrap();
    assert!(narrow.coverage_deg < 60.0);
    assert!(narrow.warnings.iter().any(|w| w.code == "SCN_FIT_LOW_COVERAGE"));
}

#[test]
fn plane_and_sphere_fits_recover_synthetic_shapes() {
    let mut rng = llull_cloud::kdtree::Rng::new(11);
    let mut points: Vec<[f64; 3]> = (0..2000).map(|_| [rng.unit() * 2.0, rng.unit() * 2.0, 0.5 + 0.001 * (rng.unit() - 0.5)]).collect();
    points.extend((0..300).map(|_| [rng.unit() * 2.0, rng.unit() * 2.0, rng.unit()]));
    let found = plane::fit(&points, &FitSettings { distance_threshold: Some(0.003), ..FitSettings::default() }).unwrap();
    assert!(found.normal[2].abs() > 0.99999 && (found.point[2] - 0.5).abs() < 1e-3, "{found:?}");
    assert!(found.std.is_some() && found.inliers >= 2000);
    let station = csv("synthetic/tgt-a-station1.csv");
    let centre = [1.5, -2.0, 0.0];
    let near: Vec<[f64; 3]> = station.into_iter().filter(|p| norm(&sub(p, &centre)) < 0.145).collect();
    let ball = sphere::fit(&near, &FitSettings { noise_sigma: Some(0.0015), ..FitSettings::default() }).unwrap();
    assert!(norm(&sub(&ball.centre, &centre)) < 0.002 && (ball.radius - 0.0725).abs() < 0.002, "{ball:?}");
    assert_eq!(plane::fit(&points[..5], &FitSettings::default()).unwrap_err().code, "SCN_FIT_TOO_FEW_POINTS");
    assert_eq!(sphere::fit(&points[..5], &FitSettings::default()).unwrap_err().code, "SCN_FIT_TOO_FEW_POINTS");
}

#[test]
fn vc_scn_24_a_slice_of_cyl_b_fits_its_circle() {
    let case = &json("synthetic_truth.json")["cases"]["CYL-B"];
    let axis = vec3(&case["axisDirection"]);
    let points = csv("synthetic/cyl-b.csv");
    let params = SliceParams {
        origin: scale(&axis, 1.5),
        normal: axis,
        thickness: 0.02,
        fit: SliceFit::Circle,
        max_points: 1000,
        noise_sigma: Some(0.002),
        min_radius: 0.01,
        max_radius: 0.5,
        seed: 1,
        region: Default::default(),
    };
    let result = slice(&points, &params).unwrap();
    assert!(result.count > 30, "{} points in the slab", result.count);
    let circle = result.circles.first().expect("a circle");
    assert!((circle.radius - 0.10955).abs() <= 0.0016, "r = {}", circle.radius);
    assert!(norm(&sub(&circle.centre, &scale(&axis, 1.5))) < 0.005, "centre {:?}", circle.centre);
    let lines = slice(&points, &SliceParams { fit: SliceFit::Lines, ..params.clone() }).unwrap();
    assert!(lines.circles.is_empty());
    assert!(slice(&points, &SliceParams { normal: [0.0; 3], ..params }).is_none());
}

#[test]
fn the_fit_extract_and_slice_ops_run_over_an_asset() {
    let root = temp_dir("fitops");
    let key = "3".repeat(64);
    let cloud = read(&common::data("synthetic/cyl-a.csv"), &ImportOptions::default()).unwrap();
    asset::write(&asset::build(&cloud, &key, &"0".repeat(64), "cyl-a.csv", &ImportOptions::default()).unwrap(), &root.join(&key)).unwrap();
    let folder = root.join("job");
    std::fs::create_dir_all(&folder).unwrap();
    let identity: Vec<f64> = llull_cloud::linalg::IDENTITY.to_vec();
    let run = |kind: &str, params: serde_json::Value| -> Result<serde_json::Value, String> {
        let job = serde_json::json!({ "version": 1, "kind": kind, "clouds": [{ "assetKey": key, "dir": root.join(&key), "toDocument": identity }], "params": params });
        std::fs::write(folder.join("job.json"), job.to_string()).unwrap();
        llull_cloud::ops::run(&folder, &mut std::io::sink()).map_err(|e| e.code.to_string())?;
        Ok(serde_json::from_str(&std::fs::read_to_string(folder.join("result.json")).unwrap()).unwrap())
    };
    let fit = run("fit", serde_json::json!({ "kind": "cylinder", "noiseSigma": 0.001 })).unwrap();
    assert!((fit["radius"].as_f64().unwrap() - 0.05715).abs() < 2e-4);
    assert_eq!(fit["kind"], "cylinder");
    let pipes = run("extract_pipes", serde_json::json!({ "noiseSigma": 0.001, "minRadius": 0.02, "maxRadius": 0.5 })).unwrap();
    assert_eq!(pipes["extractions"].as_array().unwrap().len(), 1);
    let too_big = run("extract_pipes", serde_json::json!({ "noiseSigma": 0.001, "minRadius": 0.2, "maxRadius": 0.5 })).unwrap();
    assert_eq!(too_big["extractions"].as_array().unwrap().len(), 0);
    let empty = run("fit", serde_json::json!({ "kind": "plane", "region": { "kind": "box", "min": [50, 50, 50], "max": [51, 51, 51] } }));
    assert_eq!(empty.unwrap_err(), "SCN_FIT_TOO_FEW_POINTS");
    assert_eq!(run("fit", serde_json::json!({ "kind": "torus" })).unwrap_err(), "NATIVE_JOB_INPUT");
    let section = run("slice", serde_json::json!({ "origin": [1.8, 2.6, 3.0], "normal": [0.8, 0.6, 0.0], "thickness": 0.05, "fit": "circle", "noiseSigma": 0.001 })).unwrap();
    assert!(section["count"].as_u64().unwrap() > 10);
}

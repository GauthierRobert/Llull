//! VC-SCN-23 (STL-A: IPE 300 ranked first, h and b within 3 mm) on synthetic members in arbitrary orientation, the chirality of an unequal
//! angle, the axis hint, the warning of a non-catalogue section and the failure codes.

mod common;

use llull_cloud::fit::steel::{fit, Outline};
use llull_cloud::fit::FitSettings;
use llull_cloud::kdtree::Rng;
use llull_cloud::linalg::{add, cross, dot, norm, scale, sub};

type V = [f64; 3];

fn gauss(rng: &mut Rng) -> f64 {
    let (a, b) = (rng.unit().max(1e-12), rng.unit());
    (-2.0 * a.ln()).sqrt() * (std::f64::consts::TAU * b).cos()
}

/// I outline in metres, x = width, y = depth (the TS `profileOutline` order).
fn i_loop(h: f64, b: f64, tw: f64, tf: f64) -> Vec<[f64; 2]> {
    let (x, y) = (b / 2.0, h / 2.0);
    vec![
        [-x, -y],
        [x, -y],
        [x, -y + tf],
        [tw / 2.0, -y + tf],
        [tw / 2.0, y - tf],
        [x, y - tf],
        [x, y],
        [-x, y],
        [-x, y - tf],
        [-tw / 2.0, y - tf],
        [-tw / 2.0, -y + tf],
        [-x, -y + tf],
    ]
}

fn l_loop(h: f64, b: f64, t: f64) -> Vec<[f64; 2]> {
    let (x, y) = (b / 2.0, h / 2.0);
    vec![[-x, -y], [x, -y], [x, -y + t], [-x + t, -y + t], [-x + t, y], [-x, y]]
}

fn outline(name: &str, loop_xy: Vec<[f64; 2]>) -> Outline {
    Outline { name: name.to_string(), loop_xy, tw: None, tf: None }
}

fn catalogue() -> Vec<Outline> {
    vec![
        outline("IPE200", i_loop(0.2, 0.1, 0.0056, 0.0085)),
        outline("IPE270", i_loop(0.27, 0.135, 0.0066, 0.0102)),
        outline("IPE300", i_loop(0.3, 0.15, 0.0071, 0.0107)),
        outline("IPE330", i_loop(0.33, 0.16, 0.0075, 0.0115)),
        outline("HEA300", i_loop(0.29, 0.3, 0.0085, 0.014)),
        outline("L150x100x10", l_loop(0.15, 0.1, 0.01)),
        outline("L100x150x10", l_loop(0.1, 0.15, 0.01)),
    ]
}

struct Frame {
    origin: V,
    x: V,
    y: V,
    z: V,
}

/// Surface points along a loop (mapped through the frame) over `length`, noise sigma `sigma`.
fn member(rng: &mut Rng, loop_xy: &[[f64; 2]], n: usize, length: f64, sigma: f64, f: &Frame) -> Vec<V> {
    let m = loop_xy.len();
    let lengths: Vec<f64> = (0..m)
        .map(|i| {
            let (a, b) = (loop_xy[i], loop_xy[(i + 1) % m]);
            ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt()
        })
        .collect();
    let total: f64 = lengths.iter().sum();
    (0..n)
        .map(|_| {
            let mut s = rng.unit() * total;
            let mut i = 0;
            while i + 1 < m && s > lengths[i] {
                s -= lengths[i];
                i += 1;
            }
            let (a, b) = (loop_xy[i], loop_xy[(i + 1) % m]);
            let t = s / lengths[i];
            let (px, py) = (a[0] + t * (b[0] - a[0]) + sigma * gauss(rng), a[1] + t * (b[1] - a[1]) + sigma * gauss(rng));
            add(&f.origin, &add(&scale(&f.x, px), &add(&scale(&f.y, py), &scale(&f.z, length * rng.unit()))))
        })
        .collect()
}

fn unit_v(v: V) -> V {
    scale(&v, 1.0 / norm(&v))
}

fn aligned() -> Frame {
    Frame { origin: [0.0; 3], x: [1.0, 0.0, 0.0], y: [0.0, 1.0, 0.0], z: [0.0, 0.0, 1.0] }
}

fn settings() -> FitSettings {
    FitSettings { noise_sigma: Some(0.0005), ..FitSettings::default() }
}

#[test]
fn vc_scn_23_stl_a_ipe_300_is_ranked_first_with_h_and_b_within_3_mm() {
    let mut rng = Rng::new(7);
    let z = unit_v([0.3, 0.8, 0.5]);
    let x = unit_v(cross(&z, &[0.0, 0.0, 1.0]));
    let y = cross(&z, &x);
    let frame = Frame { origin: [1.0, 2.0, 3.0], x, y, z };
    let points = member(&mut rng, &i_loop(0.3, 0.15, 0.0071, 0.0107), 6000, 3.0, 0.0005, &frame);
    let found = fit(&points, &catalogue(), None, 5, &settings()).unwrap();
    let best = &found.candidates[0];
    assert_eq!(best.profile, "IPE300");
    assert!((best.h - 0.3).abs() < 0.003 && (best.b - 0.15).abs() < 0.003, "h {} b {}", best.h, best.b);
    assert!(found.candidates[1].score > best.score);
    assert!(found.warnings.is_empty());
    assert!((found.length - 3.0).abs() < 0.05, "length {}", found.length);
    assert!(dot(&found.axis_direction, &z).abs() > 0.999);
    assert!(dot(&best.depth_direction, &found.axis_direction).abs() < 1e-9);
    assert!(dot(&best.depth_direction, &y).abs() > 0.999, "depth {:?} vs {:?}", best.depth_direction, y);
    assert!(dot(&sub(&found.end, &found.start), &found.axis_direction) > 0.0);
}

#[test]
fn an_unequal_angle_keeps_its_chirality_through_the_axis_direction() {
    let mut rng = Rng::new(11);
    let frame = aligned();
    let points = member(&mut rng, &l_loop(0.15, 0.1, 0.01), 4000, 2.0, 0.0005, &frame);
    let found = fit(&points, &catalogue(), None, 3, &settings()).unwrap();
    let best = &found.candidates[0];
    assert_eq!(best.profile, "L150x100x10");
    let handed = cross(&best.width_direction, &best.depth_direction);
    assert!(dot(&handed, &best.axis_direction) > 0.999);
    assert!(dot(&best.depth_direction, &frame.y).abs() > 0.99 && dot(&best.width_direction, &frame.x).abs() > 0.99);
    assert!(dot(&best.width_direction, &frame.x) * dot(&best.axis_direction, &frame.z) > 0.0);
}

#[test]
fn the_axis_hint_overrides_the_principal_axis_of_a_short_member() {
    let mut rng = Rng::new(3);
    let points = member(&mut rng, &i_loop(0.3, 0.15, 0.0071, 0.0107), 4000, 0.12, 0.0004, &aligned());
    let found = fit(&points, &catalogue(), Some([0.0, 0.0, 2.0]), 2, &settings()).unwrap();
    assert_eq!(found.candidates[0].profile, "IPE300");
    assert_eq!(found.candidates.len(), 2);
    assert!((found.length - 0.12).abs() < 0.01);
}

#[test]
fn a_built_up_section_warns_no_match() {
    let mut rng = Rng::new(5);
    let boxed = vec![[-0.075, -0.08], [0.075, -0.08], [0.075, 0.08], [-0.075, 0.08]];
    let points = member(&mut rng, &boxed, 4000, 2.0, 0.0005, &aligned());
    let found = fit(&points, &catalogue(), None, 3, &settings()).unwrap();
    assert!(found.warnings.iter().any(|w| w.code == "SCN_STEEL_NO_MATCH"));
}

#[test]
fn failures_are_named() {
    let few: Vec<V> = (0..10).map(|i| [i as f64, 0.0, 0.0]).collect();
    assert_eq!(fit(&few, &catalogue(), None, 5, &settings()).unwrap_err().code, "SCN_FIT_TOO_FEW_POINTS");
    let mut rng = Rng::new(1);
    let points = member(&mut rng, &i_loop(0.3, 0.15, 0.0071, 0.0107), 800, 2.0, 0.0004, &aligned());
    assert_eq!(fit(&points, &[], None, 5, &settings()).unwrap_err().code, "NATIVE_JOB_INPUT");
    assert_eq!(fit(&points, &[outline("bad", vec![[0.0, 0.0], [1.0, 0.0]])], None, 5, &settings()).unwrap_err().code, "NATIVE_JOB_INPUT");
    assert_eq!(fit(&points, &catalogue(), Some([0.0; 3]), 5, &settings()).unwrap_err().code, "NATIVE_JOB_INPUT");
    let wire: Vec<V> = (0..100).map(|i| [0.001 * rng.unit(), 0.001 * rng.unit(), i as f64 * 0.02]).collect();
    assert_eq!(fit(&wire, &catalogue(), None, 5, &settings()).unwrap_err().code, "SCN_FIT_NO_MODEL");
    let bar = vec![[-0.01, -0.01], [0.01, -0.01], [0.01, 0.01], [-0.01, 0.01]];
    let thin = member(&mut rng, &bar, 600, 2.0, 0.0001, &aligned());
    assert_eq!(fit(&thin, &catalogue(), None, 5, &settings()).unwrap_err().code, "SCN_STEEL_NO_CANDIDATE");
}

#[test]
fn vc_scn_23_on_the_pack_file_stl_a() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../docs/plant/10-pointcloud-brownfield/validation/data/synthetic/stl-a.csv");
    let text = std::fs::read_to_string(path).unwrap();
    let points: Vec<V> = text
        .lines()
        .skip(1)
        .map(|line| {
            let v: Vec<f64> = line.split(',').map(|s| s.trim().parse().unwrap()).collect();
            [v[0], v[1], v[2]]
        })
        .collect();
    assert_eq!(points.len(), 8000);
    let found = fit(&points, &catalogue(), None, 5, &FitSettings { noise_sigma: Some(0.001), ..FitSettings::default() }).unwrap();
    let best = &found.candidates[0];
    assert_eq!(best.profile, "IPE300");
    assert!((best.h - 0.3).abs() < 0.003 && (best.b - 0.15).abs() < 0.003, "h {} b {}", best.h, best.b);
    assert!(dot(&found.axis_direction, &[0.0, 1.0, 0.0]).abs() > 0.99999, "axis {:?}", found.axis_direction);
    let off = sub(&best.centre, &[5.0, best.centre[1], 4.0]);
    assert!(norm(&off) < 0.003, "centre {:?}", best.centre);
    // The pack scan is one-sided (faces seen from +x / +z): the web (7.1 mm = 7 sigma, one face seen) is not resolved, a flange is.
    let strict = fit(&points, &thick_catalogue(), None, 3, &FitSettings { noise_sigma: Some(0.001), ..FitSettings::default() }).unwrap();
    let thickness = strict.thickness.expect("outline carries tw / tf");
    assert!(thickness.tw.is_none(), "{:?}", thickness);
    assert!(thickness.reason.unwrap().contains("tw:"));
    assert!((thickness.tf.expect("tf").value - 0.0107).abs() < 0.001);
    assert!(strict.axis_refinement.applied, "{:?}", strict.axis_refinement.reason);
    assert!(dot(&strict.axis_direction, &[0.0, 1.0, 0.0]).abs() > 0.99999);
}

#[test]
fn a_short_member_without_a_hint_is_an_ambiguous_axis() {
    let ipe = i_loop(0.3, 0.15, 0.0071, 0.0107);
    let hea = i_loop(0.29, 0.3, 0.0085, 0.014);
    for (name, shape, length) in [("IPE300 0.4h", &ipe, 0.12), ("IPE300 1.3h", &ipe, 0.39), ("HEA300 1.1h", &hea, 0.32)] {
        let mut rng = Rng::new(21);
        let points = member(&mut rng, shape, 5000, length, 0.0004, &aligned());
        let error = fit(&points, &catalogue(), None, 3, &settings()).unwrap_err();
        assert_eq!(error.code, "SCN_STEEL_AXIS_AMBIGUOUS", "{name}: {}", error.message);
        assert!(error.message.contains("axisHint"));
        let found = fit(&points, &catalogue(), Some([0.0, 0.0, 1.0]), 3, &settings()).unwrap();
        assert_eq!(found.candidates[0].profile, if name.starts_with("IPE") { "IPE300" } else { "HEA300" }, "{name}");
    }
}

#[test]
fn an_occluded_member_warns_low_coverage() {
    let mut rng = Rng::new(9);
    let all = member(&mut rng, &i_loop(0.3, 0.15, 0.0071, 0.0107), 9000, 3.0, 0.0005, &aligned());
    let seen: Vec<V> = all.into_iter().filter(|p| p[1] > -0.07).collect();
    let found = fit(&seen, &catalogue(), None, 3, &settings()).unwrap();
    assert!(found.warnings.iter().any(|w| w.code == "SCN_STEEL_LOW_COVERAGE"), "{:?}", found.warnings);
}

#[test]
fn hostile_outlines_and_hints_are_refused_naming_the_field() {
    let mut rng = Rng::new(2);
    let points = member(&mut rng, &i_loop(0.3, 0.15, 0.0071, 0.0107), 800, 2.0, 0.0004, &aligned());
    let big_loop: Vec<[f64; 2]> = (0..20_000).map(|i| [(i as f64).sin(), (i as f64).cos()]).collect();
    let refused =
        |outlines: &[Outline], hint: Option<V>, candidates: usize| fit(&points, outlines, hint, candidates, &settings()).unwrap_err();
    let error = refused(&[outline("huge", big_loop)], None, 5);
    assert_eq!(error.code, "NATIVE_JOB_INPUT");
    assert!(error.message.contains("loopXy"));
    let many: Vec<Outline> = (0..513).map(|i| outline(&format!("o{i}"), l_loop(0.1, 0.1, 0.01))).collect();
    assert!(refused(&many, None, 5).message.contains("outlines"));
    assert!(refused(&catalogue(), None, 101).message.contains("maxCandidates"));
    assert!(refused(&catalogue(), None, 0).message.contains("maxCandidates"));
    assert!(refused(&[outline(&"n".repeat(65), l_loop(0.1, 0.1, 0.01))], None, 5).message.contains("name"));
    assert!(refused(&[outline("nan", vec![[0.0, 0.0], [f64::NAN, 1.0], [1.0, 0.0]])], None, 5).message.contains("non-finite"));
    assert!(refused(&[outline("flat", vec![[0.0, 0.0], [1.0, 0.0], [2.0, 0.0]])], None, 5).message.contains("bounding box"));
    for hint in [[0.0; 3], [1e-12, 0.0, 0.0], [f64::INFINITY, 0.0, 0.0], [f64::NAN, 0.0, 1.0]] {
        assert!(refused(&catalogue(), Some(hint), 5).message.contains("axisHint"), "{hint:?}");
    }
}

#[test]
fn the_steel_op_job_runs_over_an_imported_asset_and_refuses_bad_params() {
    use llull_cloud::asset;
    use llull_cloud::read::{read, ImportOptions};
    let dir = common::temp_dir("steel-op");
    let cloud = read(&common::data("synthetic/stl-a.csv"), &ImportOptions::default()).unwrap();
    let key = "a".repeat(64);
    let built = asset::build(&cloud, &key, &"b".repeat(64), "stl-a.csv", &ImportOptions::default()).unwrap();
    let asset_dir = dir.join(&key);
    asset::write(&built, &asset_dir).unwrap();
    let identity = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
    let run = |name: &str, params: serde_json::Value| {
        let folder = dir.join(name);
        std::fs::create_dir_all(&folder).unwrap();
        let job = serde_json::json!({ "version": 1, "kind": "steel", "clouds": [{ "assetKey": key, "dir": asset_dir, "toDocument": identity }], "params": params });
        std::fs::write(folder.join("job.json"), job.to_string()).unwrap();
        llull_cloud::job::run("op", &folder, &mut Vec::new())
            .map(|_| serde_json::from_slice::<serde_json::Value>(&std::fs::read(folder.join("result.json")).unwrap()).unwrap())
    };
    let outlines = serde_json::to_value(
        [("IPE300", i_loop(0.3, 0.15, 0.0071, 0.0107)), ("IPE270", i_loop(0.27, 0.135, 0.0066, 0.0102))]
            .iter()
            .map(|(name, l)| serde_json::json!({ "name": name, "loopXy": l }))
            .collect::<Vec<_>>(),
    )
    .unwrap();
    let ok = run("ok", serde_json::json!({ "outlines": outlines, "axisHint": [0.0, 3.0, 0.0], "maxCandidates": 1, "noiseSigma": 0.001, "region": { "kind": "all" } })).unwrap();
    assert_eq!(ok["candidates"].as_array().unwrap().len(), 1);
    assert_eq!(ok["candidates"][0]["profile"], "IPE300");
    assert_eq!(ok["deterministic"], true);
    assert_eq!(run("missing", serde_json::json!({ "axisHint": [0.0, 1.0, 0.0] })).unwrap_err().code, "NATIVE_JOB_INPUT");
    let unknown = serde_json::json!([{ "name": "x", "loopXy": [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]], "extra": 1 }]);
    assert_eq!(run("unknown", serde_json::json!({ "outlines": unknown })).unwrap_err().code, "NATIVE_JOB_INPUT");
    let snake = serde_json::json!([{ "name": "x", "loop_xy": [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]] }]);
    assert_eq!(run("snake", serde_json::json!({ "outlines": snake })).unwrap_err().code, "NATIVE_JOB_INPUT");
    assert_eq!(run("hint", serde_json::json!({ "outlines": outlines, "axisHint": [0.0, 0.0, 0.0] })).unwrap_err().code, "NATIVE_JOB_INPUT");
    let _ = std::fs::remove_dir_all(&dir);
}

fn i_outline(name: &str, h: f64, b: f64, tw: f64, tf: f64) -> Outline {
    Outline { name: name.to_string(), loop_xy: i_loop(h, b, tw, tf), tw: Some(tw), tf: Some(tf) }
}

fn thick_catalogue() -> Vec<Outline> {
    vec![
        i_outline("IPE270", 0.27, 0.135, 0.0066, 0.0102),
        i_outline("IPE300", 0.3, 0.15, 0.0071, 0.0107),
        i_outline("IPE330", 0.33, 0.16, 0.0075, 0.0115),
    ]
}

fn tilted(axis: V, degrees: f64) -> V {
    let t = degrees.to_radians();
    unit_v(add(&scale(&axis, t.cos()), &scale(&[1.0, 0.0, 0.0], t.sin())))
}

#[test]
fn the_web_and_flange_thickness_are_measured_with_their_residual() {
    let mut rng = Rng::new(21);
    let points = member(&mut rng, &i_loop(0.3, 0.15, 0.0071, 0.0107), 8000, 2.0, 0.0005, &aligned());
    let found = fit(&points, &thick_catalogue(), None, 3, &settings()).unwrap();
    assert_eq!(found.candidates[0].profile, "IPE300");
    let thickness = found.thickness.expect("outline carries tw / tf");
    let (tw, tf) = (thickness.tw.expect("tw"), thickness.tf.expect("tf"));
    assert!((tw.value - 0.0071).abs() < 0.0008, "tw {}", tw.value);
    assert!((tf.value - 0.0107).abs() < 0.0008, "tf {}", tf.value);
    assert!(tw.residual < 0.0012 && tf.residual < 0.0012, "residuals {} {}", tw.residual, tf.residual);
    assert!(tw.samples >= 20 && tf.samples >= 40 && thickness.reason.is_none());
}

#[test]
fn a_thicker_web_than_the_catalogue_is_measured_as_such() {
    let mut rng = Rng::new(22);
    let points = member(&mut rng, &i_loop(0.3, 0.15, 0.011, 0.0107), 8000, 2.0, 0.0004, &aligned());
    let found = fit(&points, &thick_catalogue(), None, 3, &settings()).unwrap();
    let tw = found.thickness.unwrap().tw.unwrap();
    assert!((tw.value - 0.011).abs() < 0.0008, "tw {}", tw.value);
}

#[test]
fn an_outline_without_tw_tf_has_no_thickness_and_a_bad_pair_is_refused() {
    let mut rng = Rng::new(23);
    let points = member(&mut rng, &i_loop(0.3, 0.15, 0.0071, 0.0107), 3000, 2.0, 0.0005, &aligned());
    assert!(fit(&points, &catalogue(), None, 3, &settings()).unwrap().thickness.is_none());
    let mut half = i_outline("IPE300", 0.3, 0.15, 0.0071, 0.0107);
    half.tf = None;
    assert_eq!(fit(&points, &[half], None, 3, &settings()).unwrap_err().code, "NATIVE_JOB_INPUT");
    let mut fat = i_outline("IPE300", 0.3, 0.15, 0.0071, 0.0107);
    fat.tf = Some(0.16);
    assert_eq!(fit(&points, &[fat], None, 3, &settings()).unwrap_err().code, "NATIVE_JOB_INPUT");
}

#[test]
fn a_sparse_web_leaves_tw_null_with_a_reason() {
    let mut rng = Rng::new(24);
    let mut points = member(&mut rng, &i_loop(0.3, 0.15, 0.0071, 0.0107), 8000, 2.0, 0.0005, &aligned());
    points.retain(|p| !(p[0].abs() < 0.02 && p[1].abs() < 0.12));
    let found = fit(&points, &thick_catalogue(), Some([0.0, 0.0, 1.0]), 3, &settings()).unwrap();
    let thickness = found.thickness.unwrap();
    assert!(thickness.tw.is_none() && thickness.tf.is_some());
    assert!(thickness.reason.unwrap().contains("tw"));
}

#[test]
fn the_face_planes_pull_a_tilted_hint_back_onto_the_axis() {
    let mut rng = Rng::new(25);
    let points = member(&mut rng, &i_loop(0.3, 0.15, 0.0071, 0.0107), 8000, 3.0, 0.0005, &aligned());
    let truth = [0.0, 0.0, 1.0];
    let found = fit(&points, &thick_catalogue(), Some(tilted(truth, 0.6)), 3, &settings()).unwrap();
    assert_eq!(found.candidates[0].profile, "IPE300");
    let refinement = &found.axis_refinement;
    assert!(refinement.applied, "{:?}", refinement.reason);
    assert!(refinement.faces >= 4 && refinement.delta_deg > 0.3 && refinement.delta_deg < 1.0, "delta {}", refinement.delta_deg);
    assert!(refinement.residual < 0.002, "residual {}", refinement.residual);
    let off = dot(&found.axis_direction, &truth).abs().acos().to_degrees();
    assert!(off < 0.2, "axis {off} deg off the truth");
    assert!(found.thickness.unwrap().tw.is_some());
}

#[test]
fn a_hint_far_off_the_axis_is_not_refined() {
    let mut rng = Rng::new(26);
    let points = member(&mut rng, &i_loop(0.3, 0.15, 0.0071, 0.0107), 8000, 3.0, 0.0005, &aligned());
    if let Ok(found) = fit(&points, &thick_catalogue(), Some(tilted([0.0, 0.0, 1.0], 12.0)), 3, &settings()) {
        assert!(!found.axis_refinement.applied && found.axis_refinement.reason.is_some());
    }
}

#[test]
fn the_principal_axis_stays_within_a_tenth_of_a_degree_after_refinement() {
    let mut rng = Rng::new(27);
    let z = unit_v([0.3, 0.8, 0.5]);
    let x = unit_v(cross(&z, &[0.0, 0.0, 1.0]));
    let y = cross(&z, &x);
    let frame = Frame { origin: [1.0, 2.0, 3.0], x, y, z };
    let points = member(&mut rng, &i_loop(0.3, 0.15, 0.0071, 0.0107), 6000, 3.0, 0.0005, &frame);
    let found = fit(&points, &thick_catalogue(), None, 3, &settings()).unwrap();
    assert!(dot(&found.axis_direction, &z).abs().acos().to_degrees() < 0.1);
}

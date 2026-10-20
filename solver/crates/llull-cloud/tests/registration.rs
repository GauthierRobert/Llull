//! VC-SCN-30 (ICP-A on the bunny), VC-SCN-31 (TGT-A sphere targets + Horn), VC-SCN-32 (degenerate registrations), and the
//! `cloud op` job end to end over assets imported from the pack's CSVs.

mod common;

use common::{csv, data, json, temp_dir, vec3};
use llull_cloud::asset;
use llull_cloud::kdtree::{KdTree, Rng};
use llull_cloud::linalg::{self, rotation_angle_deg, Mat4};
use llull_cloud::read::{read, ImportOptions};
use llull_cloud::register::{icp, register_targets, IcpMethod, TargetKind, TargetPair};
use std::path::Path;

fn rotation_error_deg(a: &Mat4, b: &Mat4) -> f64 {
    // angle of a·bᵀ
    let r = |m: &Mat4, i: usize, j: usize| m[i * 4 + j];
    let mut product = linalg::IDENTITY;
    for i in 0..3 {
        for j in 0..3 {
            product[i * 4 + j] = (0..3).map(|k| r(a, i, k) * r(b, j, k)).sum();
        }
    }
    rotation_angle_deg(&product)
}

fn translation(m: &Mat4) -> [f64; 3] {
    [m[3], m[7], m[11]]
}

fn tgt_pairs(radius: Option<f64>) -> Vec<TargetPair> {
    let truth = &json("synthetic_truth.json")["cases"]["TGT-A"];
    let f = truth["centresStation1_m"].as_array().unwrap();
    let m = truth["centresStation2_m"].as_array().unwrap();
    (0..4)
        .map(|i| TargetPair { name: format!("T{}", i + 1), kind: TargetKind::Sphere, fixed: vec3(&f[i]), moving: vec3(&m[i]), radius })
        .collect()
}

#[test]
fn vc_scn_31_sphere_targets_register_two_stations() {
    let truth = &json("synthetic_truth.json")["cases"]["TGT-A"];
    let fixed = KdTree::build(&csv("synthetic/tgt-a-station1.csv"));
    let moving = KdTree::build(&csv("synthetic/tgt-a-station2.csv"));
    let result = register_targets(&fixed, &moving, &tgt_pairs(Some(0.0725))).unwrap();
    for (i, target) in result.targets.iter().enumerate() {
        let e1 = linalg::distance(&target.fixed_centre, &vec3(&truth["centresStation1_m"][i]));
        let e2 = linalg::distance(&target.moving_centre, &vec3(&truth["centresStation2_m"][i]));
        assert!(e1 <= 0.002 && e2 <= 0.002, "{}: centre errors {e1} {e2}", target.name);
    }
    let rt = truth["rotationMatrix_station2_to_station1"].as_array().unwrap();
    let rows: Vec<[f64; 3]> = rt.iter().map(vec3).collect();
    let expected = linalg::rigid(&[rows[0], rows[1], rows[2]], &vec3(&truth["translation_m"]));
    let rot = rotation_error_deg(&result.transform, &expected);
    let tr = linalg::distance(&translation(&result.transform), &translation(&expected));
    assert!(rot <= 0.05, "rotation error {rot}°");
    assert!(tr <= 0.003, "translation error {tr} m");
    assert!(result.rms < 0.003, "target rms {}", result.rms);
}

#[test]
fn vc_scn_32_degenerate_target_sets_are_refused() {
    let fixed = KdTree::build(&csv("synthetic/tgt-a-station1.csv"));
    let moving = KdTree::build(&csv("synthetic/tgt-a-station2.csv"));
    let two = &tgt_pairs(Some(0.0725))[..2];
    assert_eq!(register_targets(&fixed, &moving, two).unwrap_err().code, "SCN_REG_TARGETS_INSUFFICIENT");
    let collinear: Vec<TargetPair> = (0..3)
        .map(|i| TargetPair {
            name: format!("P{i}"),
            kind: TargetKind::Point,
            fixed: [f64::from(i), 0.0, 0.0],
            moving: [f64::from(i), 1.0, 0.0],
            radius: None,
        })
        .collect();
    assert_eq!(register_targets(&fixed, &moving, &collinear).unwrap_err().code, "SCN_REG_DEGENERATE");
    let mut lost = tgt_pairs(Some(0.0725));
    lost[0].fixed = [100.0, 100.0, 100.0];
    assert_eq!(register_targets(&fixed, &moving, &lost).unwrap_err().code, "SCN_REG_TARGET_NOT_FOUND");
}

/// ICP-A: target = R·source + t on a 70 % subsample with σ 0.2 mm (our seeded generator; the pack's numpy draw is not reproducible).
fn icp_a() -> (Vec<[f64; 3]>, Vec<[f64; 3]>, Mat4) {
    let truth = &json("synthetic_truth.json")["cases"]["ICP-A"];
    let source = read(&data("e57/bunnyInt32.e57"), &ImportOptions::default()).unwrap().positions;
    let rows: Vec<[f64; 3]> = truth["rotationMatrix"].as_array().unwrap().iter().map(vec3).collect();
    let transform = linalg::rigid(&[rows[0], rows[1], rows[2]], &vec3(&truth["translation_m"]));
    let mut rng = Rng::new(401);
    let mut gauss = || {
        let (u1, u2) = (rng.unit().max(1e-300), rng.unit());
        libm::sqrt(-2.0 * libm::log(u1)) * libm::cos(2.0 * std::f64::consts::PI * u2)
    };
    let mut target = Vec::new();
    for p in &source {
        let keep = gauss().abs() < 1.0364; // P(|N| < 1.0364) = 0.70
        let q = linalg::apply(&transform, p);
        let noisy = [q[0] + 0.0002 * gauss(), q[1] + 0.0002 * gauss(), q[2] + 0.0002 * gauss()];
        if keep {
            target.push(noisy);
        }
    }
    (source, target, transform)
}

#[test]
fn vc_scn_30_icp_recovers_the_bunny_motion_and_is_reproducible() {
    let (source, target, truth) = icp_a();
    assert!((target.len() as f64 / source.len() as f64 - 0.7).abs() < 0.02);
    let tree = KdTree::build(&target);
    let result = icp(&tree, &source, &linalg::IDENTITY, IcpMethod::PointToPoint, 200, 1.0);
    assert!(result.converged, "{result:?}");
    let rot = rotation_error_deg(&result.transform, &truth);
    let tr = linalg::distance(&translation(&result.transform), &translation(&truth));
    assert!(rot <= 0.05, "rotation error {rot}°");
    assert!(tr <= 0.0005, "translation error {tr} m");
    let at_truth = icp(&tree, &source, &truth, IcpMethod::PointToPoint, 1, 1.0);
    assert!(result.rms <= at_truth.rms + 1e-5, "rms {} vs {} at truth", result.rms, at_truth.rms);
    assert!(result.overlap > 0.5);
    let one_thread = rayon::ThreadPoolBuilder::new().num_threads(1).build().unwrap();
    let again = one_thread.install(|| icp(&tree, &source, &linalg::IDENTITY, IcpMethod::PointToPoint, 200, 1.0));
    assert_eq!(again.transform.map(f64::to_bits), result.transform.map(f64::to_bits), "bit-identical for any thread count");
    let plane = icp(&tree, &source, &linalg::IDENTITY, IcpMethod::PointToPlane, 100, 0.9);
    assert!(
        rotation_error_deg(&plane.transform, &truth) <= 0.05
            && linalg::distance(&translation(&plane.transform), &translation(&truth)) <= 0.0005,
        "{plane:?}"
    );
}

#[test]
fn vc_scn_32_icp_without_overlap_is_reported() {
    let (source, _, _) = icp_a();
    let mut ys: Vec<f64> = source.iter().map(|p| p[1]).collect();
    ys.sort_by(f64::total_cmp);
    let cut = ys[ys.len() / 20];
    let sliver: Vec<[f64; 3]> = source.iter().filter(|p| p[1] <= cut).copied().collect();
    let result = icp(&KdTree::build(&sliver), &source, &linalg::IDENTITY, IcpMethod::PointToPoint, 50, 0.9);
    assert!(result.overlap < 0.1, "{result:?}");
}

fn import_csv(name: &str, dir: &Path, key: &str) {
    let cloud = read(&data(name), &ImportOptions::default()).unwrap();
    let built = asset::build(&cloud, key, &"0".repeat(64), name, &ImportOptions::default()).unwrap();
    asset::write(&built, dir).unwrap();
}

#[test]
fn the_op_job_registers_targets_over_assets() {
    let root = temp_dir("opjob");
    let (k1, k2) = ("1".repeat(64), "2".repeat(64));
    import_csv("synthetic/tgt-a-station1.csv", &root.join(&k1), &k1);
    import_csv("synthetic/tgt-a-station2.csv", &root.join(&k2), &k2);
    let identity: Vec<f64> = linalg::IDENTITY.to_vec();
    let pairs: Vec<serde_json::Value> = tgt_pairs(Some(0.0725))
        .iter()
        .map(|p| serde_json::json!({ "name": p.name, "kind": "sphere", "fixed": p.fixed, "moving": p.moving, "radius": 0.0725 }))
        .collect();
    let job = serde_json::json!({
        "version": 1, "kind": "register_targets",
        "clouds": [{ "assetKey": k1, "dir": root.join(&k1), "toDocument": identity }, { "assetKey": k2, "dir": root.join(&k2), "toDocument": identity }],
        "params": { "targets": pairs }
    });
    let folder = root.join("job");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("job.json"), job.to_string()).unwrap();
    let outputs = llull_cloud::ops::run(&folder, &mut std::io::sink()).unwrap();
    assert_eq!(outputs[0].path, "result.json");
    let result: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(folder.join("result.json")).unwrap()).unwrap();
    assert_eq!(result["targets"].as_array().unwrap().len(), 4);
    assert_eq!(result["device"], "cpu");
    assert!(result["rms"].as_f64().unwrap() < 0.003);
    let bad = serde_json::json!({ "version": 1, "kind": "nope", "clouds": [], "params": {} });
    std::fs::write(folder.join("job.json"), bad.to_string()).unwrap();
    assert_eq!(llull_cloud::ops::run(&folder, &mut std::io::sink()).unwrap_err().code, "NATIVE_JOB_INPUT");
}

//! VC-SCN-60 GPU rows (RS-4): (b) the GPU-pruned clash on CLH-A equals the CPU-only result exactly; (c) GPU deviation distances on DEV-A
//! are within ε_gpu of the CPU's f64 values, the picture says deterministic false, and the recorded numbers are the CPU's. Runs where an
//! adapter exists and skips with the logged reason otherwise (RS1 §2 rule 6); the CPU twins are tested in tests/compare.rs.
#![cfg(feature = "gpu")]

mod common;

use common::{csv, json, vec3};
use llull_cloud::compare::{assignments, clash, clash_candidates, ClashSettings};
use llull_cloud::distance::{Entity, EntitySpec, PipeAxis, Primitive};
use llull_cloud::gpu;

/// One GPU test at a time: concurrent device creation from the test threads crashed the Vulkan driver (STATUS_ACCESS_VIOLATION).
static GPU: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn serial() -> std::sync::MutexGuard<'static, ()> {
    GPU.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn adapter() -> Option<String> {
    match llull_gpu::device::acquire("llull-cloud test") {
        Ok(found) => {
            eprintln!("adapter: {}", found.adapter);
            Some(found.adapter)
        }
        Err(reason) => {
            eprintln!("skipped: GPU unavailable ({reason})");
            None
        }
    }
}

fn dev_a_specs() -> Vec<EntitySpec> {
    let design = &json("synthetic_truth.json")["cases"]["DEV-A"]["design"];
    let (start, end, radius) = (vec3(&design["start"]), vec3(&design["end"]), design["radius_m"].as_f64().unwrap());
    let mut tube = Vec::new();
    let ring = |x: f64, k: usize| -> [f64; 3] {
        let t = std::f64::consts::TAU * k as f64 / 64.0;
        [x, start[1] + radius * libm::cos(t), start[2] + radius * libm::sin(t)]
    };
    for k in 0..64 {
        let (a, b, c, d) = (ring(0.0, k), ring(0.0, k + 1), ring(2.0, k + 1), ring(2.0, k));
        for v in [a, b, c, a, c, d] {
            tube.extend(v);
        }
    }
    vec![
        EntitySpec {
            id: "analytic".into(),
            primitives: vec![Primitive::Cylinder { start, end, radius }],
            pipe: Some(PipeAxis { start, end, radius }),
        },
        EntitySpec { id: "mesh".into(), primitives: vec![Primitive::Mesh { triangles: tube }], pipe: None },
    ]
}

#[test]
fn vc_scn_60c_gpu_deviation_is_within_epsilon_of_the_cpu() {
    let _gpu = serial();
    if adapter().is_none() {
        return;
    }
    let points = csv("synthetic/clh-a.csv");
    for spec in dev_a_specs() {
        let specs = vec![spec];
        let entities: Vec<Entity> = specs.iter().map(Entity::prepare).collect();
        let cpu = assignments(&points, &entities, 0.1);
        let first = gpu::nearest(&points, &specs, 0.1).unwrap();
        let second = gpu::nearest(&points, &specs, 0.1).unwrap();
        let mut worst = 0.0f64;
        for ((g, again), c) in first.nearest.iter().zip(&second.nearest).zip(&cpu) {
            let ((ge, gd), (ce, cd)) = (g.unwrap(), c.unwrap());
            assert_eq!(ge, ce);
            worst = worst.max((gd - cd).abs());
            assert_eq!(g.map(|x| x.1.to_bits()), again.map(|x| x.1.to_bits()), "repeatable on one device");
        }
        eprintln!("{}: largest |d_gpu - d_cpu| = {worst:.3e} m, epsilon_gpu = {:.3e} m", specs[0].id, first.epsilon);
        assert!(worst <= first.epsilon, "{}: {worst} > epsilon {}", specs[0].id, first.epsilon);
    }
}

#[test]
fn vc_scn_60b_gpu_pruned_clash_equals_the_cpu_result() {
    let _gpu = serial();
    if adapter().is_none() {
        return;
    }
    let case = &json("synthetic_truth.json")["cases"]["CLH-A"];
    let points = csv("synthetic/clh-a.csv");
    let specs: Vec<EntitySpec> = case["designs"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(i, d)| {
            let off = vec3(&d["designAxisOffset_m"]);
            EntitySpec {
                id: format!("new-{i}"),
                primitives: vec![Primitive::Cylinder {
                    start: off,
                    end: [off[0] + 2.0, off[1], off[2]],
                    radius: d["designRadius_m"].as_f64().unwrap(),
                }],
                pipe: None,
            }
        })
        .collect();
    let entities: Vec<Entity> = specs.iter().map(Entity::prepare).collect();
    let settings = ClashSettings { clearance: 0.075, min_points: 10, search_distance: 1.0 };
    let exclude = vec![None; entities.len()];
    let (cpu, spacing) = clash(&points, &entities, &exclude, &settings);
    let (kept, _, eps) = gpu::prune(&points, &specs, 1.0).unwrap();
    let pruned = kept.iter().map(|k| points.len() - k.len()).sum::<usize>();
    eprintln!("prune dropped {pruned} of {} point-entity pairs, epsilon {eps:.3e} m", points.len() * specs.len());
    let (with_gpu, spacing_gpu) = clash_candidates(&points, &entities, &exclude, &settings, Some(&kept));
    assert_eq!(spacing.to_bits(), spacing_gpu.to_bits());
    assert_eq!(
        serde_json::to_string(&cpu).unwrap(),
        serde_json::to_string(&with_gpu).unwrap(),
        "statuses, clusters and gaps are identical"
    );
    // A tighter reach prunes for real and still matches.
    let tight = ClashSettings { search_distance: 0.0, ..settings };
    let (cpu_tight, _) = clash(&points, &entities, &exclude, &tight);
    let (kept_tight, _, _) = gpu::prune(&points, &specs, 0.075).unwrap();
    assert!(kept_tight.iter().any(|k| k.len() < points.len()));
    let (gpu_tight, _) = clash_candidates(&points, &entities, &exclude, &tight, Some(&kept_tight));
    assert_eq!(serde_json::to_string(&cpu_tight).unwrap(), serde_json::to_string(&gpu_tight).unwrap());
}

#[test]
fn boxes_spheres_and_meshes_agree_with_the_cpu_twin() {
    let _gpu = serial();
    if adapter().is_none() {
        return;
    }
    let mut rng = llull_cloud::kdtree::Rng::new(21);
    let points: Vec<[f64; 3]> = (0..20_000).map(|_| [rng.unit() * 4.0 - 2.0, rng.unit() * 4.0 - 2.0, rng.unit() * 4.0 - 2.0]).collect();
    let tilt = [0.8, 0.6, 0.0];
    let specs = vec![
        EntitySpec {
            id: "box".into(),
            primitives: vec![Primitive::Box {
                centre: [0.5, 0.0, 0.0],
                axes: [tilt, [-0.6, 0.8, 0.0], [0.0, 0.0, 1.0]],
                half: [0.3, 0.2, 0.5],
            }],
            pipe: None,
        },
        EntitySpec { id: "ball".into(), primitives: vec![Primitive::Sphere { centre: [-1.0, 1.0, 0.0], radius: 0.4 }], pipe: None },
        EntitySpec {
            id: "plate".into(),
            primitives: vec![Primitive::Mesh {
                triangles: vec![-1.5, -1.5, -1.0, 1.5, -1.5, -1.0, 1.5, 1.5, -1.0, -1.5, -1.5, -1.0, 1.5, 1.5, -1.0, -1.5, 1.5, -1.0],
            }],
            pipe: None,
        },
    ];
    let entities: Vec<Entity> = specs.iter().map(Entity::prepare).collect();
    let cpu = assignments(&points, &entities, 0.5);
    let result = gpu::nearest(&points, &specs, 0.5).unwrap();
    let mut compared = 0;
    for (g, c) in result.nearest.iter().zip(&cpu) {
        if let (Some((ge, gd)), Some((ce, cd))) = (g, c) {
            if ge == ce {
                compared += 1;
                assert!((gd - cd).abs() <= result.epsilon, "entity {ge}: {gd} vs {cd}");
            }
        }
    }
    assert!(compared > 1000, "{compared}");
}

#[test]
fn the_op_job_honours_device_gpu_and_falls_back_with_a_warning() {
    let _gpu = serial();
    if adapter().is_none() {
        return;
    }
    let root = common::temp_dir("gpuops");
    let key = "4".repeat(64);
    let options = llull_cloud::read::ImportOptions::default();
    let cloud = llull_cloud::read::read(&common::data("synthetic/clh-a.csv"), &options).unwrap();
    let built = llull_cloud::asset::build(&cloud, &key, &"0".repeat(64), "clh-a.csv", &options).unwrap();
    llull_cloud::asset::write(&built, &root.join(&key)).unwrap();
    let folder = root.join("job");
    std::fs::create_dir_all(&folder).unwrap();
    let identity: Vec<f64> = llull_cloud::linalg::IDENTITY.to_vec();
    let design = serde_json::json!([{ "id": "new", "primitives": [{ "kind": "cylinder", "start": [0, 0, 0.15], "end": [2, 0, 0.15], "radius": 0.08415 }] }]);
    let run = |kind: &str, device: &str| -> (serde_json::Value, String) {
        let params = if kind == "clash" {
            serde_json::json!({ "entities": design, "clearance": 0.075, "device": device })
        } else {
            serde_json::json!({ "entities": design, "maxDistance": 0.3, "threshold": 0.01, "device": device })
        };
        let cloud = serde_json::json!({ "assetKey": key, "dir": root.join(&key), "toDocument": identity });
        let job = serde_json::json!({ "version": 1, "kind": kind, "clouds": [cloud], "params": params });
        std::fs::write(folder.join("job.json"), job.to_string()).unwrap();
        let mut events = Vec::new();
        llull_cloud::ops::run(&folder, &mut events).unwrap();
        let result = serde_json::from_str(&std::fs::read_to_string(folder.join("result.json")).unwrap()).unwrap();
        (result, String::from_utf8(events).unwrap())
    };
    let (cpu, _) = run("clash", "cpu");
    let (gpu, _) = run("clash", "gpu");
    assert_eq!(cpu["results"], gpu["results"]);
    assert_eq!(gpu["device"], "gpu");
    assert_eq!(gpu["deterministic"], true);
    let (picture, _) = run("deviation", "gpu");
    let (numbers, _) = run("deviation", "cpu");
    assert_eq!(picture["entities"], numbers["entities"], "the recorded numbers are the CPU's");
    assert_eq!(picture["deterministic"], false);
    assert!(picture["gpu"]["maxDifferenceFromCpu"].as_f64().unwrap() <= picture["gpu"]["epsilon"].as_f64().unwrap());
    std::env::set_var("LLULL_GPU", "off");
    let (fallback, events) = run("clash", "gpu");
    std::env::remove_var("LLULL_GPU");
    assert!(events.contains("SCN_GPU_FALLBACK"), "{events}");
    assert_eq!(fallback["device"], "cpu");
    assert_eq!(fallback["results"], cpu["results"]);
}

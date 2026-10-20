//! Scene twin vs the TypeScript render raster (plant 09 VC-VIS-60 at crate level): `tests/unit/native/sceneRasterReference.test.ts`
//! writes the RasterScene buffers render_view prepares and the sha256 of the RGBA `rasterScenePixels` produced; the CPU twin must hash
//! identically, also through a job folder (`llull_raster::run`). With the `gpu` feature the wgpu fill is compared by tolerance
//! (coverage IoU and mean colour difference), never by hash, and skipped with the reason when no adapter exists.

use llull_protocol::sha256_hex;
use llull_raster::scene::{check, Projection, Scene};
use llull_raster::{scene_cpu, Produced};
use serde_json::Value;
use std::fs;

fn numbers(value: &Value) -> Vec<f64> {
    value.as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect()
}

struct Case {
    name: String,
    scene: Scene,
    job: Value,
    rgba_sha256: String,
}

fn cases() -> Vec<Case> {
    let text = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/scene.json")).unwrap();
    let all: Value = serde_json::from_str(&text).unwrap();
    all.as_array()
        .unwrap()
        .iter()
        .map(|case| {
            let job = &case["job"];
            let scene = Scene {
                width: job["width"].as_u64().unwrap() as usize,
                height: job["height"].as_u64().unwrap() as usize,
                samples: job["samples"].as_u64().unwrap() as usize,
                projection: if job["projection"] == "perspective" { Projection::Perspective } else { Projection::Orthographic },
                depth_jump: job["depthJump"].as_f64().unwrap(),
                crease_cos: job["creaseCos"].as_f64().unwrap(),
                faces: numbers(&case["faces"]),
                fills: numbers(&case["fills"]),
                loops: numbers(&case["loops"]),
                points: numbers(&case["points"]),
                strokes: numbers(&case["strokes"]),
            };
            Case {
                name: case["name"].as_str().unwrap().to_string(),
                scene,
                job: job.clone(),
                rgba_sha256: case["rgbaSha256"].as_str().unwrap().to_string(),
            }
        })
        .collect()
}

#[test]
fn cpu_twin_is_bit_identical_to_the_typescript_scene_raster() {
    let all = cases();
    assert_eq!(all.len(), 5);
    for case in all {
        check(&case.scene).unwrap();
        let rgba = scene_cpu::raster_pixels(&case.scene);
        assert_eq!(rgba.len(), case.scene.width * case.scene.height * 4, "{}", case.name);
        assert_eq!(sha256_hex(&rgba), case.rgba_sha256, "{}: RGBA differs from the TypeScript reference", case.name);
    }
}

fn f64_file(values: &[f64]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
}

fn job_folder(case: &Case, engine: &str) -> std::path::PathBuf {
    let folder = std::env::temp_dir().join(format!("llull-scene-test-{}-{engine}-{}", case.name, std::process::id()));
    fs::create_dir_all(&folder).unwrap();
    let mut job = case.job.clone();
    job["engine"] = Value::String(engine.to_string());
    fs::write(folder.join("job.json"), job.to_string()).unwrap();
    let s = &case.scene;
    for (name, values) in [("faces", &s.faces), ("fills", &s.fills), ("loops", &s.loops), ("points", &s.points), ("strokes", &s.strokes)] {
        fs::write(folder.join(format!("{name}.f64")), f64_file(values)).unwrap();
    }
    folder
}

#[test]
fn a_scene_job_folder_writes_the_reference_rgba() {
    let case = cases().into_iter().next().unwrap();
    let folder = job_folder(&case, "cpu");
    let (outputs, produced) = llull_raster::run(&folder).unwrap();
    assert_eq!(produced, Produced::Cpu);
    assert_eq!(outputs.len(), 1);
    assert_eq!(outputs[0].path, "rgba.bin");
    assert_eq!(outputs[0].sha256, case.rgba_sha256);
    assert_eq!(sha256_hex(&fs::read(folder.join("rgba.bin")).unwrap()), case.rgba_sha256);
    fs::remove_dir_all(folder).unwrap();
}

#[test]
fn malformed_scenes_are_refused() {
    let base = cases().into_iter().next().unwrap().scene;
    let refused = |scene: Scene| check(&scene).unwrap_err().code;
    assert_eq!(refused(Scene { faces: vec![0.0; 7], ..base.clone() }), "NATIVE_JOB_INPUT");
    assert_eq!(refused(Scene { width: 0, ..base.clone() }), "NATIVE_JOB_INPUT");
    assert_eq!(refused(Scene { fills: vec![1e9, 0.0, 1.0], ..base.clone() }), "NATIVE_JOB_INPUT");
    assert_eq!(refused(Scene { loops: vec![0.0, 1e9], ..base.clone() }), "NATIVE_JOB_INPUT");
    let mut stroke = vec![0.0; 9];
    stroke[0] = 1e9;
    assert_eq!(refused(Scene { strokes: stroke, ..base.clone() }), "NATIVE_JOB_INPUT");
    let folder = std::env::temp_dir().join(format!("llull-scene-test-bad-{}", std::process::id()));
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("job.json"), r#"{"kind":"scene","width":2}"#).unwrap();
    assert_eq!(llull_raster::run(&folder).unwrap_err().code, "NATIVE_JOB_INPUT");
    fs::write(folder.join("job.json"), "not json").unwrap();
    assert_eq!(llull_raster::run(&folder).unwrap_err().code, "NATIVE_JOB_INPUT");
    fs::remove_dir_all(folder).unwrap();
}

/// VC-VIS-60 GPU tolerance: coverage IoU ≥ 0.97 and mean |ΔRGB| ≤ 8 levels over the pixels both images cover.
#[cfg(feature = "gpu")]
#[test]
fn gpu_scene_raster_matches_the_reference_within_tolerance() {
    for case in cases() {
        let reference = scene_cpu::raster_pixels(&case.scene);
        let (gpu, adapter) = match llull_raster::scene_gpu::raster_pixels(&case.scene) {
            Ok(result) => result,
            Err(reason) => {
                eprintln!("skipped: GPU scene raster unavailable ({reason})");
                return;
            }
        };
        let (mut both, mut either, mut diff_sum, mut diff_count) = (0usize, 0usize, 0f64, 0usize);
        for (a, b) in reference.chunks_exact(4).zip(gpu.chunks_exact(4)) {
            let (ca, cb) = (a[3] > 0, b[3] > 0);
            either += usize::from(ca || cb);
            if ca && cb {
                both += 1;
                for k in 0..3 {
                    diff_sum += (f64::from(a[k]) - f64::from(b[k])).abs();
                    diff_count += 1;
                }
            }
        }
        let iou = both as f64 / either.max(1) as f64;
        let mean = diff_sum / diff_count.max(1) as f64;
        eprintln!("{} on {adapter}: coverage IoU {iou:.4}, mean |dRGB| {mean:.2}", case.name);
        assert!(iou >= 0.97, "{}: coverage IoU {iou}", case.name);
        assert!(mean <= 8.0, "{}: mean colour difference {mean}", case.name);
    }
}

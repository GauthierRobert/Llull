//! The wgpu path tracer (feature `gpu`): white furnace, statistical agreement with the CPU integrator on a reference scene with every
//! material lobe, texture, an HDR environment, sun + area lights and instancing, the forced fallback, the time stop and the noise stop.
//! The GPU tests run on any adapter (lavapipe in CI containers); without one they log the reason and skip, like the raster GPU tests.
#![cfg(feature = "gpu")]

mod common;

use common::{icosphere, lambert, material, mean, perspective, quad, rgb, SceneBuilder, IDENTITY};
use image::{ImageFormat, Rgb, Rgba, RgbaImage};
use llull_pathtrace::engine::GpuAccess;
use llull_pathtrace::render::Image;
use llull_pathtrace::{render_job, render_job_with, Rendered};
use serde_json::json;
use std::io::Cursor;

/// The adapter the GPU path will use, or `None` (logged) when there is none.
fn adapter(test: &str) -> Option<String> {
    match llull_gpu::device::acquire("llull-pathtrace probe") {
        Ok(gpu) => Some(gpu.name),
        Err(reason) => {
            eprintln!("{test} skipped: no GPU adapter ({reason})");
            None
        }
    }
}

/// Renders on the GPU and checks that the GPU, not the fallback, rendered.
fn on_gpu(b: &mut SceneBuilder, name: &str, adapter: &str) -> Rendered {
    b.set("engine", json!("gpu"));
    let rendered = render_job(&b.load(name));
    assert_eq!(rendered.stats.device, adapter, "{name}: fell back ({:?})", rendered.stats.fallback_reason);
    assert!(rendered.stats.fallback_reason.is_none() && !rendered.stats.deterministic, "{name}: {:?}", rendered.stats);
    rendered
}

#[test]
fn gpu_white_furnace_lambert_sphere_returns_the_environment_everywhere() {
    let Some(adapter) = adapter("gpu furnace") else { return };
    let mut b = SceneBuilder::new(32, 32, 32);
    b.camera = perspective([0.0, -4.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], 0.7);
    b.environment = json!({ "type": "color", "color": [1.0, 1.0, 1.0], "intensity": 1.0 });
    b.set("maxBounces", json!(32));
    let m = b.add_material(lambert(1.0));
    let sphere = b.add_mesh(&icosphere(1.0, 3));
    b.add_instance(sphere, m, IDENTITY);
    let image = on_gpu(&mut b, "gpu-furnace", &adapter).image;
    for i in 0..image.beauty.len() {
        let p = rgb(&image, i);
        assert!(p.iter().all(|c| (c - 1.0).abs() <= 0.01), "pixel {i}: {p:?}");
    }
}

fn png_bytes(image: &RgbaImage) -> Vec<u8> {
    let mut bytes = Vec::new();
    image.write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png).unwrap();
    bytes
}

/// A sky-like HDR map: brighter towards the zenith, a warm patch at one azimuth.
fn hdr_map() -> Vec<u8> {
    let (w, h) = (64usize, 32usize);
    let mut pixels = Vec::with_capacity(w * h);
    for y in 0..h {
        for x in 0..w {
            let up = 1.0 - y as f32 / h as f32;
            let patch = if (40..48).contains(&x) && (6..12).contains(&y) { 6.0 } else { 0.0 };
            pixels.push(Rgb([0.2 + 0.6 * up + patch, 0.25 + 0.7 * up + 0.5 * patch, 0.35 + 0.9 * up]));
        }
    }
    let mut bytes = Vec::new();
    image::codecs::hdr::HdrEncoder::new(&mut bytes).encode(&pixels, w, h).unwrap();
    bytes
}

fn scaled(s: f64, t: [f64; 3]) -> [f64; 12] {
    [s, 0.0, 0.0, t[0], 0.0, s, 0.0, t[1], 0.0, 0.0, s, t[2]]
}

/// Floor with a texture and a normal map, a metal, a glass and a coated ball (one mesh, three instances), HDR environment, a sun
/// cone and an area light.
fn reference_scene(width: u32, height: u32, samples: u32, seed: u32) -> SceneBuilder {
    let mut b = SceneBuilder::new(width, height, samples);
    b.camera = perspective([0.0, -6.0, 2.0], [0.0, 0.9486833, -0.3162278], [0.0, 0.3162278, 0.9486833], 0.75);
    b.set("seed", json!(seed)).set("maxBounces", json!(8));
    let env = b.add_texture("hdr", "hdr", "linear", hdr_map());
    b.environment = json!({ "type": "hdr", "texture": env, "rotation": 0.6, "intensity": 0.8 });
    b.lights.push(json!({ "type": "sun", "direction": [0.4, -0.5, 0.7681146], "irradiance": [2.5, 2.4, 2.2], "angularRadius": 0.12,
                          "castShadows": true }));
    b.lights.push(json!({ "type": "area", "position": [-1.5, -1.0, 3.0], "uAxis": [1.0, 0.0, 0.0], "vAxis": [0.0, 0.8, 0.0],
                          "normal": [0.0, 0.0, -1.0], "power": [12.0, 12.0, 12.0], "castShadows": true }));
    let checker =
        RgbaImage::from_fn(32, 32, |x, y| if (x / 8 + y / 8) % 2 == 0 { Rgba([200, 180, 150, 255]) } else { Rgba([60, 90, 140, 255]) });
    let base = b.add_texture("png", "png", "srgb", png_bytes(&checker));
    let bumps = RgbaImage::from_fn(8, 8, |x, _| Rgba([if x % 2 == 0 { 100 } else { 156 }, 128, 240, 255]));
    let normal = b.add_texture("png", "png", "linear", png_bytes(&bumps));
    let floor = b.add_material(material(json!({ "baseColorTexture": base, "normalTexture": normal, "roughness": 0.7 })));
    let metal = b.add_material(material(json!({ "baseColor": [0.95, 0.75, 0.4], "metalness": 1.0, "roughness": 0.3 })));
    let glass = b.add_material(material(json!({ "baseColor": [1.0, 1.0, 1.0], "transmission": 1.0, "roughness": 0.25 })));
    let coat = b.add_material(material(json!({ "baseColor": [0.7, 0.1, 0.1], "roughness": 0.6, "coat": 1.0, "coatRoughness": 0.1 })));
    let plane = b.add_mesh(&quad(12.0, -1.0));
    let ball = b.add_mesh(&icosphere(1.0, 2));
    b.add_instance(plane, floor, IDENTITY);
    b.add_instance(ball, metal, scaled(0.8, [-1.8, 0.5, -0.2]));
    b.add_instance(ball, glass, scaled(0.7, [0.0, -0.4, -0.3]));
    b.add_instance(ball, coat, scaled(0.9, [1.9, 0.8, -0.1]));
    b
}

fn channels(image: &Image) -> Vec<[f64; 3]> {
    (0..image.beauty.len()).map(|i| rgb(image, i).map(f64::from)).collect()
}

fn mean_square(a: &[[f64; 3]], b: &[[f64; 3]]) -> f64 {
    a.iter().zip(b).map(|(x, y)| (0..3).map(|k| (x[k] - y[k]).powi(2)).sum::<f64>()).sum::<f64>() / (3 * a.len()) as f64
}

#[test]
fn gpu_agrees_with_the_cpu_on_a_reference_scene() {
    let Some(adapter) = adapter("gpu reference") else { return };
    let (w, h, n) = (48, 36, 64);
    let half_a = channels(&render_job(&reference_scene(w, h, 2048, 101).load("gpu-ref-a")).image);
    let half_b = channels(&render_job(&reference_scene(w, h, 2048, 202).load("gpu-ref-b")).image);
    let reference: Vec<[f64; 3]> = half_a.iter().zip(&half_b).map(|(a, b)| [0, 1, 2].map(|k| 0.5 * (a[k] + b[k]))).collect();
    let reference_variance = mean_square(&half_a, &half_b) / 4.0;
    let cpu_image = render_job(&reference_scene(w, h, n, 7).load("gpu-ref-cpu")).image;
    let gpu_image = on_gpu(&mut reference_scene(w, h, n, 7), "gpu-ref-gpu", &adapter).image;
    let rmse = |image: &Image| (mean_square(&channels(image), &reference) - reference_variance).max(0.0).sqrt();
    let (cpu_rmse, gpu_rmse) = (rmse(&cpu_image), rmse(&gpu_image));
    let (cpu_mean, gpu_mean) = (mean(&cpu_image), mean(&gpu_image));
    let reference_mean = [0, 1, 2].map(|k| reference.iter().map(|p| p[k]).sum::<f64>() / reference.len() as f64);
    eprintln!("{adapter}: means cpu {cpu_mean:?} gpu {gpu_mean:?} reference {reference_mean:?}; rmse cpu {cpu_rmse:.4} gpu {gpu_rmse:.4}");
    for k in 0..3 {
        assert!((gpu_mean[k] / reference_mean[k] - 1.0).abs() <= 0.02, "channel {k}: gpu {gpu_mean:?} reference {reference_mean:?}");
    }
    assert!(gpu_rmse <= 1.3 * cpu_rmse, "rmse gpu {gpu_rmse} cpu {cpu_rmse}");
}

#[test]
fn a_gpu_request_without_a_gpu_falls_back_with_the_reason() {
    let mut b = reference_scene(16, 12, 4, 1);
    b.set("engine", json!("gpu"));
    let rendered = render_job_with(&b.load("gpu-forced-off"), &GpuAccess::Unavailable("GPU forced off".to_string()));
    assert_eq!(rendered.stats.device, "cpu");
    assert_eq!(rendered.stats.fallback_reason.as_deref(), Some("GPU forced off; rendered on the CPU"));
    assert!(rendered.stats.deterministic);
    assert!(rendered.warnings.iter().any(|w| w.code == "PATHTRACE_GPU_FALLBACK"), "{:?}", rendered.warnings);
}

#[test]
fn gpu_max_seconds_stops_the_render_and_marks_it_not_deterministic() {
    let Some(adapter) = adapter("gpu time stop") else { return };
    let mut b = reference_scene(64, 48, 65536, 3);
    b.set("maxSeconds", json!(0.5));
    let rendered = on_gpu(&mut b, "gpu-time", &adapter);
    assert_eq!(rendered.stats.stopped_by, "time");
    assert!(rendered.stats.samples >= 1.0 && rendered.stats.samples < 65536.0, "{:?}", rendered.stats);
    assert!(rendered.stats.elapsed_ms < 30_000.0, "{:?}", rendered.stats);
    assert!(rendered.warnings.iter().any(|w| w.code == "PATHTRACE_TIME_LIMIT"));
}

#[test]
fn gpu_target_noise_stops_a_converged_tile_early() {
    let Some(adapter) = adapter("gpu noise stop") else { return };
    // A Lambert plane under a uniform sky converges at once (every path returns rho x L): the first check at 16 samples stops it.
    let mut b = SceneBuilder::new(40, 24, 4096);
    b.camera = common::ortho_down(0.5, 5.0);
    b.environment = json!({ "type": "color", "color": [1.0, 1.0, 1.0], "intensity": 1.0 });
    b.set("targetNoise", json!(0.01));
    let m = b.add_material(lambert(0.5));
    let plane = b.add_mesh(&quad(100.0, 0.0));
    b.add_instance(plane, m, IDENTITY);
    let rendered = on_gpu(&mut b, "gpu-noise", &adapter);
    assert_eq!(rendered.stats.stopped_by, "noise");
    assert_eq!(rendered.stats.samples, 16.0);
    let m = mean(&rendered.image);
    assert!(m.iter().all(|c| (c - 0.5).abs() < 0.005), "{m:?}");
}

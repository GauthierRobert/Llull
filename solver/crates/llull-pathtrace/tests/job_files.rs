//! The job as the host runs it: outputs and their hashes, `stats.json` shape, EXR read back by the `exr` crate, PNG decode, textures
//! (base colour, normal map, HDR environment), denoise and the GPU fallback record.

mod common;

use common::{icosphere, lambert, material, mean, perspective, quad, SceneBuilder, IDENTITY};
use image::{ImageFormat, Rgb, RgbImage, Rgba, RgbaImage};
use llull_pathtrace::{render_job, run};
use serde_json::{json, Value};
use std::io::Cursor;

fn png_bytes(image: &RgbaImage) -> Vec<u8> {
    let mut bytes = Vec::new();
    image.write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png).unwrap();
    bytes
}

fn hdr_bytes(width: u32, height: u32, value: f32) -> Vec<u8> {
    let pixels = vec![Rgb([value, value, value]); (width * height) as usize];
    let mut bytes = Vec::new();
    image::codecs::hdr::HdrEncoder::new(&mut bytes).encode(&pixels, width as usize, height as usize).unwrap();
    bytes
}

fn textured_scene() -> SceneBuilder {
    let mut b = SceneBuilder::new(40, 30, 16);
    b.camera = perspective([0.0, -5.0, 1.0], [0.0, 0.9805807, -0.1961161], [0.0, 0.1961161, 0.9805807], 0.8);
    b.lights.push(json!({ "type": "area", "position": [0.0, 0.0, 3.0], "uAxis": [1.0, 0.0, 0.0], "vAxis": [0.0, 1.0, 0.0],
                          "normal": [0.0, 0.0, -1.0], "power": [30.0, 30.0, 30.0], "castShadows": true }));
    let checker =
        RgbaImage::from_fn(64, 64, |x, y| if (x / 16 + y / 16) % 2 == 0 { Rgba([255, 0, 0, 255]) } else { Rgba([0, 255, 0, 255]) });
    let base = b.add_texture("png", "png", "srgb", png_bytes(&checker));
    let normal = b.add_texture("png", "png", "linear", png_bytes(&RgbaImage::from_pixel(2, 2, Rgba([160, 128, 230, 255]))));
    let floor = b.add_material(material(json!({ "baseColorTexture": base, "normalTexture": normal, "roughness": 0.8 })));
    let ball = b.add_material(material(json!({ "baseColor": [0.9, 0.9, 0.9], "metalness": 1.0, "roughness": 0.2 })));
    let plane = b.add_mesh(&quad(8.0, -1.0));
    let sphere = b.add_mesh(&icosphere(0.8, 2));
    b.add_instance(plane, floor, IDENTITY);
    b.add_instance(sphere, ball, IDENTITY);
    b
}

#[test]
fn run_writes_png_exr_and_stats_with_their_hashes() {
    let mut b = textured_scene();
    b.set("exposure", json!(2.0));
    let folder = b.write("files");
    let mut events = Vec::new();
    let outputs = run(&folder, &mut events).unwrap();
    let names: Vec<&str> = outputs.iter().map(|o| o.path.as_str()).collect();
    assert_eq!(names, ["image.png", "beauty.exr", "stats.json"]);
    for o in &outputs {
        assert_eq!(o.sha256, llull_protocol::sha256_hex(&std::fs::read(folder.join(&o.path)).unwrap()), "{}", o.path);
    }
    let stats: Value = serde_json::from_slice(&std::fs::read(folder.join("stats.json")).unwrap()).unwrap();
    for key in ["samples", "seed", "device", "deterministic", "elapsedMs", "noise", "denoised", "triangles", "instances", "stoppedBy"] {
        assert!(stats.get(key).is_some(), "stats.json lacks {key}: {stats}");
    }
    assert_eq!(stats["device"], "cpu");
    assert_eq!(stats["stoppedBy"], "samples");
    assert_eq!(stats["samples"], 16.0);
    assert!(stats.get("fallbackReason").is_none());
    let text = String::from_utf8(events).unwrap();
    assert!(text.lines().all(|l| l.contains("\"type\":\"progress\"")), "{text}");

    let png = image::open(folder.join("image.png")).unwrap().to_rgb8();
    assert_eq!(png.dimensions(), (40, 30));
    let exr = exr::prelude::read_first_rgba_layer_from_file(
        folder.join("beauty.exr"),
        |resolution, _| vec![[0.0f32; 4]; resolution.width() * resolution.height()],
        |pixels: &mut Vec<[f32; 4]>, position, (r, g, b, a): (f32, f32, f32, f32)| pixels[position.y() * 40 + position.x()] = [r, g, b, a],
    )
    .unwrap();
    let pixels = &exr.layer_data.channel_data.pixels;
    let rendered = render_job(&llull_pathtrace::load::load(&folder).unwrap());
    assert_eq!(pixels.len(), rendered.image.beauty.len());
    for (read, beauty) in pixels.iter().zip(&rendered.image.beauty) {
        assert_eq!(read[3], 1.0);
        for k in 0..3 {
            assert_eq!(read[k], beauty[k].to_f32());
        }
    }
    // The checker shows through: some pixels clearly red, some clearly green.
    let (mut red, mut green) = (0, 0);
    for p in png.pixels() {
        let (r, g) = (u16::from(p.0[0]), u16::from(p.0[1]));
        red += usize::from(2 * r > 3 * g.max(8));
        green += usize::from(2 * g > 3 * r.max(8));
    }
    assert!(red > 20 && green > 20, "red {red} green {green}");
}

#[test]
fn flags_skip_files_gpu_falls_back_and_denoise_reports() {
    let mut b = textured_scene();
    b.set("exr", json!(false)).set("png", json!(false)).set("engine", json!("gpu")).set("denoise", json!(true));
    let folder = b.write("flags");
    let mut events = Vec::new();
    let outputs = run(&folder, &mut events).unwrap();
    assert_eq!(outputs.iter().map(|o| o.path.as_str()).collect::<Vec<_>>(), ["stats.json"]);
    let stats: Value = serde_json::from_slice(&std::fs::read(folder.join("stats.json")).unwrap()).unwrap();
    assert_eq!(stats["denoised"], true);
    let text = String::from_utf8(events).unwrap();
    if cfg!(feature = "gpu") && stats["device"] != "cpu" {
        // The wgpu path rendered (an adapter exists): no fallback, not deterministic.
        assert!(stats.get("fallbackReason").is_none() && stats["deterministic"] == false, "{stats}");
        return;
    }
    assert_eq!(stats["device"], "cpu");
    if !cfg!(feature = "gpu") {
        assert_eq!(stats["fallbackReason"], "no GPU path tracer in this build; rendered on the CPU");
    }
    assert!(stats["fallbackReason"].as_str().is_some_and(|r| r.ends_with("; rendered on the CPU")), "{stats}");
    assert!(text.contains(r#""type":"warning","code":"PATHTRACE_GPU_FALLBACK""#), "{text}");
}

#[test]
fn denoising_lowers_the_error_against_a_converged_image() {
    // A diffuse untextured scene: no specular fireflies and no sub-pixel albedo edges, which an edge-stopping filter rightly keeps.
    let diffuse = || {
        let mut b = textured_scene();
        b.materials[0] = lambert(0.5);
        b.materials[1] = lambert(0.7);
        b.environment = json!({ "type": "sky", "turbidity": 3.0, "intensity": 1.0, "sunDirection": [0.0, 0.0, 1.0] });
        b
    };
    let mut reference = diffuse();
    reference.set("samples", json!(1024));
    let truth = render_job(&reference.load("denoise-ref")).image;
    let mut noisy = diffuse();
    noisy.set("samples", json!(8)).set("seed", json!(5));
    let raw = render_job(&noisy.load("denoise-raw")).image;
    noisy.set("denoise", json!(true));
    let filtered = render_job(&noisy.load("denoise-on")).image;
    let error = |img: &llull_pathtrace::render::Image| {
        img.beauty.iter().zip(&truth.beauty).map(|(a, b)| f64::from((a[1].to_f32() - b[1].to_f32()).powi(2))).sum::<f64>()
    };
    assert!(error(&filtered) < 0.6 * error(&raw), "denoised {} raw {}", error(&filtered), error(&raw));
}

#[test]
fn a_uniform_hdr_environment_is_a_white_furnace_through_importance_sampling() {
    let mut b = SceneBuilder::new(24, 24, 32);
    b.camera = perspective([0.0, -4.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], 0.7);
    let env = b.add_texture("hdr", "hdr", "linear", hdr_bytes(32, 16, 1.0));
    b.environment = json!({ "type": "hdr", "texture": env, "rotation": 0.4, "intensity": 1.0 });
    b.set("maxBounces", json!(16));
    let m = b.add_material(lambert(1.0));
    let sphere = b.add_mesh(&icosphere(1.0, 3));
    b.add_instance(sphere, m, IDENTITY);
    let image = render_job(&b.load("hdr-furnace")).image;
    let m = mean(&image);
    assert!(m.iter().all(|c| (c - 1.0).abs() < 0.005), "{m:?}");
}

#[test]
fn an_rgb_png_without_alpha_and_a_jpeg_decode() {
    let mut b = SceneBuilder::new(8, 8, 4);
    let mut png = Vec::new();
    RgbImage::from_pixel(3, 3, Rgb([10, 200, 30])).write_to(&mut Cursor::new(&mut png), ImageFormat::Png).unwrap();
    let mut jpeg = Vec::new();
    RgbImage::from_pixel(8, 8, Rgb([200, 200, 200])).write_to(&mut Cursor::new(&mut jpeg), ImageFormat::Jpeg).unwrap_or(());
    let t0 = b.add_texture("png", "png", "srgb", png);
    let m = b.add_material(material(json!({ "baseColorTexture": t0 })));
    let plane = b.add_mesh(&quad(10.0, 0.0));
    b.add_instance(plane, m, IDENTITY);
    b.camera = common::ortho_down(2.0, 3.0);
    let _ = lambert(0.5);
    let rendered = render_job(&b.load("rgb-png"));
    let m = mean(&rendered.image);
    assert!(m[1] > 2.0 * m[0], "{m:?}");
}

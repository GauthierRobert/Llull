//! V2 determinism (same seed → identical image hash, whatever the thread count), adaptive stop and time stop, and instancing
//! (two instances of one mesh render as two copies of it).

mod common;

use common::{icosphere, lambert, material, mean, perspective, quad, rgb, SceneBuilder, IDENTITY};
use llull_pathtrace::{render_job, run, write_outputs};
use serde_json::json;

fn scene(name: &str) -> SceneBuilder {
    let mut b = SceneBuilder::new(48, 40, 32);
    b.camera = perspective([0.0, -6.0, 2.0], [0.0, 0.9486833, -0.3162278], [0.0, 0.3162278, 0.9486833], 0.7);
    b.environment = json!({ "type": "sky", "turbidity": 2.5, "intensity": 1.0, "sunDirection": [0.3, -0.4, 0.8660254] });
    b.lights.push(json!({ "type": "sun", "direction": [0.3, -0.4, 0.8660254], "irradiance": [3.0, 2.9, 2.7], "angularRadius": 0.01, "castShadows": true }));
    b.lights
        .push(json!({ "type": "point", "position": [2.0, -1.0, 2.0], "power": [20.0, 20.0, 20.0], "radius": 0.1, "castShadows": true }));
    let floor = b.add_material(lambert(0.5));
    let glass = b.add_material(material(json!({ "transmission": 1.0, "roughness": 0.1, "ior": 1.5 })));
    let metal = b.add_material(material(json!({ "metalness": 1.0, "roughness": 0.3, "baseColor": [0.9, 0.7, 0.4], "coat": 1.0 })));
    let plane = b.add_mesh(&quad(20.0, -1.0));
    let sphere = b.add_mesh(&icosphere(1.0, 2));
    b.add_instance(plane, floor, IDENTITY);
    b.add_instance(sphere, glass, [1.0, 0.0, 0.0, -1.2, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0]);
    b.add_instance(sphere, metal, [0.8, 0.0, 0.0, 1.2, 0.0, 0.8, 0.0, 0.5, 0.0, 0.0, 0.8, -0.2]);
    let _ = name;
    b
}

fn image_hash(folder: &std::path::Path) -> String {
    let mut sink = Vec::new();
    let outputs = run(folder, &mut sink).unwrap();
    outputs.iter().find(|o| o.path == "image.png").unwrap().sha256.clone()
}

#[test]
fn same_seed_same_hash_on_any_thread_count() {
    let folder = scene("det").write("determinism");
    let first = image_hash(&folder);
    assert_eq!(first, image_hash(&folder));
    let job = llull_pathtrace::load::load(&folder).unwrap();
    let in_pool = |threads: usize| {
        let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).build().unwrap();
        let rendered = pool.install(|| render_job(&job));
        let outputs = write_outputs(&folder, &job, &rendered).unwrap();
        (outputs.iter().find(|o| o.path == "beauty.exr").unwrap().sha256.clone(), rendered.stats.deterministic)
    };
    let (one, deterministic) = in_pool(1);
    assert!(deterministic);
    assert_eq!(one, in_pool(4).0);
    assert_eq!(one, in_pool(3).0);
    let mut other = scene("det");
    other.set("seed", json!(2));
    assert_ne!(first, image_hash(&other.write("determinism-seed2")));
}

#[test]
fn target_noise_stops_early_and_deterministically() {
    let mut b = scene("noise");
    b.set("samples", json!(4096)).set("targetNoise", json!(0.2));
    let job = b.load("noise");
    let a = render_job(&job);
    assert_eq!(a.stats.stopped_by, "noise");
    assert!(a.stats.samples < 4096.0 && a.stats.samples >= 16.0, "{}", a.stats.samples);
    assert!(a.stats.deterministic);
    let b2 = render_job(&job);
    assert_eq!(a.image.beauty, b2.image.beauty);
}

#[test]
fn max_seconds_stops_by_time_and_is_not_deterministic() {
    let mut b = scene("time");
    b.set("samples", json!(65536)).set("maxSeconds", json!(0.3));
    let rendered = render_job(&b.load("time"));
    assert_eq!(rendered.stats.stopped_by, "time");
    assert!(!rendered.stats.deterministic);
    assert!(rendered.stats.elapsed_ms < 5000.0, "{}", rendered.stats.elapsed_ms);
    assert!(rendered.warnings.iter().any(|w| w.code == "PATHTRACE_TIME_LIMIT"));
    // Every 16 x 16 tile got at least one sample: no black tile.
    let image = &rendered.image;
    for ty in 0..image.height.div_ceil(16) {
        for tx in 0..image.width.div_ceil(16) {
            let mut sum = 0.0f32;
            for y in ty * 16..(ty * 16 + 16).min(image.height) {
                for x in tx * 16..(tx * 16 + 16).min(image.width) {
                    sum += rgb(image, (y * image.width + x) as usize)[1];
                }
            }
            assert!(sum > 0.0, "tile {tx}, {ty} is black");
        }
    }
    assert!(rendered.stats.samples >= 1.0);
}

#[test]
fn two_instances_render_as_two_copies() {
    let shift = [1.0, 0.0, 0.0, 2.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    let build = |copies: bool| {
        let mut b = SceneBuilder::new(48, 32, 64);
        b.camera = perspective([1.0, -6.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], 0.7);
        b.lights.push(json!({ "type": "sun", "direction": [0.0, -0.6, 0.8], "irradiance": [3.0, 3.0, 3.0], "angularRadius": 0.0, "castShadows": true }));
        let m = b.add_material(lambert(0.7));
        let ball = icosphere(0.8, 2);
        let a = b.add_mesh(&ball);
        b.add_instance(a, m, IDENTITY);
        if copies {
            let mut moved = icosphere(0.8, 2);
            moved.positions.iter_mut().for_each(|p| p[0] += 2.0);
            let c = b.add_mesh(&moved);
            b.add_instance(c, m, IDENTITY);
        } else {
            b.add_instance(a, m, shift);
        }
        render_job(&b.load(if copies { "copies" } else { "instances" }))
    };
    let (instanced, copied) = (build(false), build(true));
    assert_eq!(instanced.stats.instances, 2);
    assert_eq!(instanced.stats.triangles * 2, copied.stats.triangles);
    let n = instanced.image.beauty.len();
    let mut diff = 0.0f64;
    for i in 0..n {
        let (a, b) = (rgb(&instanced.image, i), rgb(&copied.image, i));
        diff += f64::from((a[0] - b[0]).abs() + (a[1] - b[1]).abs() + (a[2] - b[2]).abs());
    }
    let level = mean(&copied.image)[0];
    assert!(diff / (3.0 * n as f64) <= 0.002 * level, "mean abs difference {} vs level {level}", diff / (3.0 * n as f64));
}

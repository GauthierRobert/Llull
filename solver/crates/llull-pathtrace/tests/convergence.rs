//! V2 convergence: RMS error against a high-sample reference falls as n^-1/2 (log-log slope -0.5 ± 0.05) at 16, 64, 256 and 1024
//! samples. The reference is 16 384 samples (two independent 8192-sample halves with other seeds; RV1 §7 names 65 536, too slow for a
//! unit test): its own noise variance, a quarter of the halves' mean squared difference, is subtracted from each measured error².

mod common;

use common::{icosphere, lambert, material, perspective, quad, SceneBuilder, IDENTITY};
use llull_pathtrace::render::Image;
use llull_pathtrace::render_job;
use serde_json::json;

fn scene(samples: u32, seed: u32) -> Image {
    let mut b = SceneBuilder::new(32, 32, samples);
    b.camera = perspective([0.0, -4.0, 1.5], [0.0, 0.9363292, -0.3511234], [0.0, 0.3511234, 0.9363292], 0.8);
    b.environment = json!({ "type": "sky", "turbidity": 3.0, "intensity": 1.0, "sunDirection": [0.5, -0.3, 0.812404] });
    b.lights.push(json!({ "type": "sun", "direction": [0.5, -0.3, 0.812404], "irradiance": [3.0, 3.0, 3.0], "angularRadius": 0.1, "castShadows": true }));
    b.set("seed", json!(seed)).set("maxBounces", json!(6));
    let floor = b.add_material(lambert(0.5));
    let ball = b.add_material(material(json!({ "baseColor": [0.8, 0.3, 0.2], "roughness": 0.7 })));
    let plane = b.add_mesh(&quad(20.0, -1.0));
    let sphere = b.add_mesh(&icosphere(1.0, 2));
    b.add_instance(plane, floor, IDENTITY);
    b.add_instance(sphere, ball, IDENTITY);
    render_job(&b.load(&format!("convergence-{samples}-{seed}"))).image
}

fn luminance(image: &Image) -> Vec<f64> {
    image
        .beauty
        .iter()
        .map(|p| 0.2126 * f64::from(p[0].to_f32()) + 0.7152 * f64::from(p[1].to_f32()) + 0.0722 * f64::from(p[2].to_f32()))
        .collect()
}

fn mean_square(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(x, y)| (x - y) * (x - y)).sum::<f64>() / a.len() as f64
}

#[test]
fn rms_error_falls_as_one_over_root_n() {
    let half_a = luminance(&scene(8192, 1001));
    let half_b = luminance(&scene(8192, 2002));
    let reference: Vec<f64> = half_a.iter().zip(&half_b).map(|(a, b)| 0.5 * (a + b)).collect();
    let reference_variance = mean_square(&half_a, &half_b) / 4.0;
    let counts = [16u32, 64, 256, 1024];
    let mut points = Vec::new();
    for n in counts {
        let estimate = luminance(&scene(n, 7));
        let error2 = mean_square(&estimate, &reference) - reference_variance;
        assert!(error2 > 0.0, "n = {n}: error below the reference noise");
        points.push(((f64::from(n)).ln(), 0.5 * error2.ln()));
    }
    let k = points.len() as f64;
    let (sx, sy) = (points.iter().map(|p| p.0).sum::<f64>(), points.iter().map(|p| p.1).sum::<f64>());
    let sxx = points.iter().map(|p| p.0 * p.0).sum::<f64>();
    let sxy = points.iter().map(|p| p.0 * p.1).sum::<f64>();
    let slope = (k * sxy - sx * sy) / (k * sxx - sx * sx);
    let rms: Vec<f64> = points.iter().map(|p| p.1.exp()).collect();
    eprintln!("convergence slope {slope}, rms {rms:?}");
    assert!((slope + 0.5).abs() <= 0.05, "slope {slope}, rms {rms:?}");
}

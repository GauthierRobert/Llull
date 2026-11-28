//! Emissive triangles as lights (next-event estimation + MIS): a small emitter is much less noisy at equal samples than with
//! hit-only emission, both estimate the same image, and over the emitter cap the render falls back to hit-only with a warning.

mod common;

use common::{flat, lambert, material, quad, small_emitter_over_plane, SceneBuilder, IDENTITY};
use llull_pathtrace::emitters::{Emitters, MAX_EMITTERS};
use llull_pathtrace::render::Image;
use llull_pathtrace::render_job;
use serde_json::json;

fn render(samples: u32, seed: u32, nee: bool) -> Image {
    let mut job = small_emitter_over_plane(samples, seed).load(&format!("small-emitter-{samples}-{seed}-{nee}"));
    assert_eq!(job.world.emitters.rows.len(), 2);
    if !nee {
        job.world.emitters = Emitters::default();
    }
    render_job(&job).image
}

fn channels(image: &Image) -> Vec<f64> {
    image.beauty.iter().flat_map(|p| p.map(|c| f64::from(c.to_f32()))).collect()
}

fn mean_square(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(x, y)| (x - y) * (x - y)).sum::<f64>() / a.len() as f64
}

fn mean(v: &[f64]) -> f64 {
    v.iter().sum::<f64>() / v.len() as f64
}

#[test]
fn light_sampling_a_small_emitter_cuts_the_error_at_equal_samples() {
    let half_a = channels(&render(2048, 11, true));
    let half_b = channels(&render(2048, 22, true));
    let reference: Vec<f64> = half_a.iter().zip(&half_b).map(|(a, b)| 0.5 * (a + b)).collect();
    let reference_variance = mean_square(&half_a, &half_b) / 4.0;
    let rmse = |image: &[f64]| (mean_square(image, &reference) - reference_variance).max(0.0).sqrt();
    let (nee, hit_only) = (channels(&render(16, 3, true)), channels(&render(16, 3, false)));
    let (nee_rmse, hit_rmse) = (rmse(&nee), rmse(&hit_only));
    let hit_only_mean = mean(&channels(&render(1024, 5, false)));
    eprintln!(
        "16 spp rmse: NEE {nee_rmse:.4}, hit-only {hit_rmse:.4} (ratio {:.3}); means: reference {:.4}, hit-only 1024 spp {hit_only_mean:.4}",
        nee_rmse / hit_rmse,
        mean(&reference)
    );
    assert!(nee_rmse < 0.1 * hit_rmse, "NEE {nee_rmse} hit-only {hit_rmse}");
    assert!((hit_only_mean / mean(&reference) - 1.0).abs() < 0.03, "hit-only {hit_only_mean} reference {}", mean(&reference));
}

#[test]
fn over_the_emitter_cap_emission_is_hit_only_with_a_warning() {
    // 1001 instances of a 1000-triangle emissive strip: 1,001,000 emissive triangles, over the cap.
    let per_mesh = 1000usize;
    let strip: Vec<[[f32; 3]; 3]> =
        (0..per_mesh).map(|i| [[i as f32, 0.0, 1.0], [i as f32 + 1.0, 0.0, 1.0], [i as f32, 1.0, 1.0]]).collect();
    let instances = (MAX_EMITTERS as usize).div_ceil(per_mesh) + 1;
    let mut b = SceneBuilder::new(4, 4, 1);
    let lamp = b.add_material(material(json!({ "emission": [1.0, 1.0, 1.0] })));
    let floor = b.add_material(lambert(0.5));
    let mesh = b.add_mesh(&flat(&strip));
    let plane = b.add_mesh(&quad(10.0, 0.0));
    b.add_instance(plane, floor, IDENTITY);
    for i in 0..instances {
        b.add_instance(mesh, lamp, [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 2.0 * i as f64, 0.0, 0.0, 1.0, 0.0]);
    }
    let job = b.load("emitter-cap");
    assert!(job.world.emitters.rows.is_empty() && job.world.emitters.first.is_empty());
    assert_eq!(job.world.emitters.over_cap, Some((instances * per_mesh) as u64));
    let rendered = render_job(&job);
    let warning = rendered.warnings.iter().find(|w| w.code == "PATHTRACE_EMITTER_LIMIT").expect("emitter limit warning");
    assert!(warning.message.contains("1001000 emissive triangles"), "{}", warning.message);
    assert!(rendered.stats.deterministic);
}

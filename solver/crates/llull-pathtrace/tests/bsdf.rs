//! V1 BSDF checks over sampled parameters and directions: reciprocity of reflection, energy (Monte-Carlo albedo <= 1), the sampled pdf
//! equals the evaluated pdf, and BSDF sampling estimates the same albedo as uniform-sphere sampling (the sampling density is right).

use llull_pathtrace::bsdf::{Bsdf, Params};
use llull_pathtrace::math::{v3, Vec3, PI};
use llull_pathtrace::rng::Sampler;

fn params(s: &mut Sampler) -> Params {
    Params {
        base_color: v3(s.uniform(), s.uniform(), s.uniform()),
        metalness: if s.uniform() < 0.3 { 1.0 } else { s.uniform() },
        roughness: 0.05 + 0.95 * s.uniform(),
        transmission: if s.uniform() < 0.5 { 0.0 } else { s.uniform() },
        ior: 1.0 + 1.5 * s.uniform(),
        coat: if s.uniform() < 0.5 { 0.0 } else { s.uniform() },
        coat_roughness: 0.05 + 0.95 * s.uniform(),
    }
}

fn upper(s: &mut Sampler) -> Vec3 {
    let z = 0.02 + 0.98 * s.uniform();
    let phi = 2.0 * PI * s.uniform();
    let r = (1.0 - z * z).sqrt();
    v3(r * phi.cos(), r * phi.sin(), z)
}

#[test]
fn reflection_is_reciprocal() {
    let mut s = Sampler::new(11, 0, 0);
    for _ in 0..2000 {
        let bsdf = Bsdf::new(params(&mut s));
        let (a, b) = (upper(&mut s), upper(&mut s));
        let (fab, _) = bsdf.eval_local(a, b);
        let (fba, _) = bsdf.eval_local(b, a);
        for k in 0..3 {
            assert!((fab[k] - fba[k]).abs() <= 1e-4 * fab[k].abs().max(1e-3), "{fab:?} vs {fba:?}");
        }
    }
}

#[test]
fn sampled_pdf_equals_evaluated_pdf() {
    let mut s = Sampler::new(12, 0, 0);
    let mut checked = 0;
    for _ in 0..4000 {
        let bsdf = Bsdf::new(params(&mut s));
        let wo = upper(&mut s);
        let Some(sample) = bsdf.sample_local(wo, s.uniform(), s.uniform(), s.uniform()) else { continue };
        let (f, pdf) = bsdf.eval_local(wo, sample.wi);
        assert!((pdf - sample.pdf).abs() <= 1e-5 * pdf.max(1.0), "{pdf} vs {}", sample.pdf);
        assert!((f - sample.f).length() <= 1e-5 * f.length().max(1.0));
        checked += 1;
    }
    assert!(checked > 3000);
}

/// Albedo at `wo` by BSDF sampling and by uniform-sphere sampling (both include transmission).
fn albedos(bsdf: &Bsdf, wo: Vec3, s: &mut Sampler, n: usize) -> (f64, f64) {
    let (mut by_bsdf, mut by_sphere) = (0.0f64, 0.0f64);
    for _ in 0..n {
        if let Some(sample) = bsdf.sample_local(wo, s.uniform(), s.uniform(), s.uniform()) {
            by_bsdf += f64::from(sample.f.max_component() * sample.wi.z.abs() / sample.pdf);
        }
        let z = 1.0 - 2.0 * s.uniform();
        let phi = 2.0 * PI * s.uniform();
        let r = (1.0 - z * z).max(0.0).sqrt();
        let wi = v3(r * phi.cos(), r * phi.sin(), z);
        let (f, _) = bsdf.eval_local(wo, wi);
        by_sphere += f64::from(f.max_component() * z.abs()) * 4.0 * std::f64::consts::PI;
    }
    (by_bsdf / n as f64, by_sphere / n as f64)
}

#[test]
fn albedo_never_exceeds_one_and_sampling_matches_the_density() {
    let mut s = Sampler::new(13, 0, 0);
    for case in 0..60 {
        let mut p = params(&mut s);
        // Uniform-sphere sampling of a sharp lobe is too noisy to compare: keep alpha >= 0.25.
        p.roughness = p.roughness.max(0.5);
        p.coat_roughness = p.coat_roughness.max(0.5);
        let bsdf = Bsdf::new(p);
        let wo = upper(&mut s);
        let (by_bsdf, by_sphere) = albedos(&bsdf, wo, &mut s, 200_000);
        assert!(by_bsdf <= 1.0 + 0.01, "case {case}: albedo {by_bsdf} for {p:?} at {wo:?}");
        assert!((by_bsdf - by_sphere).abs() <= 0.03 * by_bsdf.max(0.05) + 0.005, "case {case}: {by_bsdf} vs {by_sphere} for {p:?}");
    }
}

#[test]
fn a_white_lambert_reflects_everything_and_a_white_metal_matches_the_single_scatter_quadrature() {
    let mut s = Sampler::new(14, 0, 0);
    let lambert = Bsdf::new(Params {
        base_color: Vec3::ONE,
        metalness: 0.0,
        roughness: 1.0,
        transmission: 0.0,
        ior: 1.0,
        coat: 0.0,
        coat_roughness: 0.0,
    });
    let (a, _) = albedos(&lambert, v3(0.6, 0.0, 0.8), &mut s, 50_000);
    assert!((a - 1.0).abs() < 1e-5, "{a}");
    let metal = Bsdf::new(Params {
        base_color: Vec3::ONE,
        metalness: 1.0,
        roughness: 0.8,
        transmission: 0.0,
        ior: 1.5,
        coat: 0.0,
        coat_roughness: 0.0,
    });
    let (m, _) = albedos(&metal, v3(0.6, 0.0, 0.8), &mut s, 200_000);
    // Single-scatter GGX albedo at alpha 0.64, cos 0.8 by 400 x 800 midpoint quadrature of D G2 / (4 cos cos) cos: 0.56989.
    assert!((m - 0.56989).abs() < 0.005, "{m}");
}

#[test]
fn no_parameter_set_gains_energy_at_any_roughness() {
    let mut s = Sampler::new(15, 0, 0);
    for case in 0..200 {
        let p = params(&mut s);
        let bsdf = Bsdf::new(p);
        let wo = upper(&mut s);
        let n = 20_000;
        let mut sum = 0.0f64;
        for _ in 0..n {
            if let Some(sample) = bsdf.sample_local(wo, s.uniform(), s.uniform(), s.uniform()) {
                sum += f64::from(sample.f.max_component() * sample.wi.z.abs() / sample.pdf);
            }
        }
        assert!(sum / f64::from(n) <= 1.01, "case {case}: albedo {} for {p:?} at {wo:?}", sum / f64::from(n));
    }
}

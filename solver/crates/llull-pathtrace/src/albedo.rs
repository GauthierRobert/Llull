//! Directional albedo of the GGX specular lobe with Schlick Fresnel, tabulated once (deterministic quadrature, no randomness).
//!
//! With Schlick `F = f0 + (f90 − f0)(1 − wo·h)⁵` the albedo is linear in (f0, f90):
//! `E(μ, r) = f0 · E₁(μ, r) + (f90 − f0) · E₅(μ, r)`, where `E₁` integrates the single-scattering GGX lobe and `E₅` the same weighted
//! by `(1 − wo·h)⁵`; `Ē(r) = 2∫ E μ dμ` is its cosine-weighted average. The diffuse layer under a dielectric specular lobe (and the base
//! under a coat) is weighted by `(1 − E(μi))(1 − E(μo)) / (1 − Ē)`: reciprocal, and its albedo is exactly `ρ (1 − E(μo))`, so a white
//! base keeps the energy the specular lobe does not reflect, at every roughness (Kelemen / Szirmay-Kalos layering). Schlick's `F` in
//! its place under-weights the diffuse layer of rough surfaces, whose specular lobe reflects much less than `F` (found against Cycles,
//! RV1 V3: rough dielectric scenes 9-16 % dark).

use crate::math::v3;
use crate::microfacet::{alpha_of, g1, g2, reflect, sample_visible};
use std::sync::OnceLock;

/// Grid points along roughness (0..1) and along μ = cos θo (0..1).
pub const N: usize = 32;
/// Stratified visible-normal samples per table entry (per axis).
const STRATA: usize = 64;

#[derive(Debug)]
pub struct AlbedoTables {
    /// `E₁`, `E₅` at [roughness index * N + μ index].
    pub e1: Vec<f32>,
    pub e5: Vec<f32>,
    /// `Ē₁`, `Ē₅` per roughness index.
    pub avg1: Vec<f32>,
    pub avg5: Vec<f32>,
}

/// μ of grid point `i` (μ = 0 is replaced by a grazing 1e-3 so the lobe stays defined).
fn mu_at(i: usize) -> f32 {
    (i as f32 / (N - 1) as f32).max(1e-3)
}

fn entry(mu: f32, alpha: f32) -> (f32, f32) {
    let wo = v3((1.0 - mu * mu).max(0.0).sqrt(), 0.0, mu);
    let g1o = g1(wo, alpha);
    let (mut e1, mut e5) = (0.0f64, 0.0f64);
    for a in 0..STRATA {
        for b in 0..STRATA {
            let u1 = (a as f32 + 0.5) / STRATA as f32;
            let u2 = (b as f32 + 0.5) / STRATA as f32;
            let h = sample_visible(wo, alpha, u1, u2);
            let wi = reflect(wo, h);
            if wi.z <= 0.0 {
                continue;
            }
            // visible-normal sampling: the estimator of ∫ D G2 / (4 μo μi) μi dωi is G2 / G1(wo)
            let w = f64::from(g2(wo, wi, alpha) / g1o);
            let m = f64::from((1.0 - wo.dot(h)).clamp(0.0, 1.0));
            e1 += w;
            e5 += w * m * m * m * m * m;
        }
    }
    let n = (STRATA * STRATA) as f64;
    ((e1 / n) as f32, (e5 / n) as f32)
}

fn build() -> AlbedoTables {
    let mut t = AlbedoTables { e1: vec![0.0; N * N], e5: vec![0.0; N * N], avg1: vec![0.0; N], avg5: vec![0.0; N] };
    for r in 0..N {
        let alpha = alpha_of(r as f32 / (N - 1) as f32);
        for m in 0..N {
            let (e1, e5) = entry(mu_at(m), alpha);
            t.e1[r * N + m] = e1;
            t.e5[r * N + m] = e5;
        }
        // Ē = 2 ∫₀¹ E(μ) μ dμ by the trapezoid rule on the grid
        let (mut s1, mut s5) = (0.0f64, 0.0f64);
        for m in 0..N - 1 {
            let (x0, x1) = (f64::from(m as f32 / (N - 1) as f32), f64::from((m + 1) as f32 / (N - 1) as f32));
            let f = |table: &[f32], k: usize, x: f64| f64::from(table[r * N + k]) * x;
            s1 += (f(&t.e1, m, x0) + f(&t.e1, m + 1, x1)) * (x1 - x0);
            s5 += (f(&t.e5, m, x0) + f(&t.e5, m + 1, x1)) * (x1 - x0);
        }
        t.avg1[r] = s1 as f32;
        t.avg5[r] = s5 as f32;
    }
    t
}

/// The process tables (built on first use).
pub fn tables() -> &'static AlbedoTables {
    static TABLES: OnceLock<AlbedoTables> = OnceLock::new();
    TABLES.get_or_init(build)
}

/// Grid coordinate of `x` in 0..1: lower index and weight of the upper one.
fn cell(x: f32) -> (usize, f32) {
    let s = x.clamp(0.0, 1.0) * (N - 1) as f32;
    let i = (s.floor() as usize).min(N - 2);
    (i, s - i as f32)
}

fn f90_of(f0: f32) -> f32 {
    (50.0 * f0).min(1.0)
}

/// `E(μ)` of a GGX lobe of `roughness` with Schlick `f0` (bilinear in roughness and μ).
pub fn specular_albedo(f0: f32, roughness: f32, mu: f32) -> f32 {
    let t = tables();
    let (r, fr) = cell(roughness);
    let (m, fm) = cell(mu.abs());
    let at = |table: &[f32]| {
        let row = |k: usize| table[k * N + m] * (1.0 - fm) + table[k * N + m + 1] * fm;
        row(r) * (1.0 - fr) + row(r + 1) * fr
    };
    (f0 * at(&t.e1) + (f90_of(f0) - f0) * at(&t.e5)).clamp(0.0, 1.0)
}

/// `Ē` of a GGX lobe of `roughness` with Schlick `f0`.
pub fn specular_albedo_average(f0: f32, roughness: f32) -> f32 {
    let t = tables();
    let (r, fr) = cell(roughness);
    let lerp = |table: &[f32]| table[r] * (1.0 - fr) + table[r + 1] * fr;
    (f0 * lerp(&t.avg1) + (f90_of(f0) - f0) * lerp(&t.avg5)).clamp(0.0, 0.999)
}

/// The tables flattened for the GPU: `e1`, `e5` (N x N each), `avg1`, `avg5` (N each).
pub fn flattened() -> Vec<f32> {
    let t = tables();
    [&t.e1[..], &t.e5[..], &t.avg1[..], &t.avg5[..]].concat()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::microfacet::schlick;

    #[test]
    fn a_smooth_lobe_reflects_schlick_and_a_rough_one_less() {
        // roughness 0 (alpha 1e-3) is a mirror: E = F(μ)
        for mu in [0.2f32, 0.5, 1.0] {
            assert!((specular_albedo(0.04, 0.0, mu) - schlick(0.04, mu)).abs() < 2e-3, "mu {mu}");
        }
        // a rough lobe loses single-scattering energy: E₁ < 1 at roughness 1
        assert!(specular_albedo(1.0, 1.0, 0.5) < 0.9);
        assert!(specular_albedo(1.0, 0.0, 0.5) > 0.99);
        // Ē of a mirror with Schlick is the exact average f0 + (f90 − f0)/21
        assert!((specular_albedo_average(0.04, 0.0) - (0.04 + 0.96 / 21.0)).abs() < 3e-3);
    }

    #[test]
    fn tables_are_deterministic_and_bounded() {
        let a = flattened();
        assert_eq!(a, flattened());
        assert_eq!(a.len(), 2 * N * N + 2 * N);
        assert!(a.iter().all(|v| v.is_finite() && *v >= 0.0 && *v <= 1.001));
    }
}

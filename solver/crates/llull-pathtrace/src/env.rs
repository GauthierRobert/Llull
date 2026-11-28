//! The environment: uniform radiance (`color`, `default`) or an equirectangular map (`hdr`, and `sky` baked to a map by `sky`).
//!
//! Map lookup (RV1 §5b): a world direction is turned by −rotation about +Z to (x, y, z); u = 0.5 + atan2(−y, x) / 2π,
//! v = 0.5 + asin(z) / π, image row 0 at v = 1. Importance sampling inverts a piecewise-constant 2D distribution over the texels
//! (weight = texel luminance × cos(elevation), the sin θ of the polar form), so pdf(ω) = pdf(u, v) / (2π² cos(elevation)).
//! A uniform environment is not light-sampled: a cosine / BSDF sample already has the ideal density for it.

use crate::math::{v3, Vec3, PI};
use crate::texture::Texture;
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct EnvMap {
    pub(crate) texture: Arc<Texture>,
    pub(crate) intensity: f32,
    pub(crate) cos_rot: f32,
    pub(crate) sin_rot: f32,
    /// Row CDF (height + 1 entries) and per-row column CDFs (width + 1 entries each), both normalised.
    pub(crate) marginal: Vec<f32>,
    pub(crate) conditional: Vec<f32>,
    pub(crate) row_weights: Vec<f32>,
}

#[derive(Debug, Clone)]
pub enum Environment {
    Uniform(Vec3),
    Map(EnvMap),
}

/// Index of the CDF bucket holding `u` (cdf[i] <= u < cdf[i + 1]).
fn find(cdf: &[f32], u: f32) -> usize {
    let n = cdf.len() - 1;
    cdf.partition_point(|value| *value <= u).saturating_sub(1).min(n - 1)
}

fn normalised_cdf(weights: &[f64]) -> (Vec<f32>, f64) {
    let total: f64 = weights.iter().sum();
    let mut cdf = Vec::with_capacity(weights.len() + 1);
    let mut acc = 0.0f64;
    cdf.push(0.0);
    for w in weights {
        acc += w;
        cdf.push(if total > 0.0 { (acc / total) as f32 } else { 0.0 });
    }
    if let Some(last) = cdf.last_mut() {
        *last = 1.0;
    }
    (cdf, total)
}

impl EnvMap {
    /// `None` when the map carries no light at all.
    pub fn new(texture: Arc<Texture>, rotation: f32, intensity: f32) -> Option<EnvMap> {
        let (w, h) = (texture.width as usize, texture.height as usize);
        let mut conditional = Vec::with_capacity((w + 1) * h);
        let mut row_totals = Vec::with_capacity(h);
        let mut row_weights = Vec::with_capacity(h);
        for row in 0..h {
            let elevation = (0.5 - (row as f64 + 0.5) / h as f64) * std::f64::consts::PI;
            let weights: Vec<f64> =
                (0..w).map(|col| f64::from(texture.texel(col as u32, row as u32).luminance()) * elevation.cos()).collect();
            let (cdf, total) = normalised_cdf(&weights);
            conditional.extend(cdf);
            row_totals.push(total);
            row_weights.push(total as f32);
        }
        let (marginal, total) = normalised_cdf(&row_totals);
        if total <= 0.0 || intensity <= 0.0 {
            return None;
        }
        let row_weights = row_weights.iter().map(|r| (f64::from(*r) / total) as f32).collect();
        Some(EnvMap { texture, intensity, cos_rot: rotation.cos(), sin_rot: rotation.sin(), marginal, conditional, row_weights })
    }

    fn to_uv(&self, d: Vec3) -> (f32, f32, f32) {
        let x = self.cos_rot * d.x + self.sin_rot * d.y;
        let y = -self.sin_rot * d.x + self.cos_rot * d.y;
        let z = d.z.clamp(-1.0, 1.0);
        let u = 0.5 + (-y).atan2(x) / (2.0 * PI);
        let v = 0.5 + z.asin() / PI;
        (u, v, (1.0 - z * z).max(0.0).sqrt())
    }

    fn direction_of(&self, u: f32, v: f32) -> (Vec3, f32) {
        let elevation = (v - 0.5) * PI;
        let azimuth = (u - 0.5) * 2.0 * PI;
        let cos_e = elevation.cos();
        let (x, y, z) = (cos_e * azimuth.cos(), -cos_e * azimuth.sin(), elevation.sin());
        let world = v3(self.cos_rot * x - self.sin_rot * y, self.sin_rot * x + self.cos_rot * y, z);
        (world, cos_e)
    }

    pub fn radiance(&self, d: Vec3) -> Vec3 {
        let (u, v, _) = self.to_uv(d);
        self.texture.sample(u, v, true) * self.intensity
    }

    fn texel_pdf(&self, u: f32, v: f32) -> f32 {
        let (w, h) = (self.texture.width as usize, self.texture.height as usize);
        let col = ((u.rem_euclid(1.0) * w as f32) as usize).min(w - 1);
        let row = (((1.0 - v) * h as f32) as usize).min(h - 1);
        let cdf = &self.conditional[row * (w + 1)..(row + 1) * (w + 1)];
        self.row_weights[row] * (cdf[col + 1] - cdf[col]) * (w * h) as f32
    }

    pub fn pdf(&self, d: Vec3) -> f32 {
        let (u, v, cos_e) = self.to_uv(d);
        if cos_e <= 0.0 {
            return 0.0;
        }
        self.texel_pdf(u, v) / (2.0 * PI * PI * cos_e)
    }

    /// (direction, radiance, solid-angle pdf).
    pub fn sample(&self, u1: f32, u2: f32) -> Option<(Vec3, Vec3, f32)> {
        let (w, h) = (self.texture.width as usize, self.texture.height as usize);
        let row = find(&self.marginal, u1);
        let row_span = self.marginal[row + 1] - self.marginal[row];
        let fy = if row_span > 0.0 { ((u1 - self.marginal[row]) / row_span).clamp(0.0, 0.999_999) } else { 0.5 };
        let cdf = &self.conditional[row * (w + 1)..(row + 1) * (w + 1)];
        let col = find(cdf, u2);
        let col_span = cdf[col + 1] - cdf[col];
        let fx = if col_span > 0.0 { ((u2 - cdf[col]) / col_span).clamp(0.0, 0.999_999) } else { 0.5 };
        let u = (col as f32 + fx) / w as f32;
        let v = 1.0 - (row as f32 + fy) / h as f32;
        let (direction, cos_e) = self.direction_of(u, v);
        if cos_e <= 0.0 {
            return None;
        }
        // The lookup pdf of the returned direction (equal to the sampled density up to rounding), so NEE and BSDF hits agree exactly.
        let pdf = self.pdf(direction);
        (pdf > 0.0).then(|| (direction, self.radiance(direction), pdf))
    }
}

impl Environment {
    pub fn radiance(&self, d: Vec3) -> Vec3 {
        match self {
            Environment::Uniform(value) => *value,
            Environment::Map(map) => map.radiance(d),
        }
    }

    /// Light-sampling pdf of a direction (0: this environment is not light-sampled).
    pub fn pdf(&self, d: Vec3) -> f32 {
        match self {
            Environment::Uniform(_) => 0.0,
            Environment::Map(map) => map.pdf(d),
        }
    }

    pub fn sample(&self, u1: f32, u2: f32) -> Option<(Vec3, Vec3, f32)> {
        match self {
            Environment::Uniform(_) => None,
            Environment::Map(map) => map.sample(u1, u2),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::texture::Pixels;

    fn map(width: u32, height: u32, f: impl Fn(u32, u32) -> f32) -> EnvMap {
        let mut texels = Vec::new();
        for y in 0..height {
            for x in 0..width {
                texels.push(Vec3::splat(f(x, y)));
            }
        }
        let texture = Texture { width, height, pixels: Pixels::Hdr(texels), srgb: false };
        EnvMap::new(Arc::new(texture), 0.7, 2.0).unwrap()
    }

    #[test]
    fn sampled_pdf_matches_lookup_pdf_and_integrates_to_one() {
        let env = map(16, 8, |x, y| 0.1 + (x * 3 + y * 7 % 5) as f32);
        let mut estimate = 0.0f64;
        let n = 20_000;
        let mut sampler = crate::rng::Sampler::new(1, 0, 0);
        for _ in 0..n {
            let (d, _, pdf) = env.sample(sampler.uniform(), sampler.uniform()).unwrap();
            let lookup = env.pdf(d);
            assert!((pdf - lookup).abs() <= 1e-3 * pdf.max(1.0), "{pdf} vs {lookup}");
            // Uniform-sphere estimate of the pdf's integral.
            let z = 1.0 - 2.0 * sampler.uniform();
            let phi = 2.0 * PI * sampler.uniform();
            let r = (1.0 - z * z).sqrt();
            estimate += f64::from(env.pdf(v3(r * phi.cos(), r * phi.sin(), z))) * 4.0 * std::f64::consts::PI;
        }
        assert!((estimate / n as f64 - 1.0).abs() < 0.03, "{}", estimate / n as f64);
    }

    #[test]
    fn the_lookup_follows_the_contract_orientation() {
        // Texel (col 0, row 0) is u ~ 0, v ~ 1: straight up after the rotation, at azimuth atan2(-y, x) = -pi.
        let env = map(4, 2, |x, y| if y == 0 && x == 3 { 1.0 } else { 0.0 });
        let (d, _) = env.direction_of(0.875, 0.75);
        let (u, v, _) = env.to_uv(d);
        assert!((u - 0.875).abs() < 1e-5 && (v - 0.75).abs() < 1e-5);
        assert!(env.radiance(d).x > 1.0);
    }
}

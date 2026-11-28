//! Denoiser (`denoise: true`): an edge-avoiding à-trous wavelet filter (Dammertz et al. 2010) with the variance-guided luminance stop
//! of SVGF (Schied et al. 2017): 5 iterations of the 5 x 5 B3-spline kernel at steps 1, 2, 4, 8, 16 px on the albedo-demodulated
//! beauty, each tap weighted by
//! `exp(−|Δlum| / (σl √var + ε)) · max(0, n·n')^σn · exp(−|Δz| / (σz z |offset|)) · exp(−|Δalbedo|² / σa²)` using the first-hit
//! albedo, normal and depth guides and the per-pixel variance of the mean (3 x 3 Gaussian-smoothed for the stop, filtered alongside,
//! `var' = Σw²var / (Σw)²`).
//! Pure per-pixel arithmetic in a fixed order: deterministic. A learned denoiser (OpenImageDenoise) is not bundled in this build;
//! this filter is the documented substitute (RV1 RV-M3 "a bundled open model": follow-up).

use crate::math::{v3, Vec3};
use crate::render::{to_half, Guides, Image};
use rayon::prelude::*;

const KERNEL: [f32; 5] = [1.0 / 16.0, 1.0 / 4.0, 3.0 / 8.0, 1.0 / 4.0, 1.0 / 16.0];
const ITERATIONS: u32 = 5;
const SIGMA_LUMINANCE: f32 = 4.0;
const SIGMA_NORMAL: i32 = 64;
const SIGMA_DEPTH: f32 = 0.02;
const SIGMA_ALBEDO: f32 = 0.1;
const ALBEDO_FLOOR: f32 = 0.01;

struct Guide {
    albedo: Vec3,
    normal: Vec3,
    depth: f32,
}

fn load_guides(g: &Guides) -> Vec<Guide> {
    g.albedo
        .iter()
        .zip(g.normal.iter())
        .zip(g.depth.iter())
        .map(|((a, n), d)| {
            let normal = v3(n[0].to_f32(), n[1].to_f32(), n[2].to_f32());
            let normal = if normal.length() > 0.25 { normal.normalized() } else { Vec3::ZERO };
            Guide { albedo: v3(a[0].to_f32(), a[1].to_f32(), a[2].to_f32()), normal, depth: *d }
        })
        .collect()
}

fn demodulator(albedo: Vec3) -> Vec3 {
    albedo.max(Vec3::splat(ALBEDO_FLOOR))
}

fn normal_weight(a: Vec3, b: Vec3) -> f32 {
    match (a.length() > 0.5, b.length() > 0.5) {
        (false, false) => 1.0,
        (true, true) => a.dot(b).max(0.0).powi(SIGMA_NORMAL),
        _ => 0.0,
    }
}

fn depth_weight(a: f32, b: f32, offset: f32) -> f32 {
    match (a.is_finite(), b.is_finite()) {
        (false, false) => 1.0,
        (true, true) => (-(a - b).abs() / (SIGMA_DEPTH * a.max(b).max(1e-6) * offset)).exp(),
        _ => 0.0,
    }
}

/// 3 x 3 Gaussian of the variance (SVGF): the luminance stop of a pass uses this smoother estimate.
fn blur_variance(width: usize, height: usize, variance: &[f32]) -> Vec<f32> {
    const K: [f32; 3] = [0.25, 0.5, 0.25];
    let mut out = vec![0.0f32; variance.len()];
    out.par_chunks_mut(width).enumerate().for_each(|(y, row)| {
        for (x, value) in row.iter_mut().enumerate() {
            let (mut sum, mut weight) = (0.0f32, 0.0f32);
            for (j, ky) in K.iter().enumerate() {
                for (i, kx) in K.iter().enumerate() {
                    let (qx, qy) = (x as i64 + i as i64 - 1, y as i64 + j as i64 - 1);
                    if qx >= 0 && qy >= 0 && (qx as usize) < width && (qy as usize) < height {
                        sum += kx * ky * variance[qy as usize * width + qx as usize];
                        weight += kx * ky;
                    }
                }
            }
            *value = sum / weight;
        }
    });
    out
}

/// One à-trous pass at `step`; returns the filtered illumination and variance.
fn pass(width: usize, height: usize, guides: &[Guide], colour: &[Vec3], variance: &[f32], step: usize) -> (Vec<Vec3>, Vec<f32>) {
    let smooth = blur_variance(width, height, variance);
    let mut out_colour = vec![Vec3::ZERO; colour.len()];
    let mut out_variance = vec![0.0f32; variance.len()];
    out_colour.par_chunks_mut(width).zip(out_variance.par_chunks_mut(width)).enumerate().for_each(|(y, (row_c, row_v))| {
        for x in 0..width {
            let p = y * width + x;
            let (cp, gp) = (colour[p], &guides[p]);
            let lp = cp.luminance();
            let sigma = SIGMA_LUMINANCE * smooth[p].max(0.0).sqrt() + 1e-4;
            let (mut sum_c, mut sum_w, mut sum_v) = (Vec3::ZERO, 0.0f32, 0.0f32);
            for (j, ky) in KERNEL.iter().enumerate() {
                let qy = y as i64 + (j as i64 - 2) * step as i64;
                if qy < 0 || qy >= height as i64 {
                    continue;
                }
                for (i, kx) in KERNEL.iter().enumerate() {
                    let qx = x as i64 + (i as i64 - 2) * step as i64;
                    if qx < 0 || qx >= width as i64 {
                        continue;
                    }
                    let q = qy as usize * width + qx as usize;
                    let (cq, gq) = (colour[q], &guides[q]);
                    let offset = (((i as f32 - 2.0).powi(2) + (j as f32 - 2.0).powi(2)).sqrt() * step as f32).max(1.0);
                    let da = gp.albedo - gq.albedo;
                    let w = kx
                        * ky
                        * (-(lp - cq.luminance()).abs() / sigma).exp()
                        * normal_weight(gp.normal, gq.normal)
                        * depth_weight(gp.depth, gq.depth, offset)
                        * (-da.dot(da) / (SIGMA_ALBEDO * SIGMA_ALBEDO)).exp();
                    sum_c += cq * w;
                    sum_w += w;
                    sum_v += w * w * variance[q];
                }
            }
            row_c[x] = if sum_w > 0.0 { sum_c / sum_w } else { cp };
            row_v[x] = if sum_w > 0.0 { sum_v / (sum_w * sum_w) } else { variance[p] };
        }
    });
    (out_colour, out_variance)
}

/// Filters the image's beauty in place (needs its guides).
pub fn denoise(image: &mut Image) {
    let Some(g) = image.guides.take() else { return };
    let (width, height) = (image.width as usize, image.height as usize);
    let guides = load_guides(&g);
    let mut colour: Vec<Vec3> = image
        .beauty
        .iter()
        .zip(guides.iter())
        .map(|(b, guide)| {
            let d = demodulator(guide.albedo);
            v3(b[0].to_f32() / d.x, b[1].to_f32() / d.y, b[2].to_f32() / d.z)
        })
        .collect();
    let mut variance: Vec<f32> = g
        .variance
        .iter()
        .zip(guides.iter())
        .map(|(v, guide)| {
            let l = demodulator(guide.albedo).luminance();
            v / (l * l)
        })
        .collect();
    drop(g);
    for iteration in 0..ITERATIONS {
        let (c, v) = pass(width, height, &guides, &colour, &variance, 1 << iteration);
        colour = c;
        variance = v;
    }
    for ((b, c), guide) in image.beauty.iter_mut().zip(colour.iter()).zip(guides.iter()) {
        let lit = c.times(demodulator(guide.albedo));
        *b = [to_half(lit.x), to_half(lit.y), to_half(lit.z)];
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use half::f16;

    fn image(width: u32, height: u32, value: impl Fn(u32, u32) -> f32) -> Image {
        let n = (width * height) as usize;
        let mut beauty = Vec::with_capacity(n);
        for y in 0..height {
            for x in 0..width {
                beauty.push([to_half(value(x, y)); 3]);
            }
        }
        let guides = Guides {
            albedo: vec![[f16::ONE; 3]; n],
            normal: vec![[f16::ZERO, f16::ZERO, f16::ONE]; n],
            depth: vec![1.0; n],
            variance: vec![0.01; n],
        };
        Image { width, height, beauty, guides: Some(guides) }
    }

    #[test]
    fn noise_drops_and_a_flat_image_stays_flat() {
        let noisy = |x: u32, y: u32| 0.5 + if (x * 7 + y * 13).is_multiple_of(3) { 0.1 } else { -0.05 };
        let mut img = image(48, 48, noisy);
        let before: f32 = img.beauty.iter().map(|p| (p[0].to_f32() - 0.5).abs()).sum();
        denoise(&mut img);
        let after: f32 = img.beauty.iter().map(|p| (p[0].to_f32() - 0.5).abs()).sum();
        assert!(after < 0.5 * before, "{before} -> {after}");
        let mut flat = image(16, 16, |_, _| 0.25);
        denoise(&mut flat);
        assert!(flat.beauty.iter().all(|p| (p[1].to_f32() - 0.25).abs() < 1e-3));
    }
}

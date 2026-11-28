//! GGX (Trowbridge-Reitz) microfacet pieces in the local shading frame (+Z = normal): distribution, Smith height-correlated masking,
//! visible-normal sampling (Heitz 2018), Schlick and exact dielectric Fresnel, refraction (pbrt-v4 conventions).

use crate::math::{v3, Vec3, PI};

/// Smallest GGX alpha (roughness 0.0316): keeps every lobe a finite density, so mirrors are very sharp GGX rather than deltas.
pub const MIN_ALPHA: f32 = 1e-3;

pub fn alpha_of(roughness: f32) -> f32 {
    (roughness * roughness).max(MIN_ALPHA)
}

pub fn d(h: Vec3, alpha: f32) -> f32 {
    let a2 = alpha * alpha;
    let c2 = h.z * h.z;
    let denom = c2 * (a2 - 1.0) + 1.0;
    a2 / (PI * denom * denom)
}

pub fn lambda(w: Vec3, alpha: f32) -> f32 {
    let c2 = w.z * w.z;
    if c2 <= 0.0 {
        return f32::INFINITY;
    }
    let tan2 = ((1.0 - c2) / c2).max(0.0);
    0.5 * ((1.0 + alpha * alpha * tan2).sqrt() - 1.0)
}

pub fn g1(w: Vec3, alpha: f32) -> f32 {
    1.0 / (1.0 + lambda(w, alpha))
}

/// Smith height-correlated masking-shadowing.
pub fn g2(wo: Vec3, wi: Vec3, alpha: f32) -> f32 {
    1.0 / (1.0 + lambda(wo, alpha) + lambda(wi, alpha))
}

/// Density of visible normal `h` seen from `wo` (either hemisphere; `h` in the upper one).
pub fn visible_pdf(wo: Vec3, h: Vec3, alpha: f32) -> f32 {
    let cos_o = wo.z.abs();
    if cos_o <= 0.0 {
        return 0.0;
    }
    g1(wo, alpha) / cos_o * d(h, alpha) * wo.dot(h).abs()
}

/// Samples a visible normal (upper hemisphere) for `wo`, mirrored to the upper hemisphere first.
pub fn sample_visible(wo: Vec3, alpha: f32, u1: f32, u2: f32) -> Vec3 {
    let wo = if wo.z < 0.0 { -wo } else { wo };
    let vh = v3(alpha * wo.x, alpha * wo.y, wo.z).normalized();
    let lensq = vh.x * vh.x + vh.y * vh.y;
    let t1 = if lensq > 0.0 { v3(-vh.y, vh.x, 0.0) * (1.0 / lensq.sqrt()) } else { v3(1.0, 0.0, 0.0) };
    let t2 = vh.cross(t1);
    let r = u1.sqrt();
    let phi = 2.0 * PI * u2;
    let p1 = r * phi.cos();
    let mut p2 = r * phi.sin();
    let s = 0.5 * (1.0 + vh.z);
    p2 = (1.0 - s) * (1.0 - p1 * p1).max(0.0).sqrt() + s * p2;
    let nh = t1 * p1 + t2 * p2 + vh * (1.0 - p1 * p1 - p2 * p2).max(0.0).sqrt();
    v3(alpha * nh.x, alpha * nh.y, nh.z.max(1e-7)).normalized()
}

/// Schlick Fresnel with the specular occlusion edge `f90 = min(1, 50 f0)` (a zero `f0` reflects nothing, also at grazing angles).
pub fn schlick(f0: f32, cos: f32) -> f32 {
    let f90 = (50.0 * f0).min(1.0);
    let m = (1.0 - cos.clamp(0.0, 1.0)).max(0.0);
    let m2 = m * m;
    f0 + (f90 - f0) * m2 * m2 * m
}

pub fn schlick_rgb(f0: Vec3, cos: f32) -> Vec3 {
    let f90 = (50.0 * f0.max_component()).min(1.0);
    let m = (1.0 - cos.clamp(0.0, 1.0)).max(0.0);
    let m2 = m * m;
    let k = m2 * m2 * m;
    f0 + (Vec3::splat(f90) - f0) * k
}

pub fn f0_of_ior(ior: f32) -> f32 {
    let r = (ior - 1.0) / (ior + 1.0);
    r * r
}

/// Unpolarised dielectric Fresnel reflectance; `cos_i` signed (negative = from inside), `eta` = inside / outside index.
pub fn fresnel_dielectric(cos_i: f32, eta: f32) -> f32 {
    let (cos_i, eta) = if cos_i < 0.0 { (-cos_i, 1.0 / eta) } else { (cos_i, eta) };
    let sin2_t = (1.0 - cos_i * cos_i).max(0.0) / (eta * eta);
    if sin2_t >= 1.0 {
        return 1.0;
    }
    let cos_t = (1.0 - sin2_t).max(0.0).sqrt();
    let parallel = (eta * cos_i - cos_t) / (eta * cos_i + cos_t);
    let perpendicular = (cos_i - eta * cos_t) / (cos_i + eta * cos_t);
    0.5 * (parallel * parallel + perpendicular * perpendicular)
}

pub fn reflect(wo: Vec3, h: Vec3) -> Vec3 {
    h * (2.0 * wo.dot(h)) - wo
}

/// Refracts `wi` through the microfacet `n`; returns the transmitted direction and the relative index it crossed (pbrt `Refract`).
pub fn refract(wi: Vec3, n: Vec3, eta: f32) -> Option<(Vec3, f32)> {
    let mut cos_i = n.dot(wi);
    let (mut eta, mut n) = (eta, n);
    if cos_i < 0.0 {
        eta = 1.0 / eta;
        cos_i = -cos_i;
        n = -n;
    }
    let sin2_i = (1.0 - cos_i * cos_i).max(0.0);
    let sin2_t = sin2_i / (eta * eta);
    if sin2_t >= 1.0 {
        return None;
    }
    let cos_t = (1.0 - sin2_t).sqrt();
    Some((-wi / eta + n * (cos_i / eta - cos_t), eta))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distribution_projects_to_one() {
        for alpha in [0.05f32, 0.3, 0.8] {
            let n = 20_000;
            let step = std::f64::consts::FRAC_PI_2 / n as f64;
            let mut sum = 0.0f64;
            for i in 0..n {
                let theta = (i as f64 + 0.5) * step;
                let (sin, cos) = theta.sin_cos();
                sum += f64::from(d(v3(sin as f32, 0.0, cos as f32), alpha)) * cos * sin * 2.0 * std::f64::consts::PI * step;
            }
            assert!((sum - 1.0).abs() < 0.01, "alpha {alpha}: {sum}");
        }
    }

    #[test]
    fn fresnel_limits() {
        assert!((fresnel_dielectric(1.0, 1.5) - 0.04).abs() < 1e-6);
        assert_eq!(fresnel_dielectric(-0.2, 1.5), 1.0);
        assert_eq!(schlick(0.0, 0.0), 0.0);
        assert!((schlick(0.04, 0.0) - 1.0).abs() < 1e-6);
    }
}

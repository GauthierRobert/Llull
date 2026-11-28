//! The material BSDF (glTF metal-roughness style) in a local shading frame:
//!
//! `f = coat · Fc(wo·hc) · GGX(αc) + (1 − coat·Ec(|cos i|)) (1 − coat·Ec(|cos o|)) / (1 − coat·Ēc) · base` with the clear coat a GGX dielectric of
//! index 1.5 (`Fc` Schlick, f0 0.04), and
//! `base = (1 − m)(1 − t) [(1 − E(cos i))(1 − E(cos o)) / (1 − Ē) ρ/π + F(wo·h) GGX(α)] + m · Fschlick(ρ, wo·h) GGX(α) + (1 − m) t · ρ_refr · roughDielectric(ior, α)`,
//! `m` metalness, `t` transmission, `ρ` base colour, `α = roughness²`, `F` Schlick with f0 from `ior` (0.04 at 1.5); `GGX(α)` is
//! `D G2 / (4 |cos i| |cos o|)` with the Smith height-correlated `G2`. The rough dielectric (Walter et al. 2007, pbrt-v4 form, exact
//! Fresnel, radiance transport) reflects and refracts; which side of the surface is the inside is decided by the geometric normal.
//! `E` / `Ē` are the directional / average albedo of the GGX specular lobe (`albedo.rs`, tabulated): the diffuse weight is reciprocal and
//! its albedo is exactly `ρ (1 − E(cos o))`, so a white base keeps all the energy the specular lobe does not reflect at any roughness
//! (Schlick's F in its place lost ~9 % per bounce and darkened rough dielectrics; found against Cycles, RV1 V3). The coat likewise.
//! `ρ_refr = √ρ` per refraction, so a ray entering and leaving a closed body is tinted by ρ (Cycles' Principled BSDF); reflection is not. The opaque lobes are two-sided (they mirror to the side `wo` is on). Every term is symmetric in (wi, wo) for reflection.
//!
//! Sampling picks one lobe in proportion to an estimate of its albedo at `wo`; the returned pdf is always the full mixture pdf, the
//! same value `eval` returns, so MIS weights are consistent.

use crate::albedo::{specular_albedo, specular_albedo_average};
use crate::math::{v3, Frame, Vec3, INV_PI, PI};
use crate::microfacet::{
    alpha_of, d, f0_of_ior, fresnel_dielectric, g2, reflect, refract, sample_visible, schlick, schlick_rgb, visible_pdf,
};

/// Clear coat Fresnel f0: a dielectric of index 1.5.
const COAT_F0: f32 = 0.04;

/// Material values at one surface point (textures already applied).
#[derive(Debug, Clone, Copy)]
pub struct Params {
    pub base_color: Vec3,
    pub metalness: f32,
    pub roughness: f32,
    pub transmission: f32,
    pub ior: f32,
    pub coat: f32,
    pub coat_roughness: f32,
}

#[derive(Debug, Clone, Copy)]
pub struct Bsdf {
    p: Params,
    alpha: f32,
    coat_alpha: f32,
    f0: f32,
    /// Ē of the specular lobe and of the coat lobe.
    spec_average: f32,
    coat_average: f32,
}

#[derive(Debug, Clone, Copy)]
pub struct Sample {
    pub wi: Vec3,
    pub f: Vec3,
    pub pdf: f32,
}

/// Lobe selection weights at `wo` (unnormalised): specular, diffuse, transmission, coat.
#[derive(Debug, Clone, Copy)]
struct Weights {
    spec: f32,
    diffuse: f32,
    trans: f32,
    coat: f32,
}

impl Weights {
    fn total(&self) -> f32 {
        self.spec + self.diffuse + self.trans + self.coat
    }
}

fn same_side(a: Vec3, b: Vec3) -> bool {
    a.z * b.z > 0.0
}

fn cosine_hemisphere(u1: f32, u2: f32) -> Vec3 {
    let r = u1.sqrt();
    let phi = 2.0 * PI * u2;
    v3(r * phi.cos(), r * phi.sin(), (1.0 - u1).max(0.0).sqrt())
}

impl Bsdf {
    pub fn new(p: Params) -> Bsdf {
        let f0 = f0_of_ior(p.ior);
        Bsdf {
            p,
            alpha: alpha_of(p.roughness),
            coat_alpha: alpha_of(p.coat_roughness),
            f0,
            spec_average: specular_albedo_average(f0, p.roughness),
            coat_average: specular_albedo_average(COAT_F0, p.coat_roughness),
        }
    }

    /// Share of light the coat lets through at `cos`: 1 − coat · E_coat(|cos|) (its lobe's directional albedo, not just F).
    fn coat_transmittance(&self, cos: f32) -> f32 {
        1.0 - self.p.coat * specular_albedo(COAT_F0, self.p.coat_roughness, cos.abs())
    }

    fn coat_fresnel(&self, cos: f32) -> f32 {
        self.p.coat * schlick(COAT_F0, cos.abs())
    }

    fn weights(&self, wo: Vec3) -> Weights {
        let c = wo.z.abs();
        let coat = self.coat_fresnel(c);
        let base = 1.0 - coat;
        let (m, t) = (self.p.metalness, self.p.transmission);
        let fd = schlick(self.f0, c);
        let fm = schlick_rgb(self.p.base_color, c).luminance();
        Weights {
            spec: base * ((1.0 - m) * (1.0 - t) * fd + m * fm),
            diffuse: base * (1.0 - m) * (1.0 - t) * (1.0 - fd) * self.p.base_color.luminance(),
            trans: base * (1.0 - m) * t,
            coat,
        }
    }

    /// BSDF value and mixture pdf for local directions (no cosine).
    pub fn eval_local(&self, wo: Vec3, wi: Vec3) -> (Vec3, f32) {
        if wo.z == 0.0 || wi.z == 0.0 {
            return (Vec3::ZERO, 0.0);
        }
        let w = self.weights(wo);
        let total = w.total();
        if total <= 0.0 {
            return (Vec3::ZERO, 0.0);
        }
        let attenuation = self.coat_transmittance(wi.z) * self.coat_transmittance(wo.z) / (1.0 - self.p.coat * self.coat_average);
        let (m, t) = (self.p.metalness, self.p.transmission);
        let (trans_f, trans_pdf) = if t > 0.0 && m < 1.0 { self.dielectric(wo, wi) } else { (0.0, 0.0) };
        // refraction is tinted by √ρ per interface, so a ray through a closed body is tinted by ρ (as Cycles' Principled BSDF); reflection is not
        let tint = if same_side(wo, wi) {
            Vec3::ONE
        } else {
            v3(self.p.base_color.x.sqrt(), self.p.base_color.y.sqrt(), self.p.base_color.z.sqrt())
        };
        let mut f = tint * (trans_f * (1.0 - m) * t * attenuation);
        let mut pdf = w.trans * trans_pdf;
        if same_side(wo, wi) {
            let (o, i) = if wo.z < 0.0 { (-wo, -wi) } else { (wo, wi) };
            let h = (o + i).normalized();
            let oh = o.dot(h).max(0.0);
            let micro = d(h, self.alpha) * g2(o, i, self.alpha) / (4.0 * o.z * i.z);
            let fd = schlick(self.f0, oh);
            let spec = Vec3::splat((1.0 - m) * (1.0 - t) * fd) + schlick_rgb(self.p.base_color, oh) * m;
            let diffuse_fresnel = (1.0 - specular_albedo(self.f0, self.p.roughness, o.z))
                * (1.0 - specular_albedo(self.f0, self.p.roughness, i.z))
                / (1.0 - self.spec_average);
            let diffuse = self.p.base_color * ((1.0 - m) * (1.0 - t) * diffuse_fresnel * INV_PI);
            f += (spec * micro + diffuse) * attenuation;
            let coat_micro = d(h, self.coat_alpha) * g2(o, i, self.coat_alpha) / (4.0 * o.z * i.z);
            f += Vec3::splat(self.coat_fresnel(oh) * coat_micro);
            let jacobian = 1.0 / (4.0 * oh.max(1e-12));
            pdf += w.spec * visible_pdf(o, h, self.alpha) * jacobian
                + w.diffuse * i.z * INV_PI
                + w.coat * visible_pdf(o, h, self.coat_alpha) * jacobian;
        }
        (f, pdf / total)
    }

    /// Rough dielectric value (radiance transport) and its own pdf.
    fn dielectric(&self, wo: Vec3, wi: Vec3) -> (f32, f32) {
        let eta = self.p.ior;
        let reflect_side = same_side(wo, wi);
        let etap = if reflect_side {
            1.0
        } else if wo.z > 0.0 {
            eta
        } else {
            1.0 / eta
        };
        let wm = wi * etap + wo;
        if wm.dot(wm) == 0.0 {
            return (0.0, 0.0);
        }
        let mut wm = wm.normalized();
        if wm.z < 0.0 {
            wm = -wm;
        }
        if wm.dot(wi) * wi.z < 0.0 || wm.dot(wo) * wo.z < 0.0 {
            return (0.0, 0.0);
        }
        let fresnel = fresnel_dielectric(wo.dot(wm), eta);
        let dm = d(wm, self.alpha);
        let g = g2(wo, wi, self.alpha);
        let visible = visible_pdf(wo, wm, self.alpha);
        if reflect_side {
            let f = dm * g * fresnel / (4.0 * wi.z * wo.z).abs();
            let pdf = visible / (4.0 * wo.dot(wm).abs()) * fresnel;
            return (f, pdf);
        }
        let denom = wi.dot(wm) + wo.dot(wm) / etap;
        let denom2 = denom * denom;
        let f = dm * g * (1.0 - fresnel) * (wi.dot(wm) * wo.dot(wm) / (wi.z * wo.z * denom2)).abs() / (etap * etap);
        let pdf = visible * wi.dot(wm).abs() / denom2 * (1.0 - fresnel);
        (f, pdf)
    }

    /// Samples a local direction for `wo`: `u` picks the lobe, (`u1`, `u2`) the direction.
    pub fn sample_local(&self, wo: Vec3, u: f32, u1: f32, u2: f32) -> Option<Sample> {
        if wo.z == 0.0 {
            return None;
        }
        let w = self.weights(wo);
        let total = w.total();
        if total <= 0.0 {
            return None;
        }
        let pick = u * total;
        let flip = |v: Vec3| if wo.z < 0.0 { -v } else { v };
        let up = flip(wo);
        let (spec_end, diffuse_end, trans_end) = (w.spec, w.spec + w.diffuse, w.spec + w.diffuse + w.trans);
        let wi = if pick < spec_end {
            flip(reflect(up, sample_visible(up, self.alpha, u1, u2)))
        } else if pick < diffuse_end {
            flip(cosine_hemisphere(u1, u2))
        } else if pick < trans_end {
            self.sample_dielectric(wo, ((pick - diffuse_end) / w.trans).min(0.999_999), u1, u2)?
        } else {
            flip(reflect(up, sample_visible(up, self.coat_alpha, u1, u2)))
        };
        let (f, pdf) = self.eval_local(wo, wi);
        (pdf > 0.0 && !f.is_black()).then_some(Sample { wi, f, pdf })
    }

    fn sample_dielectric(&self, wo: Vec3, u: f32, u1: f32, u2: f32) -> Option<Vec3> {
        let wm = sample_visible(wo, self.alpha, u1, u2);
        let fresnel = fresnel_dielectric(wo.dot(wm), self.p.ior);
        if u < fresnel {
            let wi = reflect(wo, wm);
            return same_side(wo, wi).then_some(wi);
        }
        let (wi, _) = refract(wo, wm, self.p.ior)?;
        (!same_side(wo, wi) && wi.z != 0.0).then_some(wi)
    }
}

/// A BSDF placed on a surface: shading frame plus the geometric normal that decides sides.
#[derive(Debug, Clone, Copy)]
pub struct SurfaceBsdf {
    pub frame: Frame,
    pub ng: Vec3,
    pub bsdf: Bsdf,
}

impl SurfaceBsdf {
    /// Rejects directions whose shading-frame side disagrees with their geometric side (no light leaks through shading normals).
    fn consistent(&self, w_world: Vec3, w_local: Vec3) -> bool {
        w_world.dot(self.ng) * w_local.z > 0.0
    }

    pub fn eval(&self, wo: Vec3, wi: Vec3) -> (Vec3, f32) {
        let (o, i) = (self.frame.to_local(wo), self.frame.to_local(wi));
        if !self.consistent(wo, o) || !self.consistent(wi, i) {
            return (Vec3::ZERO, 0.0);
        }
        self.bsdf.eval_local(o, i)
    }

    pub fn sample(&self, wo: Vec3, u: f32, u1: f32, u2: f32) -> Option<Sample> {
        let o = self.frame.to_local(wo);
        if !self.consistent(wo, o) {
            return None;
        }
        let s = self.bsdf.sample_local(o, u, u1, u2)?;
        let wi = self.frame.to_world(s.wi);
        self.consistent(wi, s.wi).then_some(Sample { wi, ..s })
    }

    /// |cos| of a world direction against the shading normal.
    pub fn cos(&self, w: Vec3) -> f32 {
        w.dot(self.frame.n).abs()
    }
}

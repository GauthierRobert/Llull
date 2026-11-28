//! Materials of a job (RV1 §5b): each channel a factor times an optional texture (glTF style; metalness, roughness, transmission and
//! coat read their map's first channel), resolved at a surface point into BSDF parameters, emission and the shading normal (normal
//! map in the per-triangle tangent frame from the UVs).

use crate::bsdf::Params;
use crate::math::{Frame, Vec3};
use crate::scene::SurfacePoint;
use crate::texture::Texture;
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct Material {
    pub base_color: Vec3,
    pub base_color_texture: Option<u32>,
    pub metalness: f32,
    pub metalness_texture: Option<u32>,
    pub roughness: f32,
    pub roughness_texture: Option<u32>,
    pub normal_texture: Option<u32>,
    pub normal_scale: f32,
    pub emission: Vec3,
    pub emission_texture: Option<u32>,
    pub transmission: f32,
    pub transmission_texture: Option<u32>,
    pub ior: f32,
    pub coat: f32,
    pub coat_texture: Option<u32>,
    pub coat_roughness: f32,
}

/// A material evaluated at one point.
#[derive(Debug, Clone, Copy)]
pub struct Resolved {
    pub params: Params,
    pub emission: Vec3,
    pub ns: Vec3,
}

fn lookup(textures: &[Arc<Texture>], index: Option<u32>, uv: [f32; 2]) -> Option<Vec3> {
    index.and_then(|i| textures.get(i as usize)).map(|t| t.sample(uv[0], uv[1], false))
}

impl Material {
    /// Emitted radiance at `uv` (the emission factor times its texture), as `resolve` gives it.
    pub fn emission_at(&self, textures: &[Arc<Texture>], uv: [f32; 2]) -> Vec3 {
        lookup(textures, self.emission_texture, uv).map_or(self.emission, |v| v.times(self.emission))
    }

    pub fn resolve(&self, textures: &[Arc<Texture>], s: &SurfacePoint) -> Resolved {
        let uv = s.uv;
        let scalar = |factor: f32, index: Option<u32>| (factor * lookup(textures, index, uv).map_or(1.0, |v| v.x)).clamp(0.0, 1.0);
        let base_color = lookup(textures, self.base_color_texture, uv).map_or(self.base_color, |v| v.times(self.base_color));
        let emission = self.emission_at(textures, uv);
        let mut ns = s.ns;
        if let Some(n) = lookup(textures, self.normal_texture, uv) {
            ns = perturb(s, n, self.normal_scale);
        }
        Resolved {
            params: Params {
                base_color,
                metalness: scalar(self.metalness, self.metalness_texture),
                roughness: scalar(self.roughness, self.roughness_texture),
                transmission: scalar(self.transmission, self.transmission_texture),
                ior: self.ior,
                coat: scalar(self.coat, self.coat_texture),
                coat_roughness: self.coat_roughness,
            },
            emission,
            ns,
        }
    }
}

/// Tangent-space normal map texel (linear RGB in [0, 1]) to a world shading normal; xy scaled by `scale` (glTF `normalTexture.scale`).
fn perturb(s: &SurfacePoint, texel: Vec3, scale: f32) -> Vec3 {
    let n = s.ns;
    let t = s.tangent - n * n.dot(s.tangent);
    let (t, b) = if t.length() > 1e-12 {
        let t = t.normalized();
        let mut b = n.cross(t);
        if b.dot(s.bitangent) < 0.0 {
            b = -b;
        }
        (t, b)
    } else {
        let frame = Frame::from_normal(n);
        (frame.s, frame.t)
    };
    let local = Vec3 { x: (2.0 * texel.x - 1.0) * scale, y: (2.0 * texel.y - 1.0) * scale, z: 2.0 * texel.z - 1.0 };
    let perturbed = (t * local.x + b * local.y + n * local.z).normalized();
    if perturbed.is_finite() && perturbed.dot(n) > 0.0 {
        perturbed
    } else {
        n
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::v3;

    #[test]
    fn a_flat_normal_texel_keeps_the_normal_and_a_tilted_one_follows_the_tangent() {
        let s = SurfacePoint {
            p: Vec3::ZERO,
            ng: v3(0.0, 0.0, 1.0),
            ns: v3(0.0, 0.0, 1.0),
            uv: [0.0, 0.0],
            tangent: v3(2.0, 0.0, 0.0),
            bitangent: v3(0.0, 3.0, 0.0),
            material: 0,
        };
        assert!((perturb(&s, v3(0.5, 0.5, 1.0), 1.0) - v3(0.0, 0.0, 1.0)).length() < 1e-6);
        let tilted = perturb(&s, v3(1.0, 0.5, 0.5 + 0.5 * 0.5f32.sqrt()), 1.0);
        assert!(tilted.x > 0.5 && tilted.y.abs() < 1e-6, "{tilted:?}");
    }
}

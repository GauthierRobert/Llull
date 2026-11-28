//! Unidirectional path tracer: next-event estimation to every light and to the environment map at each vertex, BSDF sampling for the
//! continuation, multiple importance sampling (power heuristic) between the two for every non-delta light and the map. Russian roulette
//! after three bounces; `maxBounces` counts scattering events (0 = emitters and the environment only, 1 = direct light).
//! Emissive triangles are lights too (`emitters`): one is light-sampled per vertex, and a BSDF ray that hits one is weighted by MIS
//! against that sample. Over the emitter cap (or with none) surface emission is only added where a path hits it.

use crate::bsdf::{Bsdf, SurfaceBsdf};
use crate::camera::Camera;
use crate::emitters::Emitters;
use crate::env::Environment;
use crate::lights::{Light, Shape};
use crate::material::Material;
use crate::math::{offset_ray, Frame, Vec3};
use crate::rng::Sampler;
use crate::scene::{Geometry, Hit};
use crate::texture::Texture;
use std::sync::Arc;

/// Everything a path needs.
#[derive(Debug, Clone)]
pub struct World {
    pub geometry: Geometry,
    pub materials: Vec<Material>,
    pub textures: Vec<Arc<Texture>>,
    pub lights: Vec<Light>,
    pub emitters: Emitters,
    pub environment: Environment,
    pub camera: Camera,
}

/// First-hit guide values for the denoiser (miss: albedo 1, normal 0, depth +inf).
#[derive(Debug, Clone, Copy)]
pub struct FirstHit {
    pub albedo: Vec3,
    pub normal: Vec3,
    pub depth: f32,
}

fn power_heuristic(a: f32, b: f32) -> f32 {
    let (a2, b2) = (a * a, b * b);
    if a2 + b2 > 0.0 && (a2 + b2).is_finite() {
        a2 / (a2 + b2)
    } else if a.is_infinite() {
        1.0
    } else {
        0.0
    }
}

/// Radiance escaping along a BSDF ray after a previous vertex with BSDF pdf `bsdf_pdf` (MIS against the map and sun cones).
fn escaped(world: &World, direction: Vec3, bsdf_pdf: Option<f32>) -> Vec3 {
    let mut l = world.environment.radiance(direction);
    let Some(bsdf_pdf) = bsdf_pdf else { return l };
    l = l * power_heuristic(bsdf_pdf, world.environment.pdf(direction));
    for light in world.lights.iter().filter(|light| matches!(light.shape, Shape::Sun { .. })) {
        if let Some((_, radiance, pdf)) = light.intersect(Vec3::ZERO, direction, f32::INFINITY) {
            l += radiance * power_heuristic(bsdf_pdf, pdf);
        }
    }
    l
}

/// Nearest light surface (sphere, rectangle) hit before `t_max`.
fn light_hit(world: &World, origin: Vec3, direction: Vec3, t_max: f32) -> Option<(f32, Vec3, f32)> {
    let mut best: Option<(f32, Vec3, f32)> = None;
    for light in &world.lights {
        if let Some(hit) = light.intersect(origin, direction, best.map_or(t_max, |b| b.0)) {
            if hit.0.is_finite() {
                best = Some(hit);
            }
        }
    }
    best
}

/// One emissive-triangle sample (chosen by power, a point uniform on it), MIS-weighted against the BSDF. Draws its four numbers only
/// when the scene has emitters, so a scene without any keeps its random streams.
fn emitter_direct(world: &World, bsdf: &SurfaceBsdf, p: Vec3, wo: Vec3, sampler: &mut Sampler) -> Vec3 {
    let emitters = &world.emitters;
    if emitters.rows.is_empty() {
        return Vec3::ZERO;
    }
    let bin = sampler.index(emitters.rows.len() as u32);
    let u = sampler.uniform();
    let (u1, u2) = sampler.uniform2();
    let (e, instance, triangle) = emitters.pick(bin, u);
    let root = u1.sqrt();
    let light = world.geometry.surface(&Hit { t: 0.0, instance, triangle, u: root * (1.0 - u2), v: root * u2 });
    let to = light.p - p;
    let d2 = to.dot(to);
    let distance = d2.sqrt();
    if distance <= 0.0 || !distance.is_finite() {
        return Vec3::ZERO;
    }
    let wi = to / distance;
    let cos_light = wi.dot(light.ng).abs();
    let Some(material) = world.materials.get(light.material as usize) else { return Vec3::ZERO };
    let emission = material.emission_at(&world.textures, light.uv);
    if cos_light <= 0.0 || emission.is_black() {
        return Vec3::ZERO;
    }
    let pdf = emitters.rows[e].pdf_area * d2 / cos_light;
    if !(pdf > 0.0 && pdf.is_finite()) {
        return Vec3::ZERO;
    }
    let (f, bsdf_pdf) = bsdf.eval(wo, wi);
    if f.is_black() || shadowed(world, p, bsdf.ng, wi, distance) {
        return Vec3::ZERO;
    }
    f.times(emission) * (bsdf.cos(wi) * power_heuristic(pdf, bsdf_pdf) / pdf)
}

/// Emission met by a ray: MIS-weighted against the emitter sampler when a BSDF sample led here and the triangle is light-sampled.
fn hit_emission(world: &World, hit: &Hit, ng: Vec3, direction: Vec3, emission: Vec3, bsdf_pdf: Option<f32>) -> Vec3 {
    let (Some(bsdf_pdf), Some(pdf_area)) = (bsdf_pdf, world.emitters.pdf_area(hit.instance, hit.triangle)) else { return emission };
    if emission.is_black() {
        return emission;
    }
    let light_pdf = pdf_area * hit.t * hit.t / direction.dot(ng).abs();
    emission * power_heuristic(bsdf_pdf, light_pdf)
}

/// Direct light at a vertex: every light, one environment-map sample and one emissive-triangle sample.
fn direct(world: &World, bsdf: &SurfaceBsdf, p: Vec3, wo: Vec3, sampler: &mut Sampler) -> Vec3 {
    let mut l = Vec3::ZERO;
    for light in &world.lights {
        let (u1, u2) = sampler.uniform2();
        let Some(s) = light.sample(p, u1, u2) else { continue };
        if s.value.is_black() {
            continue;
        }
        let (f, bsdf_pdf) = bsdf.eval(wo, s.wi);
        if f.is_black() {
            continue;
        }
        let weight = match s.pdf {
            None => 1.0,
            Some(pdf) if light.cast_shadows => power_heuristic(pdf, bsdf_pdf) / pdf,
            Some(pdf) => 1.0 / pdf,
        };
        if light.cast_shadows && shadowed(world, p, bsdf.ng, s.wi, s.distance) {
            continue;
        }
        l += f.times(s.value) * (bsdf.cos(s.wi) * weight);
    }
    let (u1, u2) = sampler.uniform2();
    if let Some((wi, radiance, pdf)) = world.environment.sample(u1, u2) {
        let (f, bsdf_pdf) = bsdf.eval(wo, wi);
        if !f.is_black() && !shadowed(world, p, bsdf.ng, wi, f32::INFINITY) {
            l += f.times(radiance) * (bsdf.cos(wi) * power_heuristic(pdf, bsdf_pdf) / pdf);
        }
    }
    l + emitter_direct(world, bsdf, p, wo, sampler)
}

fn shadowed(world: &World, p: Vec3, ng: Vec3, wi: Vec3, distance: f32) -> bool {
    let origin = offset_ray(p, if wi.dot(ng) > 0.0 { ng } else { -ng });
    let t_max = if distance.is_finite() { distance * (1.0 - 1e-4) } else { f32::INFINITY };
    world.geometry.occluded(origin, wi, t_max)
}

/// One camera path: radiance arriving along (origin, direction) and the first-hit guides.
pub fn radiance(world: &World, mut origin: Vec3, mut direction: Vec3, sampler: &mut Sampler, max_bounces: u32) -> (Vec3, FirstHit) {
    let mut l = Vec3::ZERO;
    let mut beta = Vec3::ONE;
    let mut first = FirstHit { albedo: Vec3::ONE, normal: Vec3::ZERO, depth: f32::INFINITY };
    let mut bsdf_pdf: Option<f32> = None;
    let mut depth = 0u32;
    loop {
        let hit = world.geometry.intersect(origin, direction, f32::INFINITY);
        if bsdf_pdf.is_some() {
            if let Some((_, radiance, pdf)) = light_hit(world, origin, direction, hit.map_or(f32::INFINITY, |h| h.t)) {
                l += beta.times(radiance) * power_heuristic(bsdf_pdf.unwrap_or(0.0), pdf);
                break;
            }
        }
        let Some(hit) = hit else {
            l += beta.times(escaped(world, direction, bsdf_pdf));
            break;
        };
        let surface = world.geometry.surface(&hit);
        let Some(material) = world.materials.get(surface.material as usize) else { break };
        let resolved = material.resolve(&world.textures, &surface);
        let wo = -direction;
        let mut ns = resolved.ns;
        if wo.dot(ns) * wo.dot(surface.ng) <= 0.0 {
            ns = surface.ng;
        }
        if depth == 0 {
            first = FirstHit { albedo: resolved.params.base_color, normal: ns, depth: hit.t };
        }
        l += beta.times(hit_emission(world, &hit, surface.ng, direction, resolved.emission, bsdf_pdf));
        if depth >= max_bounces {
            break;
        }
        let bsdf = SurfaceBsdf { frame: Frame::from_normal(ns), ng: surface.ng, bsdf: Bsdf::new(resolved.params) };
        l += beta.times(direct(world, &bsdf, surface.p, wo, sampler));
        let u = sampler.uniform();
        let (u1, u2) = sampler.uniform2();
        let Some(sample) = bsdf.sample(wo, u, u1, u2) else { break };
        beta = beta.times(sample.f) * (bsdf.cos(sample.wi) / sample.pdf);
        if !beta.is_finite() || beta.is_black() {
            break;
        }
        bsdf_pdf = Some(sample.pdf);
        origin = offset_ray(surface.p, if sample.wi.dot(surface.ng) > 0.0 { surface.ng } else { -surface.ng });
        direction = sample.wi;
        depth += 1;
        if depth >= 3 {
            let survive = beta.max_component().min(0.95);
            if sampler.uniform() >= survive {
                break;
            }
            beta = beta / survive;
        }
    }
    (l, first)
}

/// Camera ray through pixel (x, y) for one sample.
pub fn camera_ray(camera: &Camera, x: u32, y: u32, sampler: &mut Sampler) -> (Vec3, Vec3) {
    let (a, b) = sampler.uniform2();
    let (c, d) = sampler.uniform2();
    camera.ray(x, y, [a, b, c, d])
}

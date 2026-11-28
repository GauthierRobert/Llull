//! Lights of the contract (RV1 §5b), sampled for next-event estimation and intersected by BSDF rays for MIS.
//!
//! - sun: irradiance E (W/m² at normal incidence) toward `direction`; angular radius α > 0 is a cone of uniform radiance
//!   E / (π sin²α), sampled uniformly over its solid angle, so the irradiance of a facing plane is exactly E; α = 0 is a delta light.
//! - point / spot: intensity P / 4π W/sr (a spot keeps the point normalisation and masks it with a smoothstep over the cone,
//!   `blend` the softened fraction of the half angle's cosine range, as Blender); falloff over distance in metres (`unitMetres`).
//!   Radius r > 0 is a sphere of radiance P / (4π² r²), sampled by the solid angle it subtends; r = 0 is a delta light.
//! - area: one-sided rectangle (centre, full edge vectors), radiance P / (π A) with A in m², sampled uniformly over its area.
//!
//! Lights are not seen by camera rays and do not block shadow rays. A light with `castShadows` false lights through geometry and is
//! not hit by BSDF rays (no MIS for it).

use crate::math::{Frame, Vec3, PI};

#[derive(Debug, Clone, Copy)]
pub struct Spot {
    pub direction: Vec3,
    pub cos_half: f32,
    pub blend: f32,
}

#[derive(Debug, Clone, Copy)]
pub enum Shape {
    Sun { direction: Vec3, frame: Frame, irradiance: Vec3, cos_max: f32, solid_angle: f32, radiance: Vec3 },
    Sphere { centre: Vec3, radius: f32, intensity: Vec3, radiance: Vec3, unit_metres: f32, spot: Option<Spot> },
    Rect { centre: Vec3, u: Vec3, v: Vec3, normal: Vec3, area: f32, radiance: Vec3 },
}

#[derive(Debug, Clone, Copy)]
pub struct Light {
    pub shape: Shape,
    pub cast_shadows: bool,
}

/// One light sample: direction, shadow distance, and `value` — radiance for an area-like sample (with its solid-angle `pdf`), or the
/// irradiance at normal incidence of a delta light (`pdf` None).
#[derive(Debug, Clone, Copy)]
pub struct LightSample {
    pub wi: Vec3,
    pub distance: f32,
    pub value: Vec3,
    pub pdf: Option<f32>,
}

/// Uniform direction in the cone of half angle acos(cos_max) around +Z of `frame`.
fn sample_cone(frame: &Frame, cos_max: f32, u1: f32, u2: f32) -> Vec3 {
    let cos = 1.0 - u1 * (1.0 - cos_max);
    let sin = (1.0 - cos * cos).max(0.0).sqrt();
    let phi = 2.0 * PI * u2;
    frame.to_world(crate::math::v3(sin * phi.cos(), sin * phi.sin(), cos))
}

fn spot_mask(spot: &Option<Spot>, from_light: Vec3) -> f32 {
    let Some(spot) = spot else { return 1.0 };
    let cos = from_light.dot(spot.direction);
    if cos <= spot.cos_half {
        return 0.0;
    }
    let width = (1.0 - spot.cos_half) * spot.blend;
    if width <= 0.0 {
        return 1.0;
    }
    let t = ((cos - spot.cos_half) / width).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// 1 − cos of the half angle a sphere of radius r subtends at distance d (> r), stable for small r / d.
fn one_minus_cos_max(radius: f32, distance: f32) -> f32 {
    let s2 = (radius / distance) * (radius / distance);
    s2 / (1.0 + (1.0 - s2).max(0.0).sqrt())
}

/// Nearest positive root of the ray-sphere quadratic.
fn sphere_hit(origin: Vec3, direction: Vec3, centre: Vec3, radius: f32) -> Option<f32> {
    let oc = origin - centre;
    let b = oc.dot(direction);
    let c = oc.dot(oc) - radius * radius;
    let disc = b * b - c;
    if disc < 0.0 {
        return None;
    }
    let root = disc.sqrt();
    let t = -b - root;
    if t > 0.0 {
        Some(t)
    } else {
        let t = -b + root;
        (t > 0.0).then_some(t)
    }
}

impl Light {
    /// Next-event sample from point `p`.
    pub fn sample(&self, p: Vec3, u1: f32, u2: f32) -> Option<LightSample> {
        match self.shape {
            Shape::Sun { direction, frame, irradiance, cos_max, solid_angle, radiance } => {
                if solid_angle <= 0.0 {
                    return Some(LightSample { wi: direction, distance: f32::INFINITY, value: irradiance, pdf: None });
                }
                let wi = sample_cone(&frame, cos_max, u1, u2);
                Some(LightSample { wi, distance: f32::INFINITY, value: radiance, pdf: Some(1.0 / solid_angle) })
            }
            Shape::Sphere { centre, radius, intensity, radiance, unit_metres, spot } => {
                let to_centre = centre - p;
                let distance = to_centre.length();
                if distance <= radius || distance <= 0.0 {
                    return None;
                }
                let axis = to_centre / distance;
                let mask = spot_mask(&spot, -axis);
                if mask <= 0.0 {
                    return None;
                }
                if radius <= 0.0 {
                    let metres = distance * unit_metres;
                    return Some(LightSample { wi: axis, distance, value: intensity * (mask / (metres * metres)), pdf: None });
                }
                let gap = one_minus_cos_max(radius, distance);
                let frame = Frame::from_normal(axis);
                let wi = sample_cone(&frame, 1.0 - gap, u1, u2);
                let t = sphere_hit(p, wi, centre, radius).unwrap_or(distance - radius);
                Some(LightSample { wi, distance: t, value: radiance * mask, pdf: Some(1.0 / (2.0 * PI * gap)) })
            }
            Shape::Rect { centre, u, v, normal, area, radiance } => {
                let q = centre + u * (u1 - 0.5) + v * (u2 - 0.5);
                let to = q - p;
                let d2 = to.dot(to);
                let distance = d2.sqrt();
                if distance <= 0.0 {
                    return None;
                }
                let wi = to / distance;
                let cos_light = -wi.dot(normal);
                if cos_light <= 0.0 {
                    return None;
                }
                Some(LightSample { wi, distance, value: radiance, pdf: Some(d2 / (area * cos_light)) })
            }
        }
    }

    /// BSDF-ray hit on this light within `t_max`: (distance, radiance, solid-angle pdf the light sampler would have given).
    pub fn intersect(&self, origin: Vec3, direction: Vec3, t_max: f32) -> Option<(f32, Vec3, f32)> {
        if !self.cast_shadows {
            return None;
        }
        match self.shape {
            Shape::Sun { direction: sun, cos_max, solid_angle, radiance, .. } => (solid_angle > 0.0
                && t_max.is_infinite()
                && direction.dot(sun) >= cos_max)
                .then_some((f32::INFINITY, radiance, 1.0 / solid_angle)),
            Shape::Sphere { centre, radius, radiance, spot, .. } => {
                if radius <= 0.0 {
                    return None;
                }
                let t = sphere_hit(origin, direction, centre, radius).filter(|t| *t < t_max)?;
                let distance = (centre - origin).length();
                if distance <= radius {
                    return None;
                }
                let mask = spot_mask(&spot, (origin - centre) / distance);
                Some((t, radiance * mask, 1.0 / (2.0 * PI * one_minus_cos_max(radius, distance))))
            }
            Shape::Rect { centre, u, v, normal, area, radiance } => {
                let denom = direction.dot(normal);
                if denom >= 0.0 {
                    return None;
                }
                let t = (centre - origin).dot(normal) / denom;
                if t <= 0.0 || t >= t_max {
                    return None;
                }
                let offset = origin + direction * t - centre;
                let (a, b) = (offset.dot(u) / u.dot(u), offset.dot(v) / v.dot(v));
                if a.abs() > 0.5 || b.abs() > 0.5 {
                    return None;
                }
                Some((t, radiance, t * t / (area * -denom)))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::v3;

    #[test]
    fn sampled_pdfs_match_the_hit_pdfs() {
        let rect = Light {
            shape: Shape::Rect {
                centre: v3(0.0, 0.0, 2.0),
                u: v3(1.0, 0.0, 0.0),
                v: v3(0.0, 0.5, 0.0),
                normal: v3(0.0, 0.0, -1.0),
                area: 0.5,
                radiance: Vec3::ONE,
            },
            cast_shadows: true,
        };
        let sphere = Light {
            shape: Shape::Sphere {
                centre: v3(1.0, 0.0, 3.0),
                radius: 0.3,
                intensity: Vec3::ONE,
                radiance: Vec3::ONE,
                unit_metres: 1.0,
                spot: None,
            },
            cast_shadows: true,
        };
        for light in [rect, sphere] {
            for (u1, u2) in [(0.1, 0.2), (0.7, 0.4), (0.95, 0.9)] {
                let s = light.sample(Vec3::ZERO, u1, u2).unwrap();
                let (t, _, pdf) = light.intersect(Vec3::ZERO, s.wi, f32::INFINITY).unwrap();
                assert!((t - s.distance).abs() < 1e-4 && (pdf - s.pdf.unwrap()).abs() < 1e-3 * pdf, "{t} {pdf} {s:?}");
            }
        }
    }

    #[test]
    fn spot_mask_is_hard_without_blend_and_zero_outside() {
        let spot = Some(Spot { direction: v3(0.0, 0.0, -1.0), cos_half: 0.5, blend: 0.0 });
        assert_eq!(spot_mask(&spot, v3(0.0, 0.0, -1.0)), 1.0);
        assert_eq!(spot_mask(&spot, v3(1.0, 0.0, 0.0)), 0.0);
    }
}
